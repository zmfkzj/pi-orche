/**
 * The strong-vs-MDSD comparison on the historical ultra snapshot (docs/mdsd-ab-bench.md). One arm per process: a fresh copy of the
 * target, a private agent dir with the SAME orche config for both arms, its own logging/budget proxy (proxy.mjs), the real `pi` CLI in
 * JSON mode with the one-shot `/orche strong <PROMPT>` or `/orche mdsd <PROMPT>`, inside a bubblewrap mount namespace that hides the
 * home directory (workspace with later fixes, orche records, sessions, installed packages, this experiment's notes and rubric)
 * except what the run needs. Each arm is timed by its own process from launch to exit (no shared barrier).
 *
 *   node --import tsx experiments/mdsd-ab/run.ts prepare <runDir>            frozen runtime, input prompt, manifest
 *   node --import tsx experiments/mdsd-ab/run.ts arm <runDir> <strong|mdsd> [--toy]
 *   node --import tsx experiments/mdsd-ab/run.ts summarize <runDir> [--toy]
 *
 * The helpers are exported for a planned r2 runner (three r1 strategies x two models, not written yet); this file's commands are r1's.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export const HOME = homedir();
export const AGENT = join(HOME, ".pi/agent");
export const NODE = process.execPath;
export const PI_CLI = join(HOME, ".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
/** The CLIProxyAPI provider package as the user's Pi loads it (bundled by the umbrella package); frozen into the run directory. */
const PROVIDER_PKG = join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
export const PROVIDER_MOUNT = join(HOME, ".local/share/cliproxyapi-provider");
const UPSTREAM = "http://127.0.0.1:8317";
/** Where the runtime is mounted inside the sandbox (read-only); audited: no measured tool call may touch it. */
export const RUNTIME_MOUNT = join(HOME, ".local/share/orche-runtime");
export const TARGET_MOUNT = join(HOME, "Code/oh-my-pi-extensions/orche");

export const TARGET_COMMIT = "2de1f04";
export const MODEL = { provider: "cliproxyapi", id: "gpt-6.1-sol" } as const;
export const MODEL_REF = `${MODEL.provider}/${MODEL.id}`;
/** One model and one effort for every role of both arms (main, orchestrator, sub-workers inherit): the policy is the only difference. */
export const THINKING = "max";
export const LIMITS = {
  orche: { overallMs: 60 * 60_000, assignmentMs: 60 * 60_000, extensionMs: 15 * 60_000, extensionStepMs: 0, maxExtensions: 2, assignmentRequests: 300 },
  /** Hard kill of one arm's Pi process group. */
  piGuardMs: 150 * 60_000,
  /** The arm's whole envelope at the proxy (main + every orche session + helpers through the provider), list prices. */
  envelopeUSD: 40,
};
/** The MDSD bounds of the experiment (inert in the strong arm; the same file for both arms). */
export const MDSD = {
  maxRounds: 3,
  explorer: { requests: 60, minutes: 25, costUSD: 5, outputTokens: 150_000 },
  explorerMax: { requests: 120, minutes: 45, costUSD: 10, outputTokens: 300_000 },
  total: { costUSD: 30, requests: 600 },
  reserve: 0.3, final: 0.1, wrapUpAt: 0.8, hardStopAt: 1.25,
};
export function orcheConfig(): Record<string, unknown> {
  return {
    mainMode: "single",
    routes: {},
    models: { "strong-orchestrator": { model: MODEL_REF, thinking: THINKING }, advisor: { model: MODEL_REF, thinking: THINKING } },
    single: { ledger: false, spawn: true, advisor: false, maxSubWorkers: 8 },
    thinkingPolicy: "fixed",
    limits: { ...LIMITS.orche },
    concurrentSessions: { enabled: false },
    mdsd: MDSD,
  };
}

/** The four assignments that specified the snapshot's strong/ultra work (evaluator records; only their request text is input). */
const RECORDS = join(AGENT, "orche/records/01a11fc6-a75e-71d7-8c05-63070fd8b1a1");
const REQUIREMENT_TASKS = ["2026-10-09T09-15-42-498Z_task-8a4b75ff", "2026-10-09T10-11-47-293Z_task-4cafc77a", "2026-10-09T11-05-25-631Z_task-14f744fe", "2026-10-09T11-38-34-480Z_task-5131a60f"];

export const catalogEntries = (parsed: any): any[] => Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : Object.values(parsed ?? {});
export const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const git = (cwd: string, args: string[], input?: Buffer) => execFileSync("git", args, { cwd, ...(input ? { input } : {}), stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
export const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
export const readJsonl = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
export function filesUnder(root: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (pattern.test(entry.name)) out.push(path); } };
  if (existsSync(root)) walk(root);
  return out.sort();
}
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const file of filesUnder(root, /./)) hash.update(`${file.slice(root.length + 1)}\0${sha(readFileSync(file))}\n`);
  return hash.digest("hex");
}

// ---- prepare ----------------------------------------------------------------------------------------------------------------
export function promptBody(): string {
  const parts = REQUIREMENT_TASKS.map((dir, index) => {
    const run = JSON.parse(readFileSync(join(RECORDS, dir, "run.json"), "utf8"));
    const request = String(run.assignment?.request ?? run.request ?? "");
    if (!request.trim()) throw new Error(`${dir}: no request text`);
    return `=== Assignment ${index + 1} of 4 (verbatim) ===\n${request.trim()}`;
  });
  return [
    "The current directory is a snapshot of the pi-orche extension (a git repository with one commit) at the moment its implementer finished the work specified below: the `strong` and `ultra` modes, worker model inheritance, and the one-shot `/orche strong|ultra <PROMPT>` commands. The implementer received the requirements in the four assignments quoted verbatim at the end (Korean; requirement ids are per assignment; later assignments refine earlier ones).",
    "",
    "Your task: find the correctness defects of this implementation against those requirements — places where the code does not do what the requirements demand, or where a realistic use path breaks a stated contract (integrity, isolation, gates, mode selection, routing, commands). This is a read-only diagnosis: do not modify, fix, reformat or commit any file of the repository (scratch files outside it are fine). Treat it as an analysis question and answer with a defect report.",
    "",
    "For every defect give: (1) the mechanism — what goes wrong and why; (2) the location — file:line in this snapshot; (3) a concrete failure scenario — the steps or inputs and the wrong outcome (reproduce it when you can); (4) the requirement it violates; (5) your evidence and confidence. Also state what you checked and what you did not check. Do not report style issues, documentation-only gaps, or features outside the requirements.",
    "",
    ...parts.flatMap(part => [part, ""]),
  ].join("\n");
}

export const TOY_PROMPT = "Read-only question about the small repository in the current directory: which function in calc.js computes the average, and does it handle an empty list? Answer with file:line evidence; do not change files.";

export async function prepare(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const runtime = join(runDir, "runtime");
  if (existsSync(join(runtime, "REVISION.json"))) throw new Error(`${runtime} already frozen; use a fresh run directory`);
  const files = git(REPO, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "package.json", "tsconfig.json"]).toString().split("\n").filter(Boolean).filter(path => existsSync(join(REPO, path))).sort();
  const perFile: Record<string, string> = {};
  const hash = createHash("sha256");
  for (const path of files) { const digest = sha(readFileSync(join(REPO, path))); perFile[path] = digest; hash.update(`${path}\0${digest}\n`); await mkdir(join(runtime, path, ".."), { recursive: true }); await copyFile(join(REPO, path), join(runtime, path)); }
  await mkdir(join(runtime, "node_modules"), { recursive: true }); // mount point of the workspace node_modules (read-only)
  await cp(PROVIDER_PKG, join(runDir, "provider"), { recursive: true });
  const revision = { head: git(REPO, ["rev-parse", "HEAD"]).toString().trim(), dirty: git(REPO, ["status", "--porcelain=v1"]).toString().split("\n").filter(Boolean), digest: hash.digest("hex"), files: perFile, frozenAt: new Date().toISOString() };
  await write(join(runtime, "REVISION.json"), revision);
  const body = promptBody();
  await mkdir(join(runDir, "input"), { recursive: true });
  await writeFile(join(runDir, "input/prompt-body.md"), body);
  await writeFile(join(runDir, "input/toy-prompt.md"), TOY_PROMPT);
  const catalog = readFileSync(join(AGENT, "cliproxyapi-models.json"));
  const manifest = {
    target: { commit: git(REPO, ["rev-parse", TARGET_COMMIT]).toString().trim(), tree: git(REPO, ["rev-parse", `${TARGET_COMMIT}^{tree}`]).toString().trim(), date: git(REPO, ["show", "-s", "--format=%cI", TARGET_COMMIT]).toString().trim() },
    runtime: { head: revision.head, dirty: revision.dirty, digest: revision.digest, files: files.length },
    pi: { cli: PI_CLI, version: execFileSync(NODE, [PI_CLI, "--version"]).toString().trim() },
    provider: { source: PROVIDER_PKG, version: JSON.parse(readFileSync(join(runDir, "provider/package.json"), "utf8")).version, digest: treeDigest(join(runDir, "provider")) },
    node: process.version, bwrap: execFileSync("bwrap", ["--version"]).toString().trim(),
    catalog: { sha256: sha(catalog), model: MODEL_REF, entry: catalogEntries(JSON.parse(catalog.toString())).find(item => item.id === MODEL.id) },
    nodeModules: { lock: sha(readFileSync(join(REPO, "package-lock.json"))), snapshotPackageJson: JSON.parse(git(REPO, ["show", `${TARGET_COMMIT}:package.json`]).toString()).devDependencies },
    config: { orche: orcheConfig(), sha256: sha(JSON.stringify(orcheConfig())) },
    thinking: THINKING, limits: LIMITS,
    prompt: { sha256: sha(body), chars: body.length, sources: REQUIREMENT_TASKS, excluded: ["2026-10-09T12-05-05-247Z_task-210bbf89 (model E2E + independent verifier request: process, its findings are evaluator-only)", "every record after the snapshot commit"] },
    toyPrompt: { sha256: sha(TOY_PROMPT) },
  };
  await write(join(runDir, "manifest.json"), manifest);
  console.log(`prepared ${runDir}: runtime ${revision.digest.slice(0, 12)}, prompt ${manifest.prompt.sha256.slice(0, 12)} (${body.length} chars)`);
}

// ---- one arm ----------------------------------------------------------------------------------------------------------------
async function targetCopy(runDir: string, armDir: string, toy: boolean): Promise<{ dir: string; tree?: string }> {
  const dir = join(armDir, "target");
  await mkdir(dir, { recursive: true });
  if (toy) {
    await writeFile(join(dir, "calc.js"), "export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n\nexport function mean(xs) {\n  return sum(xs) / xs.length;\n}\n");
    await writeFile(join(dir, "README.md"), "Tiny calculator helpers.\n");
  } else {
    const archive = git(REPO, ["archive", "--format=tar", TARGET_COMMIT]);
    execFileSync("tar", ["-x", "-C", dir], { input: archive });
  }
  git(dir, ["init", "--quiet"]);
  await writeFile(join(dir, ".git/info/exclude"), "node_modules\n");
  git(dir, ["add", "--force", "."]);
  git(dir, ["-c", "user.name=snapshot", "-c", "user.email=snapshot@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", toy ? "toy" : `snapshot of ${TARGET_COMMIT}`, "--date", "2026-10-09T21:44:54+09:00"]);
  await mkdir(join(dir, "node_modules"), { recursive: true }); // mount point
  return { dir, ...(toy ? {} : { tree: git(dir, ["rev-parse", "HEAD^{tree}"]).toString().trim() }) };
}

export async function agentDir(armDir: string, proxyUrl: string, config: Record<string, unknown> = orcheConfig()): Promise<{ dir: string; apiKey: string; secrets: string[] }> {
  const dir = join(armDir, "agent");
  await mkdir(join(dir, "sessions"), { recursive: true, mode: 0o700 });
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(AGENT, name))) await copyFile(join(AGENT, name), join(dir, name));
  const connection = JSON.parse(await readFile(join(AGENT, "cliproxyapi.json"), "utf8"));
  await writeFile(join(dir, "cliproxyapi.json"), JSON.stringify({ ...connection, baseUrl: proxyUrl }), { mode: 0o600 });
  // Credentials: only TypeSafe (orche's Bash review, enabled as in the user's setup). The CLIProxyAPI login of auth.json is left out:
  // its stored connection carries the upstream URL and would bypass this arm's proxy; the API key and proxy URL come from the env.
  const auth = JSON.parse(await readFile(join(AGENT, "auth.json"), "utf8"));
  await writeFile(join(dir, "auth.json"), JSON.stringify({ ...(auth.typesafe ? { typesafe: auth.typesafe } : {}) }), { mode: 0o600 });
  await write(join(dir, "settings.json"), { defaultProvider: MODEL.provider, defaultModel: MODEL.id, defaultThinkingLevel: THINKING, quietStartup: true, transport: "sse" });
  await write(join(dir, "orche.config.json"), config);
  const secrets = [String(connection.apiKey ?? ""), ...Object.values(auth as Record<string, any>).flatMap(item => typeof item === "object" && item ? Object.values(item).filter((value): value is string => typeof value === "string" && value.length > 12) : [])];
  return { dir, apiKey: String(connection.apiKey ?? ""), secrets };
}

export function startProxy(wire: string, envelope: string): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [join(HERE, "proxy.mjs"), "0", UPSTREAM, wire, envelope], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`proxy did not start: ${text}`)); }, 15_000);
    child.stdout!.on("data", chunk => { text += String(chunk); const match = /PORT (\d+)/.exec(text); if (match) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${match[1]}`, child }); } });
    child.stderr!.on("data", chunk => { text += String(chunk); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`proxy exited ${code}: ${text}`)); });
  });
}

/**
 * bubblewrap: the host root, with the whole home replaced by an empty tmpfs plus the few read-only/private mounts a run needs. `mount`
 * (default: the orche repository's own path) is where the target appears; `extra` adds bwrap arguments (e.g. a read-only toolchain);
 * `targetNodeModules: false` leaves out the orche node_modules mount inside a target that is not this repository.
 */
export function sandboxArgs(paths: { agent: string; target: string; runtime: string; provider: string; scratch: string; mount?: string; extra?: string[]; targetNodeModules?: boolean }): string[] {
  const nm = join(REPO, "node_modules");
  const mount = paths.mount ?? TARGET_MOUNT;
  const caches = (mount: string) => [".cache", ".vite", ".vite-temp"].filter(name => existsSync(join(nm, name))).flatMap(name => ["--tmpfs", join(mount, "node_modules", name)]);
  return [
    "--dev-bind", "/", "/", "--die-with-parent",
    "--tmpfs", HOME,
    "--ro-bind", join(HOME, ".nvm"), join(HOME, ".nvm"),
    "--ro-bind", join(HOME, ".bun"), join(HOME, ".bun"),
    "--bind", paths.agent, AGENT,
    "--ro-bind", paths.provider, PROVIDER_MOUNT,
    "--ro-bind", paths.runtime, RUNTIME_MOUNT,
    "--ro-bind", nm, join(RUNTIME_MOUNT, "node_modules"), ...caches(RUNTIME_MOUNT),
    "--bind", paths.target, mount,
    ...(paths.targetNodeModules === false ? [] : ["--ro-bind", nm, join(mount, "node_modules"), ...caches(mount)]),
    ...(paths.extra ?? []),
    // Every /tmp/pi-orche (orche scratch, this experiment's notes and the evaluator material) is replaced by the arm's own.
    "--bind", paths.scratch, "/tmp/pi-orche",
    "--chdir", mount,
  ];
}

export function runGuarded(command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdout: string; stderr: string; guardMs: number }): Promise<{ code: number | null; signal: NodeJS.Signals | null; guardFired: boolean; startedAt: number; endedAt: number }> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(command, args, { env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let guardFired = false;
    const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { /* gone */ } };
    const onStop = () => { kill("SIGKILL"); process.exit(143); };
    process.once("SIGTERM", onStop); process.once("SIGINT", onStop);
    const timer = setTimeout(() => { guardFired = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 10_000).unref(); }, options.guardMs);
    let chain = Promise.resolve();
    child.stdout!.on("data", chunk => { chain = chain.then(() => appendFile(options.stdout, chunk)); });
    child.stderr!.on("data", chunk => { chain = chain.then(() => appendFile(options.stderr, chunk)); });
    child.once("close", (code, signal) => {
      const endedAt = Date.now();
      clearTimeout(timer); process.off("SIGTERM", onStop); process.off("SIGINT", onStop); kill("SIGKILL");
      void chain.then(() => resolve({ code, signal, guardFired, startedAt, endedAt }));
    });
    child.once("error", error => { clearTimeout(timer); void appendFile(options.stderr, `spawn error: ${String(error)}\n`).then(() => resolve({ code: -1, signal: null, guardFired, startedAt, endedAt: Date.now() })); });
  });
}

/** What no measured tool call may touch: the runtime copy, orche records/sessions/packages, evaluator scratch and results, the network fetch of the repository, the fix commits, package registries. */
export const AUDIT_PATTERNS = [/orche-runtime/, /\.pi\/agent\/(orche|sessions|git)\b/, /\/tmp\/pi-orche\/01a1/, /mdsd-ab|W4\//, /results\//, /github\.com|githubusercontent|zmfkzj/i, /\b(curl|wget)\b/, /git\s+(fetch|clone|pull|remote)/, /\b(e7a0891|dd98d5b)\b/, /npm\s+(view|install|i|ci)\b/];
/** Tool calls of every session transcript below `root` that touch forbidden material (runtime copy, evaluator paths, network). */
export function auditCalls(root: string): { calls: number; hits: string[] } {
  const forbidden = AUDIT_PATTERNS;
  let calls = 0;
  const hits: string[] = [];
  for (const file of filesUnder(root, /\.jsonl$/)) {
    for (const entry of readJsonl(file)) {
      const content = entry?.message?.content;
      if (entry?.message?.role !== "assistant" || !Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type !== "toolCall") continue;
        calls++;
        const text = JSON.stringify(part.arguments ?? {});
        for (const pattern of forbidden) if (pattern.test(text)) hits.push(`${file.slice(root.length + 1)}: ${part.name} ${text.slice(0, 240)} [${pattern}]`);
      }
    }
  }
  return { calls, hits };
}

async function arm(runDir: string, armName: string, toy: boolean): Promise<void> {
  if (armName !== "strong" && armName !== "mdsd") throw new Error("arm: strong | mdsd");
  const id = `${armName}${toy ? "-toy" : ""}`;
  const armDir = join(runDir, id);
  if (existsSync(join(armDir, "meta.json"))) throw new Error(`${armDir} exists; an arm runs once (see the repetition rule)`);
  await mkdir(armDir, { recursive: true });
  const meta: any = { arm: armName, toy, runDir, preparedAt: Date.now() };
  const save = () => write(join(armDir, "meta.json"), meta);
  await save();
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  const body = await readFile(join(runDir, toy ? "input/toy-prompt.md" : "input/prompt-body.md"), "utf8");
  if (sha(body) !== (toy ? manifest.toyPrompt.sha256 : manifest.prompt.sha256)) throw new Error("input prompt changed since prepare");
  if (!toy && !existsSync(join(runDir, "rubric.sha256"))) throw new Error("the rubric must be frozen (rubric.sha256 in the run directory) before a measured arm runs");
  const target = await targetCopy(runDir, armDir, toy);
  if (target.tree && target.tree !== manifest.target.tree) throw new Error(`snapshot tree ${target.tree} != ${manifest.target.tree}`);
  meta.targetTreeBefore = target.tree;
  const scratch = join(armDir, "pi-orche");
  await mkdir(join(scratch, "tmp"), { recursive: true });
  await write(join(armDir, "envelope.json"), { capUSD: LIMITS.envelopeUSD, prices: { [MODEL.id]: manifest.catalog.entry.cost } });
  const proxy = await startProxy(join(armDir, "wire.jsonl"), join(armDir, "envelope.json"));
  const agent = await agentDir(armDir, proxy.url);
  const prompt = `/orche ${armName} ${body}`;
  await writeFile(join(armDir, "prompt.txt"), prompt);
  const sessionId = `mdsd-ab-${id}`;
  const args = [...sandboxArgs({ agent: agent.dir, target: target.dir, runtime: join(runDir, "runtime"), provider: join(runDir, "provider"), scratch }), "--", NODE, PI_CLI,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve",
    "-e", join(PROVIDER_MOUNT, "extensions/index.ts"), "-e", join(RUNTIME_MOUNT, "src/extension/index.ts"),
    "--model", MODEL_REF, "--thinking", THINKING, "--mode", "json", "--session-id", sessionId, prompt];
  const env: NodeJS.ProcessEnv = {
    HOME, USER: process.env.USER ?? "arthur", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb",
    PATH: [join(NODE, ".."), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    TMPDIR: "/tmp/pi-orche/tmp", PI_CODING_AGENT_DIR: AGENT, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    CLIPROXYAPI_BASE_URL: proxy.url, CLIPROXYAPI_API_KEY: agent.apiKey, CLIPROXYAPI_FAST: "0",
  };
  meta.command = { bwrap: args.slice(0, args.indexOf("--")), pi: args.slice(args.indexOf("--") + 1, -1), promptSha256: sha(prompt), env: Object.keys(env).sort() };
  meta.proxy = proxy.url;
  await save();
  try {
    meta.pi = await runGuarded("bwrap", args, { env, stdout: join(armDir, "events.jsonl"), stderr: join(armDir, "stderr.txt"), guardMs: LIMITS.piGuardMs });
  } finally { proxy.child.kill("SIGTERM"); }
  meta.wallMs = meta.pi.endedAt - meta.pi.startedAt;
  // The immutable target: nothing of the snapshot may have changed (untracked scratch files are listed, not removed).
  meta.targetStatusAfter = git(target.dir, ["status", "--porcelain=v1", "--untracked-files=all"]).toString().split("\n").filter(Boolean);
  meta.targetTreeAfter = git(target.dir, ["write-tree"]).toString().trim() || undefined;
  meta.audit = auditCalls(join(agent.dir, "orche/records"));
  const sessions = auditCalls(join(agent.dir, "sessions"));
  meta.audit.calls += sessions.calls; meta.audit.hits.push(...sessions.hits);
  meta.wire = existsSync(join(armDir, "wire.jsonl.totals.json")) ? JSON.parse(readFileSync(join(armDir, "wire.jsonl.totals.json"), "utf8")) : undefined;
  meta.secrets = agent.secrets.map(secret => sha(secret).slice(0, 8));
  await save();
  // Evidence into the workspace results (gitignored); credentials stay in the scratch agent dir only.
  const results = join(REPO, "results/mdsd-ab", runDir.split("/").at(-1)!, id);
  await mkdir(results, { recursive: true });
  for (const name of ["meta.json", "events.jsonl", "stderr.txt", "wire.jsonl", "wire.jsonl.totals.json", "envelope.json", "prompt.txt"]) if (existsSync(join(armDir, name))) await copyFile(join(armDir, name), join(results, name));
  await cp(join(agent.dir, "orche/records"), join(results, "records"), { recursive: true }).catch(() => undefined);
  await cp(join(agent.dir, "sessions"), join(results, "sessions"), { recursive: true }).catch(() => undefined);
  const scratchFiles = filesUnder(scratch, /^mdsd-.*\.(md|json)$/);
  for (const file of scratchFiles) { await mkdir(join(results, "rounds"), { recursive: true }); await copyFile(file, join(results, "rounds", file.split("/").at(-1)!)); }
  for (const file of filesUnder(results, /\.(json|jsonl|txt|md)$/)) {
    const text = readFileSync(file, "utf8");
    if (agent.secrets.some(secret => secret && text.includes(secret))) await writeFile(file, agent.secrets.reduce((acc, secret) => secret ? acc.split(secret).join("[REDACTED]") : acc, text));
  }
  console.log(`ARM ${id}: exit ${meta.pi.code}${meta.pi.signal ? ` ${meta.pi.signal}` : ""}${meta.pi.guardFired ? " (guard)" : ""}, ${Math.round(meta.wallMs / 1000)} s, ${meta.wire?.requests ?? "?"} requests, $${meta.wire?.costUSD ?? "?"}, audit hits ${meta.audit.hits.length}, target changes ${meta.targetStatusAfter.length}`);
}

// ---- summary ----------------------------------------------------------------------------------------------------------------
export function taskRuns(root: string): any[] {
  return filesUnder(root, /^run\.json$/).flatMap(file => { try { const run = JSON.parse(readFileSync(file, "utf8")); return run.kind === "task" ? [{ file: file.slice(root.length + 1), run }] : []; } catch { return []; } });
}
async function summarize(runDir: string, toy: boolean): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const armName of ["strong", "mdsd"]) {
    const id = `${armName}${toy ? "-toy" : ""}`;
    const dir = join(REPO, "results/mdsd-ab", runDir.split("/").at(-1)!, id);
    if (!existsSync(join(dir, "meta.json"))) continue;
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const wire = readJsonl(join(dir, "wire.jsonl")).filter(entry => entry.method === "POST" && entry.model);
    const runs = taskRuns(join(dir, "records"));
    let finalText = "";
    for (const event of readJsonl(join(dir, "events.jsonl"))) {
      const message = event?.message;
      if (event?.type === "message_end" && message?.role === "assistant" && Array.isArray(message.content)) { const text = message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(""); if (text.trim()) finalText = text; }
    }
    out[id] = {
      wallMs: meta.wallMs, exit: meta.pi?.code, guardFired: meta.pi?.guardFired, audit: meta.audit?.hits?.length, auditCalls: meta.audit?.calls, targetChanges: meta.targetStatusAfter,
      wire: { ...meta.wire, models: [...new Set(wire.map(entry => `${entry.model}@${entry.effort}`))], respModels: [...new Set(wire.map(entry => entry.finalModel ?? entry.respModel).filter(Boolean))], statuses: wire.reduce((acc: Record<string, number>, entry) => { acc[entry.status] = (acc[entry.status] ?? 0) + 1; return acc; }, {}) },
      tasks: runs.map(({ file, run }) => ({ file, status: run.outcome?.status ?? run.status, mode: run.assignment?.mode, model: run.assignment?.model, thinking: run.assignment?.thinking, requests: run.outcome?.requests, costUSD: run.outcome?.costUSD, durationMs: run.durationMs ?? run.outcome?.durationMs, start: run.start, end: run.end, spawned: run.outcome?.spawned?.length, mdsd: run.outcome?.mdsd ? { rounds: run.outcome.mdsd.rounds, strategies: run.outcome.mdsd.strategies, gate: run.outcome.mdsd.gate, findings: run.outcome.mdsd.findings, budget: run.outcome.mdsd.budget, redundancy: run.outcome.mdsd.redundancy } : undefined })),
      finalTextChars: finalText.length,
    };
    await writeFile(join(dir, "final-text.md"), finalText);
  }
  const file = join(REPO, "results/mdsd-ab", runDir.split("/").at(-1)!, `summary${toy ? "-toy" : ""}.json`);
  await write(file, out);
  console.log(JSON.stringify(out, null, 1).slice(0, 6000));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, runDir, armName] = process.argv.slice(2);
  const toy = process.argv.includes("--toy");
  if (!runDir) throw new Error("usage: run.ts prepare|arm|summarize <runDir> [arm] [--toy]");
  if (command === "prepare") await prepare(runDir);
  else if (command === "arm") await arm(runDir, armName ?? "", toy);
  else if (command === "summarize") await summarize(runDir, toy);
  else throw new Error(`unknown command ${command}`);
  process.exit(0);
}
void statSync;
