/**
 * Environment of the ultra-ho harness (experiments/ultra-ho/README.md): frozen orche runtimes (`rt-<name>`), the frozen provider
 * package, task workspaces WITHOUT any commit, the final diff against the initial tree, the private agent dir of a run, the pricing
 * proxy, SWE environment staging and the live-validation task pick.
 *
 * Reused unchanged from the frozen ultra-ab harness: loadTask, pythonWrappers, piEnv, UPSTREAM (experiments/ultra-ab/env.ts);
 * the advisor-reviewer task paths and copy filter. Copied and changed: the runtime freeze (named, destination bytes hashed, never
 * overwritten), the workspace (no commit: `git init` + `git add -A`, initial tree id), the agent dir (this harness's config and
 * settings, no npm link), the provider path (the git-bundled CLIProxyAPI provider, frozen per study), SWE staging (driver.ts there).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUITE_DIR, SWE_DIR, readable } from "../advisor-reviewer/tasks.js";
import { UPSTREAM, loadTask, type Task } from "../ultra-ab/env.js";
import { MODEL, MODEL_REF, THINKING, piSettings, type Plan } from "./protocol.js";

export { UPSTREAM, loadTask, piEnv, pythonWrappers, type Task } from "../ultra-ab/env.js";

export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO = resolve(process.env.ULTRA_HO_REPO ?? fileURLToPath(new URL("../../", import.meta.url)));
export const AGENT = join(homedir(), ".pi/agent");
/** The CLIProxyAPI provider as the user's Pi loads it (bundled by the umbrella package); copied into `<out>/provider` once per study. */
export const PROVIDER_SOURCE = process.env.ULTRA_HO_PROVIDER ?? join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
/** The Pi CLI bundle; run with this process's Node so every unit uses the same interpreter. */
export const PI_CLI = process.env.ULTRA_HO_PI_CLI ?? join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string => execFileSync("git", args, { cwd, ...(env ? { env } : {}), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 }).toString();
/** Whether `path` is `dir` or lies inside it (lexically, both resolved). */
export const isInside = (dir: string, path: string): boolean => { const rel = relative(resolve(dir), resolve(path)); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

// ---------------------------------------------------------------------------------------------------------------------------
// Frozen runtimes

const headOf = (repo: string): string | null => { try { return git(repo, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || null; } catch { return null; } };
/** `head`: the commit HEAD named at the freeze (null on an unborn branch); `dirty`: `git status --porcelain` then. */
export interface Revision { name: string; source: string; head: string | null; dirty: string[]; files: Record<string, string>; fileCount: number; digest: string; frozenAt: string; sourceDiffers?: string[] }
export const runtimeDir = (out: string, name: string): string => join(out, `rt-${name}`);
const digestOf = (files: Record<string, string>): string => { const hash = createHash("sha256"); for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path]}\n`); return hash.digest("hex"); };

/**
 * Freeze orche as it is in the working tree NOW (HEAD plus every uncommitted change): src/, package.json, tsconfig.json (tracked and
 * untracked, not ignored) are copied into `<out>/rt-<name>` with node_modules linked. REVISION.json records HEAD, the dirty list
 * (`git status --porcelain`), the sha256 of every file as COPIED (the destination bytes: what the units run) and their digest, and
 * `sourceDiffers` when a source file no longer matched its copy right after copying (edited during the freeze). An existing
 * `rt-<name>` is never overwritten; the copy is made beside it and renamed into place only when complete.
 */
export async function freezeRuntime(out: string, name: string, options: { repo?: string; copy?: (from: string, to: string) => Promise<void> } = {}): Promise<{ dir: string; revision: Revision }> {
  if (!NAME.test(name)) throw new Error(`runtime name ${JSON.stringify(name)}: expected [A-Za-z0-9._-]`);
  const repo = resolve(options.repo ?? REPO);
  const dir = runtimeDir(out, name);
  if (existsSync(dir)) throw new Error(`${dir} exists: a frozen runtime is never overwritten (freeze under another name)`);
  await mkdir(out, { recursive: true });
  const staging = await mkdtemp(join(out, `.rt-${name}.partial-`));
  try {
    const listed = git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src", "package.json", "tsconfig.json"]).split("\0").filter(Boolean);
    const paths = [...new Set(listed)].filter(path => { try { return statSync(join(repo, path)).isFile(); } catch { return false; } }).sort();
    const copy = options.copy ?? ((from: string, to: string) => copyFile(from, to));
    for (const path of paths) { await mkdir(dirname(join(staging, path)), { recursive: true }); await copy(join(repo, path), join(staging, path)); }
    const files: Record<string, string> = {};
    const sourceDiffers: string[] = [];
    for (const path of paths) {
      files[path] = sha256(readFileSync(join(staging, path)));
      let source: string | undefined;
      try { source = sha256(readFileSync(join(repo, path))); } catch { /* removed meanwhile */ }
      if (source !== files[path]) sourceDiffers.push(path);
    }
    await symlink(join(repo, "node_modules"), join(staging, "node_modules"), "dir");
    const revision: Revision = {
      name, source: repo, head: headOf(repo), dirty: git(repo, ["status", "--porcelain=v1"]).split("\n").filter(Boolean),
      files, fileCount: paths.length, digest: digestOf(files), frozenAt: new Date().toISOString(), ...(sourceDiffers.length ? { sourceDiffers } : {}),
    };
    await writeFile(join(staging, "REVISION.json"), `${JSON.stringify(revision, null, 2)}\n`);
    if (existsSync(dir)) throw new Error(`${dir} appeared while freezing: not overwritten`);
    await rename(staging, dir);
    return { dir, revision };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function readRevision(dir: string): Revision {
  return JSON.parse(readFileSync(join(dir, "REVISION.json"), "utf8")) as Revision;
}

/** Files of a frozen runtime that are missing or no longer have their recorded bytes (empty: intact). */
export function verifyRuntime(dir: string): string[] {
  const revision = readRevision(dir);
  const bad: string[] = [];
  for (const [path, hash] of Object.entries(revision.files)) {
    let now: string | undefined;
    try { now = sha256(readFileSync(join(dir, path))); } catch { /* missing */ }
    if (now !== hash) bad.push(now === undefined ? `${path} (missing)` : path);
  }
  if (digestOf(revision.files) !== revision.digest) bad.push("REVISION.json digest");
  return bad;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Provider (frozen per study)

export interface ProviderFreeze { dir: string; source: string; version?: string; digest: string; files: number; frozenAt: string }

function treeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile()) out.push(path); } };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** The provider package copied into `<out>/provider` at the first launch (FROZEN.json: source, version, digest); later launches reuse it. */
export async function freezeProvider(out: string, source = PROVIDER_SOURCE): Promise<ProviderFreeze> {
  const dir = join(out, "provider");
  if (existsSync(join(dir, "FROZEN.json"))) return { ...JSON.parse(readFileSync(join(dir, "FROZEN.json"), "utf8")), dir } as ProviderFreeze;
  if (!existsSync(join(source, "extensions/index.ts"))) throw new Error(`no CLIProxyAPI provider at ${source} (set ULTRA_HO_PROVIDER)`);
  if (existsSync(dir)) throw new Error(`${dir} exists without FROZEN.json: remove it or use a fresh out directory`);
  const staging = await mkdtemp(join(out, ".provider.partial-"));
  try {
    await cp(source, staging, { recursive: true, filter: path => !/\/(node_modules|\.git)$/.test(path) });
    const hash = createHash("sha256");
    const files = treeFiles(staging);
    for (const file of files) hash.update(`${relative(staging, file)}\0${sha256(readFileSync(file))}\n`);
    let version: string | undefined;
    try { version = JSON.parse(readFileSync(join(staging, "package.json"), "utf8")).version; } catch { /* unversioned */ }
    const frozen = { source, ...(version ? { version } : {}), digest: hash.digest("hex"), files: files.length, frozenAt: new Date().toISOString() };
    await writeFile(join(staging, "FROZEN.json"), `${JSON.stringify(frozen, null, 2)}\n`);
    await rename(staging, dir);
    return { ...frozen, dir };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Workspace: no commit anywhere

/** Paths that are never part of a solution: orche's spill artifacts, dependency installs and Python caches. */
export const DIFF_EXCLUDES = [":(exclude).orche", ":(exclude,glob)**/node_modules/**", ":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/.pytest_cache/**"];
const COPY_SKIP = /\/(\.git|\.orche|node_modules|__pycache__|\.pytest_cache)$/;

/**
 * A fresh workspace with only the visible files: `git init` and `git add -A` (an unborn branch: NO commit; orche works on it,
 * src/orchestration/workspace.ts), and the initial tree id from `git write-tree` (a tree object, not a commit).
 */
export async function prepareWorkspace(task: { source: string }, parent: string): Promise<{ dir: string; tree: string }> {
  const dir = await mkdtemp(join(parent, "ws-"));
  await cp(task.source, dir, { recursive: true, filter: path => !/\/\.git$/.test(path) });
  git(dir, ["init", "--quiet"]);
  git(dir, ["add", "-A"]);
  return { dir, tree: git(dir, ["write-tree"]).trim() };
}

/**
 * The final state of a workspace as a tree (a private index started from the initial tree, so the workspace's own index stays as
 * the run left it and files ignored later stay tracked), and the diff against the initial tree (binary-safe; DIFF_EXCLUDES apart).
 */
export function finalDiff(workspace: string, initialTree: string, scratch: string): { tree: string; diff: Buffer; stat: string; files: string[] } {
  const index = join(scratch, `final-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(workspace, ["read-tree", initialTree], env);
    git(workspace, ["add", "-A", "--", ".", ...DIFF_EXCLUDES], env);
    const tree = git(workspace, ["write-tree"], env).trim();
    const diff = execFileSync("git", ["diff", "--binary", initialTree, tree], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
    const stat = git(workspace, ["diff", "--stat", initialTree, tree]);
    const files = git(workspace, ["diff", "--name-status", initialTree, tree]).split("\n").filter(Boolean);
    return { tree, diff, stat, files };
  } finally { rmSync(index, { force: true }); }
}

/** Commits in a workspace (the protocol makes none; an agent that commits anyway shows up here). */
export function commitsOf(workspace: string): { head: string | null; count: number } {
  let head: string | null = null, count = 0;
  try { head = git(workspace, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || null; } catch { head = null; }
  try { count = Number(git(workspace, ["rev-list", "--all", "--count"]).trim()) || 0; } catch { count = 0; }
  return { head, count };
}

/** The final workspace as evidence (no .git, .orche, dependency installs or caches). */
export async function preserveWorkspace(workspace: string, target: string): Promise<void> {
  await cp(workspace, target, { recursive: true, filter: path => !COPY_SKIP.test(path) && readable(path) });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Private agent dir, pricing proxy, Pi command

/** The catalog entry of the route and the catalog's hash (list prices for the proxy). */
export function catalogInfo(agent = AGENT): { sha256: string; entry: Record<string, unknown> & { cost?: unknown } } {
  const raw = readFileSync(join(agent, "cliproxyapi-models.json"));
  const parsed = JSON.parse(raw.toString());
  const entries: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : Object.values(parsed ?? {});
  const entry = entries.find(item => item?.id === MODEL.id);
  if (!entry?.cost) throw new Error(`no catalog price for ${MODEL.id} in ${join(agent, "cliproxyapi-models.json")}`);
  return { sha256: sha256(raw), entry };
}

/**
 * The private agent dir of one run: the provider catalog and connection (base URL = this run's proxy; nothing else of the user's
 * agent dir: no auth.json, no packages), this harness's settings and orche config.
 */
export async function overlay(dir: string, proxyUrl: string, config: Record<string, unknown>, agent = AGENT): Promise<{ apiKey: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(agent, name))) await copyFile(join(agent, name), join(dir, name));
  const connection = JSON.parse(await readFile(join(agent, "cliproxyapi.json"), "utf8"));
  await writeFile(join(dir, "cliproxyapi.json"), JSON.stringify({ ...connection, baseUrl: proxyUrl }), { mode: 0o600 });
  await writeFile(join(dir, "settings.json"), `${JSON.stringify(piSettings(), null, 2)}\n`);
  await writeFile(join(dir, "orche.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return { apiKey: String(connection.apiKey ?? "") };
}

/**
 * Where the proxy forwards: the real CLIProxyAPI. `ULTRA_HO_UPSTREAM` replaces it only for a model-free dry run of the plumbing (e.g.
 * a closed port: every model request fails before reaching any model); each unit records the upstream it used (meta.upstream).
 */
export const upstream = (): string => process.env.ULTRA_HO_UPSTREAM ?? UPSTREAM;

/** Start this run's pricing proxy (./proxy.mjs, a copy of experiments/mdsd-ab/proxy.mjs; envelope without a cap); resolves with its URL. */
export function startProxy(wireLog: string, envelope: string): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [join(HERE, "proxy.mjs"), "0", upstream(), wireLog, envelope], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`proxy did not start: ${text}`)); }, 15_000);
    child.stdout!.on("data", chunk => { text += String(chunk); const match = /PORT (\d+)/.exec(text); if (match) { clearTimeout(timer); resolveStart({ url: `http://127.0.0.1:${match[1]}`, child }); } });
    child.stderr!.on("data", chunk => { text += String(chunk); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`proxy exited ${code}: ${text}`)); });
  });
}

/** Pi's arguments: no user extensions, skills, templates or MCP; the frozen provider and the frozen orche runtime; the route at high. */
export const piArgs = (runtime: string, provider: string, extra: string[]): string[] => [
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve",
  "-e", join(provider, "extensions/index.ts"), "-e", join(runtime, "src/extension/index.ts"),
  "--model", MODEL_REF, "--thinking", THINKING, ...extra,
];

export function piVersion(): string {
  try { return execFileSync(process.execPath, [PI_CLI, "--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString().trim(); } catch (error) { return `unknown (${String(error).slice(0, 200)})`; }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tasks

/** The canonical SWE fixture root and the environment cache it is staged from (repository-relative): the defaults of a plan. */
export const DEFAULT_SWE_FIXTURES = "fixtures/advisor-bench/swe";
export const DEFAULT_SWE_CACHE_SOURCE = "results/advisor-reviewer/cache/swe";

/**
 * A plan's SWE fixture root (tasks: `<fixtures>/<id>/{task.json,hidden,reference}`) and the cache its environments are staged from
 * (`<cacheSource>/<id>/{src,venv}`), absolute; relative plan values are read from the repository. A plan without them: the defaults.
 */
export function sweRoots(plan: Pick<Plan, "sweFixtures" | "sweCacheSource">, repo = REPO): { fixtures: string; cacheSource: string } {
  return { fixtures: resolve(repo, plan.sweFixtures ?? DEFAULT_SWE_FIXTURES), cacheSource: resolve(repo, plan.sweCacheSource ?? DEFAULT_SWE_CACHE_SOURCE) };
}

/** A SWE task of `fixtures` (default: this process's SWE_DIR, the canonical root unless ADVISOR_BENCH_SWE_DIR names another). */
export const isSweTask = (id: string, fixtures: string = SWE_DIR): boolean => existsSync(join(fixtures, id, "task.json"));

/**
 * SWE environments (source snapshot + read-only virtualenv) are copied out of the repository into `plan.sweCache` (scratch), so the
 * paths the agents see (wrappers, venv) do not lead into the repository with its fixtures and earlier results (ultra-ab driver.ts).
 * The tasks come from the plan's fixture root and their environments from its cache source (`sweRoots`).
 */
export async function stageSweCache(plan: Pick<Plan, "tasks" | "sweCache" | "sweFixtures" | "sweCacheSource">, repo = REPO): Promise<string[]> {
  const { fixtures, cacheSource } = sweRoots(plan, repo);
  const swe = plan.tasks.filter(item => item.kind === "swe" || item.kind === undefined && isSweTask(item.task, fixtures)).map(item => item.task);
  if (!swe.length) return [];
  if (!plan.sweCache) throw new Error(`SWE task(s) ${swe.join(", ")} need plan.sweCache (an absolute directory outside the repository)`);
  for (const task of swe) {
    if (existsSync(join(plan.sweCache, task, "venv/.ready"))) continue;
    await mkdir(plan.sweCache, { recursive: true });
    execFileSync("cp", ["-a", join(cacheSource, task), plan.sweCache]);
  }
  return swe;
}

/** Tasks of earlier studies: never used again by the live validation's pick. */
export const EARLIER_TASKS = ["a7-auth-rotation", "d1-transactional-outbox", "d8-build-graph"];

/**
 * The live-validation task rule: the first task in sorted order of fixtures/suite that ultra-ab's loadTask accepts and that no
 * earlier study used (EARLIER_TASKS and every task of experiments/ultra-ab/plans/*.json).
 */
export async function pickLiveTask(repo = REPO): Promise<{ task: string; excluded: string[]; skipped: { task: string; reason: string }[] }> {
  const excluded = new Set(EARLIER_TASKS);
  const plans = join(repo, "experiments/ultra-ab/plans");
  for (const name of existsSync(plans) ? readdirSync(plans).filter(item => item.endsWith(".json")).sort() : []) {
    for (const item of JSON.parse(readFileSync(join(plans, name), "utf8")).tasks ?? []) excluded.add(typeof item === "string" ? item : item.task);
  }
  const skipped: { task: string; reason: string }[] = [];
  for (const name of readdirSync(SUITE_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    if (excluded.has(name)) { skipped.push({ task: name, reason: "used by an earlier study" }); continue; }
    try { await loadTask(name); return { task: name, excluded: [...excluded].sort(), skipped }; }
    catch (error) { skipped.push({ task: name, reason: error instanceof Error ? error.message : String(error) }); }
  }
  throw new Error("no eligible task in fixtures/suite");
}
