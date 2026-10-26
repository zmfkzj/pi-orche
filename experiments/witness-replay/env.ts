/**
 * Paths, staging and the tree helpers of the witness-replay pilot (experiments/witness-replay/README.md).
 * Reused from earlier harnesses: the provider freeze and catalog reading (experiments/ultra-ho/env.ts), the integrity rule,
 * protected-file set and test-file rule (experiments/ultra-ab), unchanged.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyCandidate, sha256, treeDigest } from "./witness-run.js";

export const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const AGENT = join(homedir(), ".pi/agent");
/** The Pi CLI bundle every session runs (with this process's Node); its sha256 is frozen. */
export const PI_CLI = process.env.WITNESS_REPLAY_PI_CLI ?? join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
/** The global node_modules the bundle resolves from (bound read-only into the sandbox). */
export const PI_MODULES = resolve(PI_CLI, "../../../../..");
export const NODE = process.execPath;
export const NODE_DIR = resolve(NODE, "../..");
export const UPSTREAM = process.env.WITNESS_REPLAY_UPSTREAM ?? "http://127.0.0.1:8317";
/** Placeholder key the sandbox sees; the unit proxy substitutes the real one. */
export const PLACEHOLDER_KEY = "witness-replay-placeholder-key";
/** Fixed port of the in-sandbox bridge (the sandbox has its own loopback). */
export const BRIDGE_PORT = 18317;
export const SOCKET_MOUNT = "/run/witness-replay/proxy.sock";
export const PROVIDER_MOUNT = "/opt/witness-replay/provider";
export const BRIDGE_MOUNT = "/opt/witness-replay/bridge.mjs";
export const LAUNCH_MOUNT = "/opt/witness-replay/launch.sh";

export const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string => execFileSync("git", args, { cwd, ...(env ? { env } : {}), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 }).toString();

export interface TaskManifest { id: string; problemStatement: string; interface?: string; testCmd: string; pythonPath?: string; failToPass: string[]; passToPass: unknown; excludedPassToPass?: string[] }
export const taskManifest = (fixtures: string, task: string): TaskManifest => JSON.parse(readFileSync(resolve(REPO, fixtures, task, "task.json"), "utf8"));
export const sourceOf = (cache: string, task: string): string => resolve(REPO, cache, task, "src");
export const venvOf = (cache: string, task: string): string => resolve(REPO, cache, task, "venv");
export const pythonPathOf = (manifest: TaskManifest): string => manifest.pythonPath && manifest.pythonPath !== "." ? manifest.pythonPath : ".";

/** sha256 over a directory tree's files (relative path, size and content); used for venvs and frozen copies. */
export function dirDigest(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "__pycache__") walk(path); }
      else if (entry.isSymbolicLink()) entries.push(`l ${path.slice(root.length)} ${readlinkSafe(path)}`);
      else if (entry.isFile() && !entry.name.endsWith(".pyc")) entries.push(`f ${path.slice(root.length)} ${sha256(readFileSync(path))}`);
    }
  };
  walk(root);
  return sha256(entries.join("\n"));
}
function readlinkSafe(path: string): string { try { return readlinkSync(path); } catch { return "?"; } }

/**
 * A unit workspace: the ORIGINAL snapshot is committed once by the harness (fixed author and date: "original snapshot"; the model
 * is told to make no commits), then the working tree is replaced by the seed's files, so `git status` / `git diff` show exactly
 * the candidate's changes. Returns the original tree id and the workspace's content digest (must equal the frozen seed digest).
 */
export async function stageWorkspace(original: string, seedTree: string, dir: string): Promise<{ originalTree: string; head: string; digest: string }> {
  await mkdir(dir, { recursive: true });
  await copyCandidate(original, dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: "snapshot", GIT_AUTHOR_EMAIL: "snapshot@localhost", GIT_COMMITTER_NAME: "snapshot", GIT_COMMITTER_EMAIL: "snapshot@localhost", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  git(dir, ["init", "--quiet"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "original snapshot"], env);
  const originalTree = git(dir, ["rev-parse", "HEAD^{tree}"]).trim();
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  for (const name of readdirSync(dir)) if (name !== ".git") rmSync(join(dir, name), { recursive: true, force: true });
  await copyCandidate(seedTree, dir);
  return { originalTree, head, digest: treeDigest(dir) };
}

/** The final diff of a workspace against the original tree (a private index; the workspace's own index is left alone). */
export function finalDiff(workspace: string, originalTree: string, scratch: string): { tree: string; diff: Buffer; files: string[] } {
  const index = join(scratch, `final-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(workspace, ["read-tree", originalTree], env);
    git(workspace, ["add", "-A", "--", ".", ":(exclude).orche", ":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/.pytest_cache/**", ":(exclude,glob)**/.hypothesis/**"], env);
    const tree = git(workspace, ["write-tree"], env).trim();
    const diff = execFileSync("git", ["diff", "--binary", originalTree, tree], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
    const files = git(workspace, ["diff", "--name-status", originalTree, tree]).split("\n").filter(Boolean);
    return { tree, diff, files };
  } finally { rmSync(index, { force: true }); }
}

/** Python wrappers (python, python3, pytest; pip refuses) like the earlier harnesses': the CURRENT project first on sys.path. */
export async function pythonWrappers(binDir: string, venv: string, source: string, sub: string, fallbackRoot: string): Promise<void> {
  const files = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).filter(name => /^[A-Za-z0-9._-]+$/.test(name)).sort();
  const standard = files.filter(name => ["pyproject.toml", "setup.py", "setup.cfg"].includes(name));
  const anchors = standard.length ? standard : files;
  const subPath = sub === "." ? "" : `/${sub}`;
  const python = [
    "#!/bin/sh", 'root="$PWD"', `anchored() { for f in ${anchors.join(" ")}; do [ -e "$1/$f" ] && return 0; done; return 1; }`,
    'while [ "$root" != "/" ] && ! anchored "$root"; do root=$(dirname "$root"); done', `[ "$root" = "/" ] && root='${fallbackRoot}'`,
    `export PYTHONPATH="$root${subPath}\${PYTHONPATH:+:$PYTHONPATH}"`, "export PYTHONDONTWRITEBYTECODE=1", `exec '${venv}/bin/python' "$@"`, "",
  ].join("\n");
  await mkdir(binDir, { recursive: true });
  for (const name of ["python", "python3"]) await writeFile(join(binDir, name), python);
  await writeFile(join(binDir, "pytest"), `#!/bin/sh\nexec '${join(binDir, "python")}' -m pytest "$@"\n`);
  await writeFile(join(binDir, "pip"), "#!/bin/sh\necho \"pip is disabled in this environment: dependencies are preinstalled and there is no network.\" >&2\nexit 1\n");
  for (const name of ["python", "python3", "pytest", "pip"]) await chmod(join(binDir, name), 0o755);
}

/** Copy a (read-only) venv once into the scratch environment directory (mounted read-only later); returns its path and digest. */
export async function stageVenv(cache: string, task: string, envRoot: string): Promise<{ venv: string; digest: string }> {
  const target = join(envRoot, task, "venv");
  const marker = join(envRoot, task, ".staged");
  if (!existsSync(marker)) {
    if (existsSync(join(envRoot, task))) execFileSync("chmod", ["-R", "u+w", join(envRoot, task)]);
    await rm(join(envRoot, task), { recursive: true, force: true });
    await mkdir(join(envRoot, task), { recursive: true });
    execFileSync("cp", ["-a", venvOf(cache, task), join(envRoot, task)]);
    await writeFile(marker, new Date().toISOString());
  }
  return { venv: target, digest: dirDigest(target) };
}

export async function readJson<T = any>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
export const writeJson = (path: string, value: unknown): Promise<void> => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, `${JSON.stringify(value, null, 2)}\n`));
