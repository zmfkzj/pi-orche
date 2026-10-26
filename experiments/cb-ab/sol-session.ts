/**
 * Evaluator-session runner of the cb-ab study, round 2 (results/cb-ab/PROTOCOL-R2.md "Model rule"; used by the Part R scorers
 * (sol-score.ts) and the Part S case screeners (screen.ts)).
 *
 *   node --import tsx experiments/cb-ab/sol-session.ts run <spec.json>        one session from a JSON SessionSpec
 *   node --import tsx experiments/cb-ab/sol-session.ts smoke <outDir> --scratch <dir>   a tiny session (harness check)
 *
 * One session = ONE plain Pi session: the Pi CLI that run.ts uses, JSON mode, NO orche extension, only the CLIProxyAPI provider
 * (the frozen provider copy of results/cb-ab/study by default), `--model cliproxyapi/gpt-6.1-sol --thinking high`, settings with
 * defaultModel gpt-6.1-sol and defaultThinkingLevel high, no stored login, inside bubblewrap:
 *  - the home replaced by an empty tmpfs; read-only toolchain (~/.nvm, ~/.bun), provider, wrappers; a private agent dir, /tmp and PID
 *    namespace; explicit read-only, fresh-copy and empty writable mounts (SessionSpec.mounts), never this repository;
 *  - its OWN network namespace (`--unshare-net`): the only way out is a Unix socket to a host bridge in front of this session's logging
 *    proxy (experiments/mdsd-ab/proxy.mjs: model, effort, response model, usage and list price per request), reached in the sandbox
 *    at http://127.0.0.1:<SANDBOX_PROXY_PORT>. The upstream CLIProxyAPI and every other address are unreachable from inside.
 *  - a process guard (default 60 min) on the whole sandbox process group.
 * Evidence per attempt (attempts/<n>/): prompt.txt, mounts.json, sandbox.args, sandbox-check.txt, events.jsonl, stderr.txt,
 * wire.jsonl (+ .totals.json), route.json, sessions/ (the transcript), config/settings.json, target hashes of every fresh copy,
 * outputs/<name>/ (collected writable mounts), meta.json (exit, guard, requests, tokens, list-price cost, route). The route check
 * fails loudly on any request that is not gpt-6.1-sol / high / answered by gpt-6.1-sol / attributed to the session.
 * Infrastructure retry: at most once, and only when an attempt has zero successful model requests; the failed attempt is kept.
 * Sandbox copies, the agent dir and the scratch live under the caller's scratch root (never the repository); credentials never
 * reach the evidence (the provider key comes from the environment; every evidence file is redacted).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, runGuarded, sha, startProxy } from "../mdsd-ab/run.js";
import {
  AGENT, BIN_MOUNT, HOME, NODE, PI_CLI, PROVIDER_MOUNT, REPO, SCRATCH_MOUNT, agentDir, allFiles, catalogEntry, display, makeTarget, pythonWrappers, readJson, rootAnchors,
  sandboxCommand, sandboxEnv, venvMount, writeJson,
} from "./env.js";
import { contentHashes, redactTree, routeFidelity, sessionTranscripts, successful, targetCheck, usageOf, wireStats, type RouteReport, type WireEntry } from "./evidence.js";
import { MODEL_REF, THINKING } from "./protocol.js";

/** Default process guard of one evaluator session. */
export const SOL_GUARD_MS = 60 * 60_000;
/** Infrastructure retries per session: only an attempt without one successful model request; the failed attempt is kept. */
export const INFRA_RETRIES = 1;
/** The logging proxy's port inside the session's private network namespace (the in-sandbox end of the bridge). */
export const SANDBOX_PROXY_PORT = 47123;
export const SUPPORT_MOUNT = join(HOME, ".local/share/sol-session");
export const NET_MOUNT = join(HOME, ".local/share/sol-net");
/** The frozen inputs of the round-1 study, reused by every round-2 evaluator session: provider package and model catalog. */
export const STUDY_DIR = join(REPO, "results/cb-ab/study");
export const DEFAULT_PROVIDER = join(STUDY_DIR, "provider");
export const DEFAULT_CATALOG = join(STUDY_DIR, "catalog");
/** The upstream CLIProxyAPI port (experiments/mdsd-ab/run.ts UPSTREAM); the sandbox check asserts it is unreachable from inside. */
const UPSTREAM_PORT = 8317;
/** Pi's command-line prompt must stay well below the kernel's single-argument limit (128 KiB). */
export const MAX_PROMPT_BYTES = 100_000;

// ---- mounts ----------------------------------------------------------------------------------------------------------------------

/**
 * One explicit mount of a session:
 *  - `ro`: a read-only bind of an existing host path (staged inputs, a virtualenv);
 *  - `copy`: a FRESH copy of a host directory per attempt (no `.git`), writable or read-only, hashed before and after the run;
 *  - `empty`: an empty writable directory per attempt; `collect` names it in the evidence (outputs/<collect>/).
 */
export type MountSpec =
  | { kind: "ro"; host: string; sandbox: string; purpose: string }
  | { kind: "copy"; host: string; sandbox: string; purpose: string; writable: boolean }
  | { kind: "empty"; sandbox: string; purpose: string; collect?: string };

/** A Python project's virtualenv, read-only at ~/.venvs/<projectDir>, with the run.ts `python`/`pytest` wrappers on PATH. */
export interface VenvSpec { host: string; projectDir: string; pythonPath: string; anchorsFrom: string; fallbackRoot: string }

export interface SessionSpec {
  /** Evidence directory (in the repository's results, typically); must not hold an earlier session. */
  outDir: string;
  /** Scratch root for this session's sandbox copies, agent dir and scratch (outside the repository; never /tmp itself). */
  scratch: string;
  label: string;
  prompt: string;
  /** In-sandbox working directory. */
  cwd: string;
  mounts: MountSpec[];
  venv?: VenvSpec;
  guardMs?: number;
  catalogDir?: string;
  providerDir?: string;
  /** Host paths no mount may expose (contain or lie inside); this repository's root is always forbidden as a whole. */
  forbidden?: string[];
  /** The live agent dir whose provider connection and credentials are used (tests substitute one). */
  liveAgent?: string;
  /** Infrastructure retries (default INFRA_RETRIES). */
  infraRetries?: number;
}

const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel)); };
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Home entries reserved for the fixed mounts (toolchain, agent dir, provider/wrappers/bridge, virtualenv): no explicit mount below them. */
const RESERVED = [".pi", ".local", ".nvm", ".bun", ".venvs"];

/**
 * Problems of a mount list (empty = safe): an explicit mount whose source contains a forbidden path or this repository's root, or lies
 * inside a forbidden path; a sandbox path outside the empty home, below a reserved home entry, or mounted twice.
 */
export function mountProblems(mounts: readonly MountSpec[], forbidden: readonly string[] = [], repo = REPO): string[] {
  const problems: string[] = [];
  const root = real(repo);
  const banned = [...forbidden.map(real), root];
  const seen = new Set<string>();
  for (const mount of mounts) {
    if (!isAbsolute(mount.sandbox) || !inside(HOME, mount.sandbox) || mount.sandbox === HOME) problems.push(`${mount.sandbox}: a session mount must lie below the empty home`);
    else if (RESERVED.includes(relative(HOME, mount.sandbox).split("/")[0]!)) problems.push(`${mount.sandbox}: below a reserved home entry (${RESERVED.join(", ")})`);
    if (seen.has(mount.sandbox)) problems.push(`${mount.sandbox}: mounted twice`);
    seen.add(mount.sandbox);
    if (mount.kind === "empty") continue;
    const source = real(mount.host);
    for (const path of banned) {
      if (inside(source, path)) problems.push(`${mount.sandbox}: its source ${mount.host} contains the forbidden path ${path}`);
      else if (path !== root && inside(path, source)) problems.push(`${mount.sandbox}: its source ${mount.host} lies inside the forbidden path ${path}`);
    }
  }
  return problems;
}

/** Copy `files` (host path → name in the staged directory) into a fresh directory; every file's sha256 is recorded. */
export function stageFiles(dir: string, files: readonly { from: string; name: string }[]): { name: string; from: string; sha256: string; bytes: number }[] {
  if (existsSync(dir)) throw new Error(`${dir} exists: a staged directory is written once`);
  mkdirSync(dir, { recursive: true });
  return files.map(file => {
    if (file.name.split("/").includes("..") || isAbsolute(file.name)) throw new Error(`staged name ${file.name} must be relative`);
    mkdirSync(dirname(join(dir, file.name)), { recursive: true });
    cpSync(file.from, join(dir, file.name), { dereference: true });
    const bytes = readFileSync(join(dir, file.name));
    return { name: file.name, from: display(file.from), sha256: sha(bytes), bytes: bytes.length };
  });
}

// ---- the network bridge ----------------------------------------------------------------------------------------------------------

/**
 * The in-sandbox end of the bridge (written into the support mount): listens on 127.0.0.1:<port> inside the private network
 * namespace, pipes every connection to the host bridge's Unix socket, then runs the command (stdio inherited) and exits with its code.
 */
export const BRIDGE_SCRIPT = `// cb-ab sol-session bridge (generated by experiments/cb-ab/sol-session.ts): 127.0.0.1:<port> -> <unix socket>, then <command>.
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
const [port, socket, separator, command, ...args] = process.argv.slice(2);
if (separator !== "--" || !command) { console.error("usage: bridge.mjs <port> <socket> -- <command> [args...]"); process.exit(2); }
const server = net.createServer(client => {
  const upstream = net.connect(socket);
  client.pipe(upstream); upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close); upstream.on("error", close); client.on("close", close); upstream.on("close", close);
});
server.on("error", error => { console.error("bridge: " + error.message); process.exit(3); });
server.listen(Number(port), "127.0.0.1", () => {
  const child = spawn(command, args, { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
  child.on("error", error => { console.error("bridge: " + error.message); process.exit(127); });
  child.on("exit", (code, signal) => { server.close(); process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 15) : 1)); });
});
`;

/** The host end: a Unix socket server piping every connection to the logging proxy on 127.0.0.1:<proxyPort>. */
export function hostBridge(socketPath: string, proxyPort: number): Promise<Server> {
  if (Buffer.byteLength(socketPath) > 100) throw new Error(`socket path too long for AF_UNIX (${socketPath})`);
  return new Promise((done, fail) => {
    const server = createServer(client => {
      const upstream = connect(proxyPort, "127.0.0.1");
      client.pipe(upstream); upstream.pipe(client);
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on("error", close); upstream.on("error", close); client.on("close", close); upstream.on("close", close);
    });
    server.once("error", fail);
    server.listen(socketPath, () => { server.off("error", fail); done(server); });
  });
}

// ---- the sandbox -----------------------------------------------------------------------------------------------------------------

export interface SandboxLayout {
  agent: string; provider: string; bin: string; support: string; net: string; scratch: string; cwd: string;
  venv?: { host: string; projectDir: string };
  /** Resolved explicit mounts: the host path bound (a fresh copy for `copy`/`empty`) and how. */
  mounts: { host: string; sandbox: string; writable: boolean }[];
}

/** bubblewrap arguments: run.ts's layout without the orche runtime, plus a private network namespace and the explicit mounts. */
export function solSandboxArgs(layout: SandboxLayout): string[] {
  return [
    "--dev-bind", "/", "/", "--die-with-parent", "--unshare-pid", "--unshare-net", "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", HOME,
    "--ro-bind", join(HOME, ".nvm"), join(HOME, ".nvm"),
    "--ro-bind", join(HOME, ".bun"), join(HOME, ".bun"),
    "--bind", layout.agent, AGENT,
    "--ro-bind", layout.provider, PROVIDER_MOUNT,
    "--ro-bind", layout.bin, BIN_MOUNT,
    "--ro-bind", layout.support, SUPPORT_MOUNT,
    "--bind", layout.net, NET_MOUNT,
    ...(layout.venv ? ["--ro-bind", layout.venv.host, venvMount(layout.venv.projectDir)] : []),
    ...layout.mounts.flatMap(mount => [mount.writable ? "--bind" : "--ro-bind", mount.host, mount.sandbox]),
    "--bind", layout.scratch, SCRATCH_MOUNT,
    "--chdir", layout.cwd,
  ];
}

/** The command run inside the sandbox: the bridge, which then runs `command`. */
export const bridged = (command: readonly string[]): string[] => [NODE, join(SUPPORT_MOUNT, "bridge.mjs"), String(SANDBOX_PROXY_PORT), join(NET_MOUNT, "s"), "--", ...command];

/** The Pi command of an evaluator session: provider only (no orche), Sol/high, JSON mode, no project context files, its session id. */
export const solPiArgs = (sessionId: string, prompt: string): string[] => [NODE, PI_CLI, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--no-context-files",
  "-e", join(PROVIDER_MOUNT, "extensions/index.ts"), "--model", MODEL_REF, "--thinking", THINKING, "--mode", "json", "--session-id", sessionId, prompt];

const probeNet = (name: string, port: number, host: string) => `node -e 'const s=require("net").connect(${port},"${host}");s.setTimeout(3000);s.on("connect",()=>{console.log("${name}: reachable");s.destroy()});s.on("timeout",()=>{console.log("${name}: timeout");s.destroy()});s.on("error",e=>console.log("${name}: "+e.code))'`;
/** Model-free check of the session sandbox before Pi starts (run through the bridge, like Pi). */
export function solCheckScript(venv: boolean, repo = REPO): string {
  return [
    'echo "home: $(ls -A "$HOME" | tr "\\n" " ")"',
    'echo "tmp: $(ls -A /tmp | tr "\\n" " ")"',
    'echo "pwd: $PWD"',
    ...(venv ? [
      "python -c 'import sys, os; print(\"prefix:\", sys.prefix); print(\"pythonpath:\", os.environ.get(\"PYTHONPATH\")); print(\"nobytecode:\", sys.dont_write_bytecode)'",
      'echo "pytest: $(pytest --version 2>&1 | head -1)"',
      'pip --version >/dev/null 2>&1; echo "pip-exit: $?"',
    ] : []),
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1; echo "git-worktree-exit: $?"',
    `echo "repo-visible: $(test -e '${repo}' && echo yes || echo no)"`,
    'echo "agent: $(ls -A "$HOME/.pi/agent" | tr "\\n" " ")"',
    probeNet("bridge", SANDBOX_PROXY_PORT, "127.0.0.1"),
    probeNet("upstream", UPSTREAM_PORT, "127.0.0.1"),
    probeNet("external", 443, "1.1.1.1"),
    'echo "pid1-options: $(tr "\\000" "\\n" < /proc/1/cmdline | sed -n "2,/^--\\$/p" | tr "\\n" " ")"',
  ].join("\n");
}
export function parseSolCheck(output: string, expect: { cwd: string; homeEntries: readonly string[]; venv?: string; projectRoot?: string }): { ok: boolean; problems: string[]; values: Record<string, string> } {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) { const match = /^([a-z0-9-]+): ?(.*)$/.exec(line.trim()); if (match) values[match[1]!] = match[2]!.trim(); }
  const problems: string[] = [];
  const home = (values.home ?? "").split(/\s+/).filter(Boolean).sort();
  if (home.join(" ") !== [...new Set(expect.homeEntries)].sort().join(" ")) problems.push(`home shows ${home.join(" ") || "nothing"} (expected ${[...new Set(expect.homeEntries)].sort().join(" ")})`);
  if ((values.tmp ?? "").split(/\s+/).filter(Boolean).join(" ") !== "pi-orche") problems.push(`/tmp shows ${values.tmp}`);
  if (values.pwd !== expect.cwd) problems.push(`cwd ${values.pwd}`);
  if (expect.venv) {
    if (values.prefix !== expect.venv) problems.push(`python prefix ${values.prefix}`);
    if (expect.projectRoot && !(values.pythonpath ?? "").startsWith(expect.projectRoot)) problems.push(`PYTHONPATH ${values.pythonpath}`);
    if (values.nobytecode !== "True") problems.push("bytecode writing on");
    if (!/^pytest \d/.test(values.pytest ?? "")) problems.push(`pytest ${values.pytest}`);
    if (values["pip-exit"] === "0") problems.push("pip runs");
  }
  if (values["git-worktree-exit"] === "0") problems.push("the working directory is inside a git work tree");
  if (values["repo-visible"] !== "no") problems.push("the repository is visible");
  if (values.bridge !== "reachable") problems.push(`the proxy bridge is not reachable (${values.bridge})`);
  if (values.upstream === "reachable") problems.push("the upstream CLIProxyAPI is reachable directly");
  if (values.external === "reachable") problems.push("an external address is reachable");
  if (values["pid1-options"] !== "--args 3 --") problems.push(`host paths in the sandbox's process list (bwrap options ${(values["pid1-options"] ?? "unknown").slice(0, 160)})`);
  return { ok: problems.length === 0, problems, values };
}

// ---- one session -----------------------------------------------------------------------------------------------------------------

export interface AttemptResult {
  n: number; dir: string; status: "completed" | "error"; error?: string;
  exit?: number | null; signal?: string | null; guardFired?: boolean; wallMs?: number;
  successfulRequests: number; infra: boolean;
  route?: { ok: boolean; requests: number; posts: number; violations: number; byKind: Record<string, number> };
  usage?: ReturnType<typeof usageOf>;
  outputs: Record<string, string>;
  sessionId?: string;
}
export interface SessionResult { dir: string; label: string; attempts: AttemptResult[]; final: AttemptResult; routeOk: boolean; costUSD: number; requests: number; scratchDir: string }

function stopChild(child: ChildProcess | undefined): Promise<void> {
  return new Promise(done => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { done(); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 5_000);
    child.once("exit", () => { clearTimeout(timer); done(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timer); done(); }
  });
}
const closeServer = (server: Server | undefined) => new Promise<void>(done => { if (!server) { done(); return; } server.close(() => done()); });

/** Every proxy child of this process, stopped when the process exits (no proxy outlives its runner). */
const liveProxies = new Set<ChildProcess>();
process.on("exit", () => { for (const child of liveProxies) { try { child.kill("SIGTERM"); } catch { /* gone */ } } });

/** Home entries the sandbox shows: the fixed mounts plus the top-level names of the explicit mounts below the home. */
function homeEntries(spec: SessionSpec): string[] {
  const names = new Set([".bun", ".local", ".nvm", ".pi"]);
  if (spec.venv) names.add(".venvs");
  for (const mount of spec.mounts) if (inside(HOME, mount.sandbox)) names.add(relative(HOME, mount.sandbox).split("/")[0]!);
  return [...names];
}

async function runAttempt(spec: SessionSpec, n: number, attemptDir: string, work: string): Promise<AttemptResult> {
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  const live = spec.liveAgent ?? AGENT;
  const meta: Record<string, any> = { label: spec.label, attempt: n, status: "running", pid: process.pid, startedAt: new Date().toISOString(), model: MODEL_REF, thinking: THINKING, guardMs: spec.guardMs ?? SOL_GUARD_MS, scratch: work };
  const save = () => writeJson(join(attemptDir, "meta.json"), meta);
  save();
  const result: AttemptResult = { n, dir: attemptDir, status: "error", successfulRequests: 0, infra: false, outputs: {} };
  let proxy: ChildProcess | undefined, bridge: Server | undefined, secrets: string[] = [], net: string | undefined;
  const copies: { name: string; dir: string; before: Record<string, string> }[] = [];
  try {
    if (Buffer.byteLength(spec.prompt) > MAX_PROMPT_BYTES) throw new Error(`prompt of ${Buffer.byteLength(spec.prompt)} bytes exceeds ${MAX_PROMPT_BYTES}`);
    const problems = mountProblems(spec.mounts, spec.forbidden ?? []);
    if (problems.length) throw new Error(`unsafe mounts: ${problems.join("; ")}`);
    // Resolve the explicit mounts: fresh copies and empty directories below the attempt's work dir.
    const resolved: SandboxLayout["mounts"] = [], listing: Record<string, unknown>[] = [];
    spec.mounts.forEach((mount, index) => {
      if (mount.kind === "ro") {
        if (!existsSync(mount.host)) throw new Error(`mount source ${mount.host} does not exist`);
        resolved.push({ host: mount.host, sandbox: mount.sandbox, writable: false });
        listing.push({ sandbox: mount.sandbox, mode: "ro", kind: "bind", host: display(mount.host), purpose: mount.purpose, files: statSync(mount.host).isDirectory() ? allFiles(mount.host).length : 1 });
      } else if (mount.kind === "copy") {
        const dir = join(work, "mounts", `${index}-${basename(mount.sandbox)}`);
        mkdirSync(dirname(dir), { recursive: true });
        makeTarget(mount.host, dir);
        const before = contentHashes(dir);
        copies.push({ name: `${index}-${basename(mount.sandbox)}`, dir, before });
        writeJson(join(attemptDir, `copy-${index}-before.json`), before);
        resolved.push({ host: dir, sandbox: mount.sandbox, writable: mount.writable });
        listing.push({ sandbox: mount.sandbox, mode: mount.writable ? "rw" : "ro", kind: "fresh copy", host: display(mount.host), purpose: mount.purpose, files: Object.keys(before).length, digest: sha(JSON.stringify(before)) });
      } else {
        const dir = join(work, "mounts", `${index}-${basename(mount.sandbox)}`);
        mkdirSync(dir, { recursive: true });
        resolved.push({ host: dir, sandbox: mount.sandbox, writable: true });
        listing.push({ sandbox: mount.sandbox, mode: "rw", kind: "empty", purpose: mount.purpose, ...(mount.collect ? { collect: mount.collect } : {}) });
      }
    });
    // Fixed parts: wrappers, support (bridge), network socket dir, scratch, agent dir (Sol/high, no orche config, no stored login).
    const bin = join(work, "bin");
    if (spec.venv) pythonWrappers(bin, { venv: venvMount(spec.venv.projectDir), fallbackRoot: spec.venv.fallbackRoot, anchors: rootAnchors(spec.venv.anchorsFrom), pythonPath: spec.venv.pythonPath });
    else mkdirSync(bin, { recursive: true });
    const support = join(work, "support");
    mkdirSync(support, { recursive: true });
    writeFileSync(join(support, "bridge.mjs"), BRIDGE_SCRIPT);
    net = join(resolve(spec.scratch), `n-${randomBytes(4).toString("hex")}`);
    mkdirSync(net, { recursive: true });
    const scratch = join(work, "pi-orche");
    mkdirSync(join(scratch, "tmp"), { recursive: true });
    const catalogDir = spec.catalogDir ?? DEFAULT_CATALOG, providerDir = spec.providerDir ?? DEFAULT_PROVIDER;
    const catalog = catalogEntry(join(catalogDir, "cliproxyapi-models.json"));
    writeJson(join(attemptDir, "envelope.json"), { prices: catalog.prices });
    const started = await startProxy(join(attemptDir, "wire.jsonl"), join(attemptDir, "envelope.json"));
    proxy = started.child; liveProxies.add(proxy);
    const proxyPort = Number(new URL(started.url).port);
    bridge = await hostBridge(join(net, "s"), proxyPort);
    const inSandboxUrl = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
    const agent = agentDir(work, catalogDir, inSandboxUrl, live);
    rmSync(join(agent.dir, "orche.config.json"), { force: true });
    secrets = agent.secrets;
    const layout: SandboxLayout = { agent: agent.dir, provider: providerDir, bin, support, net, scratch, cwd: spec.cwd, ...(spec.venv ? { venv: { host: spec.venv.host, projectDir: spec.venv.projectDir } } : {}), mounts: resolved };
    const box = solSandboxArgs(layout);
    const env = sandboxEnv(inSandboxUrl, agent.apiKey);
    const mountsRecord = {
      explicit: listing,
      fixed: [
        { sandbox: HOME, mode: "tmpfs", purpose: "empty home" }, { sandbox: "/tmp", mode: "tmpfs", purpose: "private /tmp" },
        { sandbox: join(HOME, ".nvm"), mode: "ro", host: join(HOME, ".nvm"), purpose: "toolchain (node)" }, { sandbox: join(HOME, ".bun"), mode: "ro", host: join(HOME, ".bun"), purpose: "toolchain (pi CLI)" },
        { sandbox: AGENT, mode: "rw", host: "<scratch>/agent", purpose: "private agent dir: Sol/high settings, frozen catalog, provider connection without key, no login" },
        { sandbox: PROVIDER_MOUNT, mode: "ro", host: display(providerDir), purpose: "CLIProxyAPI provider package" },
        { sandbox: BIN_MOUNT, mode: "ro", host: "<scratch>/bin", purpose: spec.venv ? "python/pytest wrappers (pip refused)" : "empty" },
        { sandbox: SUPPORT_MOUNT, mode: "ro", host: "<scratch>/support", purpose: "the in-sandbox network bridge" },
        { sandbox: NET_MOUNT, mode: "rw", host: "<scratch>/n-*", purpose: "the Unix socket to this session's logging proxy (the only network path)" },
        ...(spec.venv ? [{ sandbox: venvMount(spec.venv.projectDir), mode: "ro", host: display(spec.venv.host), purpose: "the project's virtualenv" }] : []),
        { sandbox: SCRATCH_MOUNT, mode: "rw", host: "<scratch>/pi-orche", purpose: "scratch and TMPDIR" },
      ],
      network: `private network namespace; ${inSandboxUrl} -> unix socket -> logging proxy -> CLIProxyAPI`,
      forbidden: [...(spec.forbidden ?? []).map(display), `${REPO} (the repository root)`],
      cwd: spec.cwd,
    };
    writeJson(join(attemptDir, "mounts.json"), mountsRecord);
    meta.mounts = mountsRecord; meta.proxy = started.url; meta.catalog = { dir: display(catalogDir), sha256: catalog.sha256 }; meta.provider = display(providerDir);
    save();
    // The sandbox as Pi will see it (no model involved).
    const argsFile = join(attemptDir, "sandbox.args");
    const check = sandboxCommand(box, argsFile, bridged(["/bin/sh", "-c", solCheckScript(!!spec.venv)]));
    const checked = await runGuarded(check.command, check.args, { env, stdout: join(attemptDir, "sandbox-check.txt"), stderr: join(attemptDir, "sandbox-check.txt"), guardMs: 60_000 });
    const projectRoot = spec.venv ? spec.venv.fallbackRoot : undefined;
    meta.sandboxCheck = { exit: checked.code, ...parseSolCheck(existsSync(join(attemptDir, "sandbox-check.txt")) ? readFileSync(join(attemptDir, "sandbox-check.txt"), "utf8") : "", { cwd: spec.cwd, homeEntries: homeEntries(spec), ...(spec.venv ? { venv: venvMount(spec.venv.projectDir), ...(projectRoot ? { projectRoot } : {}) } : {}) }) };
    save();
    if (!meta.sandboxCheck.ok) throw new Error(`sandbox check failed: ${meta.sandboxCheck.problems.join("; ")}`);
    // The session.
    writeFileSync(join(attemptDir, "prompt.txt"), spec.prompt);
    const sessionId = randomUUID();
    result.sessionId = sessionId;
    const command = solPiArgs(sessionId, spec.prompt);
    meta.sessionId = sessionId;
    meta.command = { bwrap: box, argsFile: "sandbox.args", inSandbox: [...bridged(command.slice(0, -1)), "<prompt.txt>"], promptSha256: sha(spec.prompt), env: Object.keys(env).sort() };
    save();
    const pi = sandboxCommand(box, argsFile, bridged(command));
    meta.pi = await runGuarded(pi.command, pi.args, { env, stdout: join(attemptDir, "events.jsonl"), stderr: join(attemptDir, "stderr.txt"), guardMs: spec.guardMs ?? SOL_GUARD_MS });
    meta.wallMs = meta.pi.endedAt - meta.pi.startedAt;
    await closeServer(bridge); bridge = undefined;
    await stopChild(proxy); liveProxies.delete(proxy); proxy = undefined;
    // Evidence.
    const errors: string[] = [];
    const step = <T>(name: string, fn: () => T): T | undefined => { try { return fn(); } catch (error) { errors.push(`${name}: ${String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 800)}`); return undefined; } };
    step("sessions", () => { if (existsSync(join(agent.dir, "sessions"))) cpSync(join(agent.dir, "sessions"), join(attemptDir, "sessions"), { recursive: true, verbatimSymlinks: true }); });
    step("config", () => { mkdirSync(join(attemptDir, "config"), { recursive: true }); cpSync(join(agent.dir, "settings.json"), join(attemptDir, "config/settings.json")); });
    const wire = (step("wire", () => readJsonl(join(attemptDir, "wire.jsonl"))) ?? []) as WireEntry[];
    const transcripts = step("transcripts", () => sessionTranscripts(sessionId, join(attemptDir, "sessions"))) ?? new Map();
    step("route", () => {
      const route: RouteReport = routeFidelity(wire, transcripts, new Set(), attemptDir);
      const mainSessions = route.sessions.filter(item => item.agent === "main").length;
      if (mainSessions !== 1) route.violations.push({ kind: "session-unverifiable", detail: `${mainSessions} transcripts of the session ${sessionId}` });
      route.ok = route.violations.length === 0;
      route.byKind = {};
      for (const item of route.violations) route.byKind[item.kind] = (route.byKind[item.kind] ?? 0) + 1;
      writeJson(join(attemptDir, "route.json"), route);
      result.route = { ok: route.ok, requests: route.requests, posts: route.posts, violations: route.violations.length, byKind: route.byKind };
      meta.route = { ...result.route, first: route.violations.slice(0, 20), sessions: route.sessions };
    });
    step("usage", () => {
      const requests = wire.filter(entry => entry.method === "POST" && entry.model);
      result.usage = usageOf(requests);
      meta.usage = result.usage;
      meta.wire = { ...wireStats(requests), totals: existsSync(join(attemptDir, "wire.jsonl.totals.json")) ? readJson(join(attemptDir, "wire.jsonl.totals.json")) : undefined };
      result.successfulRequests = requests.filter(successful).length;
      meta.successfulRequests = result.successfulRequests;
      result.infra = result.successfulRequests === 0;
      meta.infra = result.infra;
    });
    step("copies", () => {
      meta.copies = {};
      for (const copy of copies) {
        const after = contentHashes(copy.dir);
        writeJson(join(attemptDir, `copy-${copy.name.split("-")[0]}-after.json`), after);
        meta.copies[copy.name] = targetCheck(copy.before, after);
      }
    });
    step("outputs", () => {
      spec.mounts.forEach((mount, index) => {
        if (mount.kind !== "empty" || !mount.collect) return;
        const from = join(work, "mounts", `${index}-${basename(mount.sandbox)}`), to = join(attemptDir, "outputs", mount.collect);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true, verbatimSymlinks: true });
        result.outputs[mount.collect] = to;
      });
      meta.outputs = Object.fromEntries(Object.entries(result.outputs).map(([name, dir]) => [name, { dir: relative(attemptDir, dir), files: allFiles(dir).map(file => relative(dir, file)) }]));
    });
    result.exit = meta.pi.code; result.signal = meta.pi.signal; result.guardFired = meta.pi.guardFired; result.wallMs = meta.wallMs;
    meta.evidenceErrors = errors;
    meta.status = "completed"; result.status = "completed";
    meta.endedAt = new Date().toISOString();
    save();
    const route = result.route;
    if (!route?.ok) console.error(`ROUTE VIOLATION ${spec.label} attempt ${n}: ${route ? `${route.violations} violation(s) ${JSON.stringify(route.byKind)}` : "route check failed"} (${display(attemptDir)}/route.json)`);
    console.log(`SESSION ${spec.label} attempt ${n}: exit ${meta.pi.code}${meta.pi.guardFired ? " (guard)" : ""}, ${Math.round(meta.wallMs / 1000)} s, ${result.usage?.requests ?? "?"} requests, $${result.usage?.costUSD ?? "?"}, route ${route?.ok ? "ok" : "VIOLATED"}`);
  } catch (error) {
    meta.status = "error"; meta.error = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 2000); meta.endedAt = new Date().toISOString();
    result.status = "error"; result.error = String(error instanceof Error ? error.message : error).slice(0, 500);
    // A failed setup or run counts its successful requests from the wire (zero = infrastructure).
    try { const requests = readJsonl(join(attemptDir, "wire.jsonl")).filter((entry: WireEntry) => entry.method === "POST" && entry.model); result.successfulRequests = requests.filter(successful).length; result.usage = usageOf(requests); } catch { /* none */ }
    result.infra = result.successfulRequests === 0;
    meta.successfulRequests = result.successfulRequests; meta.infra = result.infra;
    save();
    console.error(`SESSION ${spec.label} attempt ${n}: ERROR ${result.error}`);
  } finally {
    await closeServer(bridge);
    if (proxy) { await stopChild(proxy); liveProxies.delete(proxy); }
    if (net) rmSync(net, { recursive: true, force: true });
    try { redactTree(attemptDir, secrets.length ? secrets : liveSecretsSafe(live)); } catch { /* best effort; checked by the caller's redaction pass */ }
  }
  return result;
}
const liveSecretsSafe = (live: string): string[] => { try { const { apiKey } = readJson(join(live, "cliproxyapi.json")); return apiKey ? [String(apiKey)] : []; } catch { return []; } };

/**
 * Run one evaluator session with its infrastructure retry: attempts/<n>/ per attempt in `outDir`; an attempt without one successful
 * model request is kept and rerun, at most `infraRetries` times. Nothing else is retried here (the caller applies its own rules).
 */
export async function runSession(spec: SessionSpec): Promise<SessionResult> {
  const outDir = resolve(spec.outDir);
  if (existsSync(join(outDir, "session.json"))) throw new Error(`${outDir} holds an earlier session (session.json): a session directory is written once`);
  if (!spec.scratch || resolve(spec.scratch) === "/tmp" || inside(REPO, resolve(spec.scratch))) throw new Error(`scratch ${spec.scratch} must be a dedicated directory outside the repository (not /tmp itself)`);
  mkdirSync(outDir, { recursive: true });
  const attempts: AttemptResult[] = [];
  const key = `${spec.label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}-${randomBytes(3).toString("hex")}`;
  const retries = spec.infraRetries ?? INFRA_RETRIES;
  for (let n = 1; n <= 1 + retries; n++) {
    const attempt = await runAttempt(spec, n, join(outDir, "attempts", String(n)), join(resolve(spec.scratch), key, String(n)));
    attempts.push(attempt);
    if (!attempt.infra) break;
    if (n <= retries) console.error(`INFRA ${spec.label}: attempt ${n} has no successful model request; kept as attempts/${n}; retrying once`);
  }
  const final = attempts.at(-1)!;
  const costUSD = Math.round(attempts.reduce((total, item) => total + (item.usage?.costUSD ?? 0), 0) * 1e6) / 1e6;
  const requests = attempts.reduce((total, item) => total + (item.usage?.requests ?? 0), 0);
  // Every attempt must be route-clean; one without a route report counts only when it sent no model request.
  const routeOk = attempts.every(item => item.route ? item.route.ok : (item.usage?.requests ?? 0) === 0);
  const summary: SessionResult = { dir: outDir, label: spec.label, attempts, final, routeOk, costUSD, requests, scratchDir: join(resolve(spec.scratch), key) };
  writeJson(join(outDir, "session.json"), {
    label: spec.label, model: MODEL_REF, thinking: THINKING, final: final.n, routeOk, finalRouteOk: final.route?.ok === true, requests, costUSD,
    attempts: attempts.map(item => ({ n: item.n, dir: relative(outDir, item.dir), status: item.status, error: item.error, exit: item.exit, signal: item.signal, guardFired: item.guardFired, wallMs: item.wallMs, successfulRequests: item.successfulRequests, infra: item.infra, route: item.route, usage: item.usage, outputs: Object.keys(item.outputs), sessionId: item.sessionId })),
  });
  return summary;
}

/** Remove a session's sandbox copies, agent dir and scratch from the scratch root once its evidence is in place (hashes stay in the evidence). */
export function cleanScratch(result: Pick<SessionResult, "scratchDir">): void {
  if (result.scratchDir && existsSync(result.scratchDir)) rmSync(result.scratchDir, { recursive: true, force: true });
}

// ---- CLI -------------------------------------------------------------------------------------------------------------------------

const USAGE = "usage: sol-session.ts run <spec.json> | smoke <outDir> --scratch <dir>";
const option = (argv: readonly string[], name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };

export async function main(argv: readonly string[]): Promise<number> {
  const [command, first] = argv;
  if (command === "run" && first) {
    const raw = readJson(first);
    const spec: SessionSpec = { ...raw, prompt: raw.prompt ?? readFileSync(resolve(dirname(first), String(raw.promptFile)), "utf8") };
    const result = await runSession(spec);
    return result.final.status === "completed" && result.routeOk && !result.final.infra ? 0 : 1;
  }
  if (command === "smoke" && first) {
    const scratch = option(argv, "--scratch") ?? process.env.CB_AB_SOL_SCRATCH;
    if (!scratch) throw new Error("smoke needs --scratch <dir> (or CB_AB_SOL_SCRATCH)");
    const project = join(resolve(scratch), `smoke-project-${randomBytes(3).toString("hex")}`);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "hello.txt"), "sol-session smoke 42\n");
    const result = await runSession({
      outDir: first, scratch, label: "smoke", cwd: join(HOME, "work/project"),
      prompt: "Harness check. Use the bash tool to run `cat hello.txt` in the current directory, then write the file's exact content into ~/work/out/answer.txt, and reply with that content only.",
      mounts: [
        { kind: "copy", host: project, sandbox: join(HOME, "work/project"), purpose: "toy project (fresh copy)", writable: true },
        { kind: "empty", sandbox: join(HOME, "work/out"), purpose: "output", collect: "out" },
      ],
      guardMs: 10 * 60_000,
    });
    rmSync(project, { recursive: true, force: true });
    cleanScratch(result);
    const answer = result.final.outputs.out && existsSync(join(result.final.outputs.out, "answer.txt")) ? readFileSync(join(result.final.outputs.out, "answer.txt"), "utf8") : "(none)";
    console.log(JSON.stringify({ routeOk: result.routeOk, requests: result.requests, costUSD: result.costUSD, answer: answer.trim(), attempts: result.attempts.length }));
    return result.routeOk && answer.trim() === "sol-session smoke 42" ? 0 : 1;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
