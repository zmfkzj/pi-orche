/**
 * Environment of the cb-ab study (results/cb-ab/PROTOCOL.md "Conditions"): the frozen inputs of a study directory (orche runtime from
 * `git archive HEAD`, the CLIProxyAPI provider package, the harness itself, the catalog), the per-unit target and Python wrappers, the
 * private agent dir and the bubblewrap sandbox. The layout is experiments/mdsd-ab/run.ts's (sandboxArgs, agentDir) and
 * experiments/ultra-ab/env.ts's (pythonWrappers, rootAnchors), adapted: SWE target + read-only venv as in experiments/mdsd-ab/quality.ts,
 * Sol/high settings, no stored provider login, a private /tmp and PID namespace.
 *
 * Runs from the repository (live) or from a study's frozen copy (<study>/harness, found by its harness.json, which names the repository).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogEntries, filesUnder, sha } from "../mdsd-ab/run.js";
import { MODEL, MODEL_REF, THINKING, orcheConfig } from "./protocol.js";

export const HOME = homedir();
export const AGENT = join(HOME, ".pi/agent");
export const NODE = process.execPath;
export const PI_CLI = join(HOME, ".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
/** The CLIProxyAPI provider package as the user's Pi loads it (bundled by the umbrella package); frozen into the study. */
export const PROVIDER_PKG = join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
/** In-sandbox mounts (read-only unless said otherwise). */
export const PROVIDER_MOUNT = join(HOME, ".local/share/cliproxyapi-provider");
export const RUNTIME_MOUNT = join(HOME, ".local/share/orche-runtime");
export const BIN_MOUNT = join(HOME, ".local/bin");
/** The unit's scratch (read-write); orche's scratch and TMPDIR live below it. */
export const SCRATCH_MOUNT = "/tmp/pi-orche";
export const SANDBOX_TMP = "/tmp/pi-orche/tmp";
export const targetMount = (projectDir: string) => join(HOME, "Code", projectDir);
export const venvMount = (projectDir: string) => join(HOME, ".venvs", projectDir);
/** The commit PROTOCOL.md names for the runtime (recorded next to the HEAD actually frozen). */
export const PROTOCOL_HEAD = "7bbd66b";

const SELF_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
export const HARNESS_FILE = "harness.json";
/** The study harness copy this module runs from (<study>/harness), or undefined when it runs from the repository itself. */
export const FROZEN_ROOT: string | undefined = existsSync(join(SELF_ROOT, HARNESS_FILE)) ? SELF_ROOT : undefined;
/** The orche repository (the frozen copy reads it from its harness.json). */
export const REPO: string = FROZEN_ROOT ? String(JSON.parse(readFileSync(join(FROZEN_ROOT, HARNESS_FILE), "utf8")).repo) : SELF_ROOT;
export const SWE_CACHE = join(REPO, "results/advisor-reviewer/cache/swe");
export const HARNESS_ENTRY = "experiments/cb-ab/run.ts";

export const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 1024 });

/** sha256 of every regular file (and symlink target) below `root`, by relative path; `skip` names top-level entries to leave out. */
export function hashTree(root: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name, path = join(dir, entry.name);
      if (!rel && skip.includes(entry.name)) continue;
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isSymbolicLink()) out[name] = sha(`symlink:${readlinkSync(path)}`);
      else if (entry.isFile()) out[name] = sha(readFileSync(path));
    }
  };
  walk(root, "");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
/** One digest over a path → sha256 map (sorted `path\0sha\n` lines). */
export const digestOf = (files: Record<string, string>) => sha(Object.keys(files).sort().map(path => `${path}\0${files[path]}\n`).join(""));

// ---- frozen inputs (prepare) -------------------------------------------------------------------------------------------------------

export const RUNTIME_PATHS = ["src", "package.json", "tsconfig.json"] as const;
/**
 * orche exactly as committed at HEAD: `git archive <HEAD> -- src package.json tsconfig.json` extracted into `dir`, so no uncommitted
 * working-tree change can enter; every file hashed from the EXTRACTED bytes and checked against HEAD's tree listing.
 * `node_modules` is created empty (the sandbox mounts the workspace's node_modules there, read-only).
 */
export function freezeRuntime(repo: string, dir: string): { head: string; digest: string; files: Record<string, string> } {
  if (existsSync(dir)) throw new Error(`${dir} exists: a runtime is frozen once`);
  const head = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();
  const listed = git(repo, ["ls-tree", "-r", "-z", "--name-only", head, "--", ...RUNTIME_PATHS]).toString().split("\0").filter(Boolean).sort();
  mkdirSync(dir, { recursive: true });
  const archive = git(repo, ["archive", "--format=tar", head, "--", ...RUNTIME_PATHS]);
  execFileSync("tar", ["-x", "-C", dir], { input: archive, maxBuffer: 64 * 1024 * 1024 });
  const files = hashTree(dir);
  const got = Object.keys(files);
  if (got.length !== listed.length || got.some((path, index) => path !== listed[index])) throw new Error(`the archive's files differ from HEAD's tree (${got.length} extracted, ${listed.length} listed)`);
  mkdirSync(join(dir, "node_modules"));
  const revision = { source: "git archive HEAD", head, files, digest: digestOf(files), frozenAt: new Date().toISOString() };
  writeJson(join(dir, "REVISION.json"), revision);
  return { head, digest: revision.digest, files };
}

/** A copy of the CLIProxyAPI provider package with its tree digest (copied bytes). */
export function copyProvider(source: string, dir: string): { version: string; digest: string; files: number } {
  if (existsSync(dir)) throw new Error(`${dir} exists`);
  cpSync(source, dir, { recursive: true, dereference: true });
  const files = hashTree(dir);
  return { version: String(readJson(join(dir, "package.json")).version), digest: digestOf(files), files: Object.keys(files).length };
}

/** Relative module references of a source text: static/dynamic imports and re-exports, plus quoted `.mjs` scripts a file spawns. */
export function references(text: string): { imports: string[]; scripts: string[] } {
  const imports = new Set<string>(), scripts = new Set<string>();
  for (const pattern of [/\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g]) for (const match of text.matchAll(pattern)) if (match[1]!.startsWith(".")) imports.add(match[1]!);
  for (const match of text.matchAll(/["'`]((?:\.{1,2}\/)?[\w./-]+\.mjs)["'`]/g)) scripts.add(match[1]!);
  return { imports: [...imports], scripts: [...scripts] };
}

/**
 * The harness: every experiments/cb-ab/*.ts and every experiments file they import (transitively) or spawn as a sibling `.mjs` script
 * (mdsd-ab/run.ts's startProxy runs proxy.mjs next to itself). A relative import outside experiments/ is refused: the copy must run on
 * its own (node builtins and packages only).
 */
export function harnessFiles(repo: string): string[] {
  const roots = readdirSync(join(repo, "experiments/cb-ab")).filter(name => name.endsWith(".ts")).sort().map(name => `experiments/cb-ab/${name}`);
  const seen = new Set<string>(), queue = [...roots];
  const inside = (rel: string) => rel.startsWith("experiments/") && !rel.split("/").includes("..");
  while (queue.length) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = readFileSync(join(repo, rel), "utf8");
    const { imports, scripts } = references(text);
    for (const spec of imports) {
      const base = normalize(join(dirname(rel), spec));
      const found = [base.replace(/\.js$/, ".ts"), base, `${base}.ts`].find(candidate => existsSync(join(repo, candidate)) && statSync(join(repo, candidate)).isFile());
      if (!found) throw new Error(`${rel}: import ${spec} does not resolve`);
      if (!inside(found)) throw new Error(`${rel}: import ${spec} resolves outside experiments/ (${found}); the harness copy must run on its own`);
      queue.push(found);
    }
    for (const script of scripts) {
      const found = normalize(join(dirname(rel), script));
      if (inside(found) && existsSync(join(repo, found))) queue.push(found);
    }
  }
  return [...seen].sort();
}

/**
 * Copy the harness into `dir` keeping the relative layout, plus a package.json marking it an ES module tree (so the copy runs the same
 * wherever the study lives); harness.json hashes every file from the DESTINATION bytes.
 */
export function freezeHarness(repo: string, dir: string): { digest: string; files: Record<string, string> } {
  if (existsSync(dir)) throw new Error(`${dir} exists: a harness is frozen once`);
  const list = harnessFiles(repo);
  const files: Record<string, string> = {};
  for (const rel of list) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    copyFileSync(join(repo, rel), join(dir, rel));
    files[rel] = sha(readFileSync(join(dir, rel)));
    if (files[rel] !== sha(readFileSync(join(repo, rel)))) throw new Error(`${rel} changed while it was copied`);
  }
  writeJson(join(dir, "package.json"), { name: "cb-ab-harness", private: true, type: "module" });
  files["package.json"] = sha(readFileSync(join(dir, "package.json")));
  const digest = digestOf(files);
  writeJson(join(dir, HARNESS_FILE), { repo, entry: HARNESS_ENTRY, files, digest, frozenAt: new Date().toISOString() });
  return { digest, files };
}

/** Re-hash a frozen harness (destination bytes) against its harness.json; the list of differing files (empty = intact). */
export function harnessIntact(dir: string): string[] {
  const manifest = readJson(join(dir, HARNESS_FILE));
  return Object.entries(manifest.files as Record<string, string>).filter(([rel, digest]) => !existsSync(join(dir, rel)) || sha(readFileSync(join(dir, rel))) !== digest).map(([rel]) => rel);
}

/** The model's catalog entry and list prices; the effort `high` must map to `high`. */
export function catalogEntry(catalogFile: string): { entry: any; prices: Record<string, unknown>; sha256: string } {
  const bytes = readFileSync(catalogFile);
  const entry = catalogEntries(JSON.parse(bytes.toString("utf8"))).find((item: any) => item?.id === MODEL.id);
  if (!entry) throw new Error(`${MODEL.id} is not in the CLIProxyAPI catalog ${catalogFile}`);
  if (entry.thinkingLevelMap?.high !== THINKING) throw new Error(`${MODEL.id}: thinking ${THINKING} is not mapped to effort ${THINKING} (${JSON.stringify(entry.thinkingLevelMap)})`);
  if (!entry.cost || typeof entry.cost.input !== "number" || typeof entry.cost.output !== "number") throw new Error(`${MODEL.id}: no list prices in the catalog`);
  return { entry, prices: { [MODEL.id]: entry.cost }, sha256: sha(bytes) };
}

// ---- cases -------------------------------------------------------------------------------------------------------------------------

/** case.json of a case directory. `source`/`venv` (repository-relative or absolute) default to the SWE cache of `task`. */
export interface CaseSpec { id: string; order: number; task: string; repo: string; baseCommit: string; projectDir: string; pythonPath: string; prompt: string; promptSha256: string; source?: string; venv?: string }
export interface LoadedCase extends CaseSpec { dir: string; file: string; sha256: string; sourceDir: string; venvDir: string }
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function loadCase(caseDir: string, repo = REPO): LoadedCase {
  const dir = resolve(caseDir), file = join(dir, "case.json");
  const bytes = readFileSync(file);
  const spec = JSON.parse(bytes.toString("utf8")) as CaseSpec;
  for (const key of ["id", "task", "repo", "baseCommit", "projectDir", "pythonPath", "prompt", "promptSha256"] as const) if (typeof spec[key] !== "string" || !spec[key]) throw new Error(`${file}: ${key} must be a non-empty string`);
  if (!Number.isSafeInteger(spec.order) || spec.order < 1) throw new Error(`${file}: order must be a positive integer`);
  if (!SAFE.test(spec.id) || !SAFE.test(spec.projectDir)) throw new Error(`${file}: id and projectDir must be plain names`);
  if (spec.pythonPath.startsWith("/") || spec.pythonPath.split("/").includes("..")) throw new Error(`${file}: pythonPath must be project-relative`);
  if (sha(spec.prompt) !== spec.promptSha256) throw new Error(`${file}: promptSha256 does not match the prompt (${sha(spec.prompt).slice(0, 12)})`);
  const at = (path: string | undefined, fallback: string) => path ? resolve(repo, path) : fallback;
  const sourceDir = at(spec.source, join(repo, "results/advisor-reviewer/cache/swe", spec.task, "src"));
  const venvDir = at(spec.venv, join(repo, "results/advisor-reviewer/cache/swe", spec.task, "venv"));
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) throw new Error(`${file}: no source snapshot at ${sourceDir}`);
  if (!existsSync(join(venvDir, "bin/python"))) throw new Error(`${file}: no virtualenv at ${venvDir}`);
  return { ...spec, dir, file, sha256: sha(bytes), sourceDir, venvDir };
}

// ---- one unit's environment --------------------------------------------------------------------------------------------------------

/** A fresh plain-directory copy of the snapshot: no `.git` anywhere, no repository, no commit; symlinks kept as written (never resolved to source paths). */
export function makeTarget(source: string, dir: string): void {
  if (existsSync(dir)) throw new Error(`${dir} exists`);
  cpSync(source, dir, { recursive: true, verbatimSymlinks: true, filter: path => basename(path) !== ".git" });
}

/**
 * Root anchors of the project (experiments/ultra-ab/env.ts): pyproject.toml / setup.py / setup.cfg when the snapshot root has them,
 * else every regular file of the snapshot root.
 */
export function rootAnchors(source: string): string[] {
  const files = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).filter(name => /^[A-Za-z0-9._-]+$/.test(name)).sort();
  const standard = files.filter(name => ["pyproject.toml", "setup.py", "setup.cfg"].includes(name));
  return standard.length ? standard : files;
}

/**
 * `python`, `python3`, `pytest` wrappers (experiments/ultra-ab/env.ts pythonWrappers, in-sandbox paths): the task's read-only venv with
 * PYTHONPATH = the nearest project root at or above $PWD (+ pythonPath), else the target mount, and PYTHONDONTWRITEBYTECODE=1;
 * `pip`/`pip3` refuse.
 */
export function pythonWrappers(binDir: string, options: { venv: string; fallbackRoot: string; anchors: readonly string[]; pythonPath: string; binMount?: string }): void {
  const sub = options.pythonPath && options.pythonPath !== "." ? `/${options.pythonPath.replace(/^\.\/|\/$/g, "")}` : "";
  mkdirSync(binDir, { recursive: true });
  const python = [
    "#!/bin/sh",
    'root="$PWD"',
    `anchored() { for f in ${options.anchors.join(" ")}; do [ -e "$1/$f" ] && return 0; done; return 1; }`,
    'while [ "$root" != "/" ] && ! anchored "$root"; do root=$(dirname "$root"); done',
    `[ "$root" = "/" ] && root='${options.fallbackRoot}'`,
    `export PYTHONPATH="$root${sub}\${PYTHONPATH:+:$PYTHONPATH}"`,
    "export PYTHONDONTWRITEBYTECODE=1",
    `exec '${options.venv}/bin/python' "$@"`,
    "",
  ].join("\n");
  for (const name of ["python", "python3"]) writeFileSync(join(binDir, name), python);
  writeFileSync(join(binDir, "pytest"), `#!/bin/sh\nexec '${join(options.binMount ?? BIN_MOUNT, "python")}' -m pytest "$@"\n`);
  const refuse = "#!/bin/sh\necho \"pip is disabled in this environment: dependencies are preinstalled and there is no network.\" >&2\nexit 1\n";
  for (const name of ["pip", "pip3"]) writeFileSync(join(binDir, name), refuse);
  for (const name of ["python", "python3", "pytest", "pip", "pip3"]) chmodSync(join(binDir, name), 0o755);
}

/**
 * Every credential string of the user's agent dir (the provider API key, the stored logins), for redaction and checks only; never
 * written anywhere.
 */
export function liveSecrets(live = AGENT): string[] {
  const strings = (value: unknown): string[] => typeof value === "string" ? (value.length > 12 ? [value] : []) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const connection = existsSync(join(live, "cliproxyapi.json")) ? readJson(join(live, "cliproxyapi.json")) : {};
  const auth = existsSync(join(live, "auth.json")) ? readJson(join(live, "auth.json")) : {};
  return [...new Set([String(connection.apiKey ?? ""), ...strings(auth)].filter(secret => secret.length >= 8))];
}

/**
 * The private agent dir of one unit (experiments/mdsd-ab/run.ts agentDir): the frozen catalog, the provider connection pointed at the
 * unit's proxy WITHOUT its API key, NO stored login (the provider takes CLIPROXYAPI_API_KEY and CLIPROXYAPI_BASE_URL from the
 * environment first), Sol/high settings and protocol.ts orcheConfig(). No credential is ever written to disk.
 */
export function agentDir(unitDir: string, catalogDir: string, proxyUrl: string, live = AGENT): { dir: string; apiKey: string; secrets: string[] } {
  const dir = join(unitDir, "agent");
  mkdirSync(join(dir, "sessions"), { recursive: true, mode: 0o700 });
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(catalogDir, name))) copyFileSync(join(catalogDir, name), join(dir, name));
  const { apiKey, ...connection } = readJson(join(live, "cliproxyapi.json"));
  writeFileSync(join(dir, "cliproxyapi.json"), JSON.stringify({ ...connection, baseUrl: proxyUrl }), { mode: 0o600 });
  writeFileSync(join(dir, "auth.json"), "{}", { mode: 0o600 });
  writeJson(join(dir, "settings.json"), { defaultProvider: MODEL.provider, defaultModel: MODEL.id, defaultThinkingLevel: THINKING, quietStartup: true, transport: "sse" });
  writeJson(join(dir, "orche.config.json"), orcheConfig());
  return { dir, apiKey: String(apiKey ?? ""), secrets: liveSecrets(live) };
}

export interface SandboxPaths { agent: string; target: string; projectDir: string; venv: string; runtime: string; nodeModules: string; provider: string; scratch: string; bin: string }
/**
 * bubblewrap (experiments/mdsd-ab/run.ts sandboxArgs, adapted): the host root with a private PID namespace and /proc, a private /tmp,
 * the whole home replaced by an empty tmpfs, plus the read-only toolchain (~/.nvm, ~/.bun), provider, runtime (+ the workspace
 * node_modules), wrappers and venv, and the private agent dir, target and scratch.
 */
export function sandboxArgs(paths: SandboxPaths): string[] {
  const nm = paths.nodeModules;
  const caches = [".cache", ".vite", ".vite-temp"].filter(name => existsSync(join(nm, name))).flatMap(name => ["--tmpfs", join(RUNTIME_MOUNT, "node_modules", name)]);
  const target = targetMount(paths.projectDir);
  return [
    "--dev-bind", "/", "/", "--die-with-parent", "--unshare-pid", "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", HOME,
    "--ro-bind", join(HOME, ".nvm"), join(HOME, ".nvm"),
    "--ro-bind", join(HOME, ".bun"), join(HOME, ".bun"),
    "--bind", paths.agent, AGENT,
    "--ro-bind", paths.provider, PROVIDER_MOUNT,
    "--ro-bind", paths.runtime, RUNTIME_MOUNT,
    "--ro-bind", nm, join(RUNTIME_MOUNT, "node_modules"), ...caches,
    "--ro-bind", paths.bin, BIN_MOUNT,
    "--ro-bind", paths.venv, venvMount(paths.projectDir),
    "--bind", paths.target, target,
    "--bind", paths.scratch, SCRATCH_MOUNT,
    "--chdir", target,
  ];
}

/**
 * How a unit starts bubblewrap: the arguments go through a file descriptor (`bwrap --args 3`, NUL-separated, written to `argsFile`), so
 * the sandbox's own process list (/proc/1/cmdline) shows no host path (study, unit, case directories); /bin/sh only opens the file and
 * execs bwrap (same pid, so the process group and --die-with-parent are bwrap's).
 */
export function sandboxCommand(box: readonly string[], argsFile: string, command: readonly string[]): { command: string; args: string[] } {
  writeFileSync(argsFile, box.map(arg => `${arg}\0`).join(""));
  return { command: "/bin/sh", args: ["-c", 'exec bwrap --args 3 "$@" 3<"$0"', argsFile, "--", ...command] };
}

/** The environment of the sandboxed Pi (experiments/mdsd-ab/matrix.ts sandboxEnv + the wrappers first on PATH). */
export function sandboxEnv(proxyUrl: string, apiKey: string): NodeJS.ProcessEnv {
  return {
    HOME, USER: process.env.USER ?? "arthur", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb",
    PATH: [BIN_MOUNT, dirname(NODE), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    TMPDIR: SANDBOX_TMP, PI_CODING_AGENT_DIR: AGENT, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    CLIPROXYAPI_BASE_URL: proxyUrl, CLIPROXYAPI_API_KEY: apiKey, CLIPROXYAPI_FAST: "0",
  };
}

/** The Pi command of a unit (experiments/mdsd-ab/matrix.ts piArgs): provider + frozen orche only, Sol/high, JSON mode, its own session id. */
export const piArgs = (sessionId: string, prompt: string): string[] => [NODE, PI_CLI, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve",
  "-e", join(PROVIDER_MOUNT, "extensions/index.ts"), "-e", join(RUNTIME_MOUNT, "src/extension/index.ts"),
  "--model", MODEL_REF, "--thinking", THINKING, "--mode", "json", "--session-id", sessionId, prompt];

/** Repository-relative path when inside the repository (for records), else absolute. */
export const display = (path: string) => { const rel = relative(REPO, path); return rel && !rel.startsWith("..") ? rel : path; };

/** Every file below `root` (for pruning and listings). */
export const allFiles = (root: string) => filesUnder(root, /./);

/** A unit's evidence directory: <study>/runs/<caseId>/<arm>/r<repeat>. */
export const unitDir = (study: string, caseId: string, arm: string, repeat: number) => join(study, "runs", caseId, arm, `r${repeat}`);
