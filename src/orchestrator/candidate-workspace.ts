/**
 * Workspace copies of ultra candidates (src/orchestrator/ultra.ts): each candidate implements in its own copy of the task's workspace,
 * so candidates never share a file, cannot see each other's work, and the workspace itself keeps the incumbent until one candidate is
 * adopted.
 *
 * Mechanics (git plumbing; the user's index, worktree, stash and HEAD are never touched):
 *  - `snapshot()`: a git tree of the workspace subtree (tracked and untracked, non-ignored files under the task cwd, `.orche` excluded)
 *    through a private copy of the index whose assume-unchanged and skip-worktree flags are cleared; it is what a copy checks out;
 *  - manifests (`workspaceManifest`, `copyManifest`): every in-scope file (git decides the scope: tracked or untracked and not ignored;
 *    `.orche` and the dependency directories excluded) with a SHA-256 of its raw bytes and its permission bits, or a link's target.
 *    They are content fingerprints that no index flag, clean filter or end-of-line setting can hide, and the basis of `changes`, of the
 *    adoption's conflict check and of every integrity check in ultra.ts. Hashes are cached by (size, mtime, ctime, inode, mode) and
 *    a file changed in the last two seconds is always hashed again;
 *  - `materialize(id, tree)`: `read-tree` + `checkout-index` of that tree into the copy; then the workspace's dependency directories
 *    that git ignores (`node_modules`, `.venv`, `venv`) are COPIED privately (`cp -a --reflink=auto`: copy-on-write where the
 *    filesystem supports it, a full copy otherwise), never linked to the workspace's own; inside them, links into the workspace (or,
 *    for `from`, into the earlier copy) are re-pointed into the copy and, in a Python environment, the files that name the workspace
 *    path (shebangs, activate scripts, pyvenv.cfg, .pth, editable finders, direct_url.json) get the copy's path. Finally EVERY link of
 *    the copy is resolved (`realpath`, so chains count) and the copy is refused (fail-closed, before any candidate runs) when one leads
 *    outside it to a place this user can write: a writable file inside a dependency directory is replaced by a private copy of the file
 *    (as `venv --copies` does with an interpreter); a writable or unverifiable directory, a tracked link, or a dangling link that would
 *    create a file outside is refused. Only targets verified read-only stay shared (a file this user cannot write; a directory whose
 *    whole tree, walked within a bound, has no writable entry and no link). `materialize(id, tree, from)` copies an earlier candidate's
 *    directory instead (a fix candidate; the earlier stays);
 *  - `changes(id)`: the copy's manifest against the manifest it had right after materializing; `adopt(id, paths, base, verify)`:
 *    refused when any of those paths differs between the workspace's manifest at the candidate's base and now (no blind merge), then
 *    the candidate's files (bytes, mode, links, deletions) are copied in; a failed write, or a `verify` that finds the candidate or the
 *    workspace changed meanwhile, restores every path written;
 *  - `dependencyFingerprint()`: the workspace's own dependency directories (paths, types, sizes, modification times, modes, link
 *    targets; tool caches excluded), compared around a candidates round to detect a write that escaped a copy anyway.
 * Not an OS sandbox: a candidate's shell can still write anywhere this user can by an absolute path. Such writes into the workspace's
 * in-scope files or its dependency directories are detected after the round (ultra.ts); writes elsewhere (home, global caches) are not.
 * Submodule contents are not copied (empty in a copy; ultra.ts blocks the candidates' file tools there); other ignored files are neither
 * copied nor adopted.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats, type Stats } from "node:fs";
import { promisify } from "node:util";
import { access, chmod, constants, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
/** Dependency directories copied privately into a copy when the workspace has them and git ignores them. */
export const DEPENDENCY_DIRS: readonly string[] = ["node_modules", ".venv", "venv"];
const PYTHON_ENVS = new Set([".venv", "venv"]);
const EXCLUDED_TOP = new Set([".orche", ...DEPENDENCY_DIRS]);
/** Caches tools write inside dependency directories during ordinary runs: not part of the escape check. */
const CACHE_DIRS = new Set([".cache", ".vite", ".vitest", "__pycache__", ".pytest_cache"]);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** Entries walked to verify that a shared directory outside a copy is read-only; beyond it the directory counts as unverifiable. */
const READ_ONLY_WALK_LIMIT = 20_000;
/** git settings for every command here: no filesystem monitor or untracked cache can make git skip a changed file. */
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const { stdout } = await execFileAsync("git", [...GIT_SAFE, ...args], { cwd, signal, timeout: 120_000, killSignal: "SIGKILL", env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/** git with stdin; resolves stdout and the exit code (check-ignore exits 1 when nothing is ignored). */
function gitInput(cwd: string, args: readonly string[], input: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn("git", [...GIT_SAFE, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.on("error", fail);
    child.on("close", code => done({ code: code ?? 1, stdout }));
    child.stdin.end(input);
  });
}

const topOf = (path: string) => path.split("/")[0]!;
const excluded = (path: string) => EXCLUDED_TOP.has(topOf(path));
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
const EXCLUDE_SPECS = [...EXCLUDED_TOP].map(name => `:(exclude)${name}`);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface CandidateChange { path: string; status: "A" | "M" | "D" }
/** Workspace-relative path -> `f<mode>:<sha256>` (a file's permission bits and raw bytes) or `l:<target>` (a link). */
export type Manifest = Record<string, string>;

export const manifestDigest = (manifest: Manifest): string => {
  const hash = createHash("sha256");
  for (const path of Object.keys(manifest).sort()) hash.update(`${path}\0${manifest[path]}\n`);
  return hash.digest("hex").slice(0, 40);
};

/** What changed from `from` to `to` (A/M/D), sorted; `paths` limits the comparison (a directory path covers what is under it). */
export function manifestDiff(from: Manifest, to: Manifest, paths?: readonly string[]): CandidateChange[] {
  const keep = (path: string) => !paths || paths.some(item => path === item || path.startsWith(`${item.replace(/\/$/, "")}/`));
  const changes: CandidateChange[] = [];
  for (const path of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (!keep(path) || from[path] === to[path]) continue;
    changes.push({ path, status: from[path] === undefined ? "A" : to[path] === undefined ? "D" : "M" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** What `materialize` did besides the checkout. */
export interface MaterializeReport {
  /** Dependency directories copied privately into the copy. */
  dependencies: string[];
  /** Links re-pointed into the copy; text files rewritten to the copy's path (Python environments); writable outside files copied in. */
  relinked: number;
  rewritten: number;
  privatized: string[];
  /** Links that lead outside the copy to places verified read-only for this user (shared, cannot be written through). */
  readOnly: { path: string; target: string }[];
  /** Submodules (gitlinks) of the base tree: empty in the copy, never adopted. */
  submodules: string[];
}

/** The copy was refused: links that lead outside it to places this user can write (or that cannot be verified). */
export class UnsafeLinksError extends Error {
  constructor(readonly links: { path: string; target: string; why: string }[]) {
    super(`links in the candidate copy lead outside it to places this user can write or that cannot be verified read-only: ${links.slice(0, 8).map(link => `${link.path} -> ${link.target} (${link.why})`).join("; ")}${links.length > 8 ? `; … ${links.length - 8} more` : ""}`);
  }
}

interface Entry { kind: "file"; data: Buffer; mode: number }
type State = Entry | { kind: "link"; target: string } | { kind: "absent" };

async function readState(path: string): Promise<State> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "link", target: await readlink(path) };
    if (info.isFile()) return { kind: "file", data: await readFile(path), mode: info.mode & 0o777 };
    return { kind: "absent" };
  } catch { return { kind: "absent" }; }
}

const sameState = (a: State, b: State) => a.kind === b.kind && (a.kind === "absent" || a.kind === "link" && a.target === (b as { target: string }).target || a.kind === "file" && a.mode === (b as Entry).mode && a.data.equals((b as Entry).data));

async function writeState(path: string, state: State): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current && !current.isDirectory()) await unlink(path);
  if (state.kind === "absent") return;
  await mkdir(dirname(path), { recursive: true });
  if (state.kind === "link") { await symlink(state.target, path); return; }
  await writeFile(path, state.data);
  await chmod(path, state.mode);
}

/** A private copy of the contents of `source` at `target`: copy-on-write where the filesystem can, a full copy otherwise; never a link back. */
async function copyTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    await execFileAsync("cp", ["-a", "--reflink=auto", "--", `${source}/.`, target], { timeout: 900_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    // Not GNU cp (no --reflink), or it failed: Node's own copy (it clones where supported and fails the same way on a full disk).
    await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
  }
}

/** Every entry under `root` (depth first, sorted; `skip` prunes directory names), with its lstat; links are never followed. */
async function walk(root: string, visit: (path: string, info: Stats) => Promise<void> | void, skip?: ReadonlySet<string>): Promise<void> {
  const names = (await readdir(root).catch(() => [] as string[])).sort();
  for (const name of names) {
    const path = join(root, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory() && skip?.has(name)) continue;
    await visit(path, info);
    if (info.isDirectory()) await walk(path, visit, skip);
  }
}

/** Map `path` from a `from` prefix to its `to` prefix (the first pair that contains it). */
function mapPath(path: string, pairs: readonly (readonly [string, string])[]): string | undefined {
  for (const [from, to] of pairs) if (inside(path, from)) return join(to, relative(from, path));
  return undefined;
}

const canWrite = async (path: string) => { try { await access(path, constants.W_OK); return true; } catch { return false; } };

/** A directory outside a copy that nothing can be written into by this user: no writable entry and no link in its whole tree (bounded). */
async function readOnlyTree(root: string): Promise<boolean> {
  if (await canWrite(root)) return false;
  let seen = 0;
  let safe = true;
  const stop = new Error("stop");
  try {
    await walk(root, async (path, info) => {
      if (++seen > READ_ONLY_WALK_LIMIT || info.isSymbolicLink() || await canWrite(path)) { safe = false; throw stop; }
    });
  } catch (error) { if (error !== stop) return false; }
  return safe;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Make a copied dependency directory (`dir`, copied from `original`) self-contained: a symlink whose target, resolved from its original
 * location, lies under a `from` prefix of `pairs` is re-pointed to the same place under its `to`; a relative one that led outside keeps
 * its original target (made absolute; the final check decides whether it may stay). In a Python environment the files that name a
 * `from` prefix get the `to` path.
 */
async function relocate(dir: string, original: string, pairs: readonly (readonly [string, string])[], python: boolean, report: MaterializeReport): Promise<void> {
  await walk(dir, async (path, info) => {
    if (!info.isSymbolicLink()) return;
    const target = await readlink(path);
    const from = join(original, relative(dir, path));
    const meant = isAbsolute(target) ? target : resolve(dirname(from), target);
    const now = isAbsolute(target) ? target : resolve(dirname(path), target);
    const mapped = mapPath(meant, pairs) ?? meant;
    if (mapped === now) return;
    await unlink(path);
    await symlink(mapped === meant ? meant : relative(dirname(path), mapped) || ".", path);
    report.relinked++;
  });
  if (!python) return;
  const files: string[] = [join(dir, "pyvenv.cfg")];
  for (const bin of ["bin", "Scripts"]) for (const name of await readdir(join(dir, bin)).catch(() => [] as string[])) files.push(join(dir, bin, name));
  for (const lib of (await readdir(dir).catch(() => [] as string[])).filter(name => /^lib(64)?$|^Lib$/.test(name))) {
    const roots = [join(dir, lib, "site-packages"), ...(await readdir(join(dir, lib)).catch(() => [] as string[])).filter(name => name.startsWith("python")).map(name => join(dir, lib, name, "site-packages"))];
    for (const root of roots) for (const name of await readdir(root).catch(() => [] as string[])) {
      if (/\.pth$|^__editable__|\.egg-link$/.test(name)) files.push(join(root, name));
      else if (name.endsWith(".dist-info")) files.push(join(root, name, "direct_url.json"));
    }
  }
  const patterns = pairs.map(([from, to]) => [new RegExp(`${escapeRegExp(from)}(?![A-Za-z0-9._-])`, "g"), to] as const);
  for (const file of files) {
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_TEXT_BYTES) continue;
    const data = await readFile(file);
    if (data.subarray(0, 8000).includes(0)) continue; // binary
    const text = data.toString("latin1");
    let next = text;
    for (const [pattern, to] of patterns) next = next.replace(pattern, () => to);
    if (next === text) continue;
    await writeFile(file, Buffer.from(next, "latin1"));
    await chmod(file, info.mode & 0o7777);
    report.rewritten++;
  }
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}

export class CandidateWorkspaces {
  /** Content hashes by absolute path, valid while (size, mtime, ctime, inode, mode) stay the same. */
  private readonly hashes = new Map<string, { key: string; entry: string }>();

  private constructor(
    /** The task cwd (the workspace). */
    readonly cwd: string,
    /** Directory of the copies (inside the orchestrator's private scratch directory). */
    readonly root: string,
    private readonly gitDir: string,
    /** The cwd relative to the work tree root ("" or "sub/dir/"). */
    private readonly prefix: string,
    private readonly mainIndex: string,
  ) {}

  /** Undefined outside a git work tree (candidates then cannot be isolated). */
  static async open(cwd: string, root: string, signal?: AbortSignal): Promise<CandidateWorkspaces | undefined> {
    let gitDir: string, prefix: string, index: string;
    try {
      if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"], {}, signal)).trim() !== "true") return undefined;
      gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"], {}, signal)).trim();
      prefix = (await git(cwd, ["rev-parse", "--show-prefix"], {}, signal)).trim();
      index = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {}, signal)).trim();
    } catch { return undefined; }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const own = join(await mkdtemp(join(tmpdir(), "pi-orche-ultra-index-")), "index");
    try {
      const info = await stat(index);
      await copyFile(index, own);
      await utimes(own, info.atime, info.mtime); // keep git's racy-clean check honest (see WorkspaceAudit)
    } catch { /* no index yet */ }
    const spaces = new CandidateWorkspaces(resolve(cwd), resolve(root), gitDir, prefix, own);
    await spaces.clearIndexFlags(signal);
    return spaces;
  }

  /** assume-unchanged and skip-worktree in the PRIVATE index would make `git add` skip a changed file: clear them there. */
  private async clearIndexFlags(signal?: AbortSignal): Promise<void> {
    const env = { GIT_INDEX_FILE: this.mainIndex };
    const listed = (await git(this.cwd, ["ls-files", "-z", "-v", "--", "."], env, signal).catch(() => "")).split("\0").filter(Boolean);
    const assumed = listed.filter(line => /^[a-z] /.test(line)).map(line => line.slice(2));
    const skipped = listed.filter(line => line.startsWith("S ")).map(line => line.slice(2));
    if (assumed.length) await gitInput(this.cwd, ["update-index", "-z", "--no-assume-unchanged", "--stdin"], `${assumed.join("\0")}\0`, env);
    if (skipped.length) await gitInput(this.cwd, ["update-index", "-z", "--no-skip-worktree", "--stdin"], `${skipped.join("\0")}\0`, env);
  }

  /** The workspace's subtree as a git tree (what a copy checks out); `.orche` excluded. */
  async snapshot(signal?: AbortSignal): Promise<string> {
    const env = { GIT_INDEX_FILE: this.mainIndex };
    await git(this.cwd, ["add", "--all", "--", "."], env, signal);
    await git(this.cwd, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ".orche"], env, signal);
    const tree = (await git(this.cwd, ["write-tree"], env, signal)).trim();
    if (!this.prefix) return tree;
    return (await git(this.root, [`--git-dir=${this.gitDir}`, "rev-parse", `${tree}:${this.prefix.replace(/\/$/, "")}`], {}, signal)).trim();
  }

  path(id: string): string { return join(this.root, id); }
  private index(id: string): string { return join(this.root, `${id}.index`); }
  private baseFile(id: string): string { return join(this.root, `${id}.base.json`); }
  private env(id: string): Record<string, string> { return { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.path(id), GIT_INDEX_FILE: this.index(id) }; }

  /** One file's manifest entry from its bytes (cached by stat; a file changed in the last two seconds is hashed again). */
  private async entry(path: string): Promise<string | undefined> {
    const info: BigIntStats | undefined = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!info) return undefined;
    if (info.isSymbolicLink()) return `l:${await readlink(path)}`;
    if (!info.isFile()) return undefined;
    const key = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.mode}`;
    const cached = this.hashes.get(path);
    if (cached?.key === key) return cached.entry;
    const hash = createHash("sha256");
    await new Promise<void>((done, fail) => createReadStream(path).on("data", chunk => hash.update(chunk)).on("end", done).on("error", fail));
    const entry = `f${(Number(info.mode) & 0o777).toString(8)}:${hash.digest("hex")}`;
    const recent = BigInt(Date.now()) * 1_000_000n - (info.mtimeNs > info.ctimeNs ? info.mtimeNs : info.ctimeNs) < 2_000_000_000n;
    if (!recent) this.hashes.set(path, { key, entry });
    return entry;
  }

  private async manifestOf(root: string, paths: readonly string[]): Promise<Manifest> {
    const manifest: Manifest = {};
    const entries = await pool(paths, 32, path => this.entry(join(root, path)));
    paths.forEach((path, index) => { if (entries[index] !== undefined) manifest[path] = entries[index]!; });
    return manifest;
  }

  /** The workspace's in-scope files (tracked, or untracked and not ignored; `.orche` and dependency directories excluded) by content. */
  async workspaceManifest(signal?: AbortSignal): Promise<Manifest> {
    const listed = (await git(this.cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ...EXCLUDE_SPECS], { GIT_INDEX_FILE: this.mainIndex }, signal)).split("\0");
    return this.manifestOf(this.cwd, [...new Set(listed.filter(path => path && !excluded(path)))]);
  }

  /** Candidate `id`'s copy by content: the paths of its base, and new files the workspace's ignore rules do not ignore. */
  async copyManifest(id: string, signal?: AbortSignal): Promise<Manifest> {
    const dir = this.path(id);
    const env = this.env(id);
    const tracked = (await git(dir, ["ls-files", "-z", "--cached", "--", ".", ...EXCLUDE_SPECS], env, signal)).split("\0").filter(path => path && !excluded(path));
    const others = (await git(dir, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...EXCLUDE_SPECS], env, signal)).split("\0").filter(path => path && !excluded(path));
    // The workspace's own ignore rules decide (a copy of a subdirectory lacks the ignore files above it); -z on both sides.
    const ignored = others.length ? new Set((await gitInput(this.cwd, ["check-ignore", "-z", "--stdin"], `${others.join("\0")}\0`).catch(() => ({ code: 1, stdout: "" }))).stdout.split("\0").filter(Boolean)) : new Set<string>();
    return this.manifestOf(dir, [...new Set([...tracked, ...others.filter(path => !ignored.has(path))])]);
  }

  /** Submodules (gitlinks) of a subtree, as workspace-relative paths. */
  async submodules(tree: string, signal?: AbortSignal): Promise<string[]> {
    const output = await git(this.root, [`--git-dir=${this.gitDir}`, "ls-tree", "-r", "-z", tree], {}, signal);
    return output.split("\0").filter(line => line.startsWith("160000 ")).map(line => line.slice(line.indexOf("\t") + 1));
  }

  /**
   * A fresh copy of `tree`, or of the earlier candidate `from`, with private copies of the workspace's dependency directories, every link
   * verified (fail-closed: `UnsafeLinksError`), and its base manifest recorded. Nothing is left behind when it fails.
   */
  async materialize(id: string, tree: string, from?: string, signal?: AbortSignal): Promise<MaterializeReport> {
    const target = this.path(id);
    await this.remove(id);
    const report: MaterializeReport = { dependencies: [], relinked: 0, rewritten: 0, privatized: [], readOnly: [], submodules: await this.submodules(tree, signal) };
    try {
      if (from) {
        const earlier = this.path(from);
        await copyTree(earlier, target);
        await copyFile(this.index(from), this.index(id));
        await copyFile(this.baseFile(from), this.baseFile(id));
        for (const name of DEPENDENCY_DIRS) {
          if (!(await lstat(join(target, name)).catch(() => undefined))?.isDirectory()) continue;
          report.dependencies.push(name);
          await relocate(join(target, name), join(earlier, name), [[earlier, target], [this.cwd, target]], PYTHON_ENVS.has(name), report);
        }
      } else {
        await mkdir(target, { recursive: true, mode: 0o700 });
        await git(target, ["read-tree", tree], this.env(id), signal);
        await git(target, ["checkout-index", "-a", "-f", "-u"], this.env(id), signal);
        // The manifest the candidate's changes are measured against: the copy as checked out (dependency directories are out of scope).
        await writeFile(this.baseFile(id), JSON.stringify(await this.copyManifest(id, signal)));
        for (const name of DEPENDENCY_DIRS) {
          const source = join(this.cwd, name);
          const info = await lstat(source).catch(() => undefined);
          if (!info) continue;
          // A dependency directory that is itself a link (a shared store) is copied from where it leads: the copy never links back.
          const real = info.isSymbolicLink() ? await realpath(source).catch(() => undefined) : source;
          if (!real || !(await stat(real).catch(() => undefined))?.isDirectory()) continue;
          if ((await gitInput(this.cwd, ["check-ignore", "-q", "--stdin"], `${name}/\n`)).code !== 0) continue; // tracked: in the tree already
          signal?.throwIfAborted();
          await copyTree(real, join(target, name));
          report.dependencies.push(name);
          await relocate(join(target, name), real, [[real, join(target, name)], [this.cwd, target]], PYTHON_ENVS.has(name), report);
        }
      }
      await this.verifyLinks(id, report);
      return report;
    } catch (error) {
      await this.remove(id);
      throw error;
    }
  }

  /**
   * Fail-closed link check of a copy: every link is resolved through its whole chain. Inside the copy: fine. Outside: a file this user
   * cannot write, or a directory whose whole tree is verified read-only, stays shared (reported); a writable file inside a dependency
   * directory is replaced by a private copy of it; anything else (a writable or unverifiable directory, a link in the tracked files, a
   * dangling link whose target could be created outside) refuses the copy.
   */
  private async verifyLinks(id: string, report: MaterializeReport): Promise<void> {
    const dir = this.path(id);
    const root = await realpath(dir);
    const unsafe: { path: string; target: string; why: string }[] = [];
    await walk(dir, async (path, info) => {
      if (!info.isSymbolicLink()) return;
      const rel = relative(dir, path).split(sep).join("/");
      const dependency = DEPENDENCY_DIRS.includes(topOf(rel));
      const real = await realpath(path).catch(() => undefined);
      if (real === undefined) {
        // Dangling (or a loop): a write through it creates the target. Outside the copy, refuse when that place is writable.
        const lexical = resolve(dirname(path), await readlink(path));
        if (inside(lexical, dir) || inside(lexical, root)) return;
        let ancestor = dirname(lexical);
        while (!(await lstat(ancestor).catch(() => undefined)) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
        if (await canWrite(ancestor)) unsafe.push({ path: rel, target: lexical, why: "dangling, would create a file in a writable place" });
        return;
      }
      if (inside(real, root)) return;
      const target = await stat(real).catch(() => undefined);
      if (target?.isFile()) {
        if (!(await canWrite(real))) { report.readOnly.push({ path: rel, target: real }); return; }
        if (!dependency) { unsafe.push({ path: rel, target: real, why: "tracked link to a writable file" }); return; }
        await unlink(path);
        await copyFile(real, path);
        await chmod(path, target.mode & 0o7777);
        report.privatized.push(rel);
        return;
      }
      if (target?.isDirectory() && await readOnlyTree(real)) { report.readOnly.push({ path: rel, target: real }); return; }
      unsafe.push({ path: rel, target: real, why: target?.isDirectory() ? "writable or unverifiable directory" : "not a regular file or directory" });
    });
    if (unsafe.length) throw new UnsafeLinksError(unsafe);
  }

  /** Remove one copy, its index and its base manifest. */
  async remove(id: string): Promise<void> {
    await rm(this.path(id), { recursive: true, force: true }).catch(() => undefined);
    await rm(this.index(id), { force: true }).catch(() => undefined);
    await rm(this.baseFile(id), { force: true }).catch(() => undefined);
  }

  /** What candidate `id` changed in its copy against the copy as it was made (content, mode, links; additions and deletions). */
  async changes(id: string, signal?: AbortSignal): Promise<CandidateChange[]> {
    const base = JSON.parse(await readFile(this.baseFile(id), "utf8")) as Manifest;
    return manifestDiff(base, await this.copyManifest(id, signal));
  }

  /** The content state of candidate `id`'s copy: equal fingerprints mean the same files a check saw and an adoption would write. */
  async fingerprint(id: string, signal?: AbortSignal): Promise<string> {
    return manifestDigest(await this.copyManifest(id, signal));
  }

  /** The workspace's own dependency directories (entries, types, sizes, modification times, modes, link targets; tool caches excluded). */
  async dependencyFingerprint(): Promise<string> {
    const hash = createHash("sha256");
    for (const name of DEPENDENCY_DIRS) {
      const source = join(this.cwd, name);
      const info = await lstat(source).catch(() => undefined);
      if (!info) continue;
      const real = info.isSymbolicLink() ? await realpath(source).catch(() => undefined) : source;
      hash.update(`${name}\0${real ?? "dangling"}\n`);
      if (!real) continue;
      await walk(real, async (path, entry) => {
        const link = entry.isSymbolicLink() ? await readlink(path).catch(() => "") : "";
        hash.update(`${relative(real, path)}\0${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}\0${entry.isDirectory() ? 0 : entry.size}\0${entry.isDirectory() ? 0 : entry.mtimeMs}\0${entry.mode}\0${link}\n`);
      }, CACHE_DIRS);
    }
    return hash.digest("hex").slice(0, 40);
  }

  /**
   * Copy candidate `id`'s changed `paths` into the workspace. Refused (nothing written) when any of them differs between `base` (the
   * workspace's manifest when the candidate's copy was made) and the workspace now. A write that fails, a path whose written content is
   * not the candidate's, or a `verify` that returns a problem restores every path written, then throws.
   */
  async adopt(id: string, paths: readonly string[], base: Manifest, signal?: AbortSignal, verify?: () => Promise<string | undefined>): Promise<{ applied: string[] }> {
    const now = await this.workspaceManifest(signal);
    const moved = paths.filter(path => base[path] !== now[path]);
    if (moved.length) throw new Error(`the workspace changed since the candidate's base in ${moved.slice(0, 20).join(", ")}${moved.length > 20 ? `, … ${moved.length - 20} more` : ""}; adopting would overwrite those changes. Re-run the candidate from the current workspace (a new candidates round) or integrate by hand after adopting nothing.`);
    const backups: [string, State][] = [];
    const rollback = async () => { for (const [target, state] of backups.reverse()) await writeState(target, state).catch(() => undefined); };
    try {
      for (const path of paths) {
        const target = join(this.cwd, path);
        backups.push([target, await readState(target)]);
        await writeState(target, await readState(join(this.path(id), path)));
      }
    } catch (error) {
      await rollback();
      throw new Error(`adoption failed and was rolled back: ${message(error)}`);
    }
    let problem: string | undefined;
    for (const path of paths) if (!sameState(await readState(join(this.cwd, path)), await readState(join(this.path(id), path)))) { problem = `${path} in the workspace is not the candidate's after the copy (changed meanwhile)`; break; }
    problem ??= verify ? await verify().catch(error => `verification failed: ${message(error)}`) : undefined;
    if (problem) {
      await rollback();
      throw new Error(`adoption rolled back: ${problem}`);
    }
    return { applied: [...paths] };
  }

  /** Remove every copy (a new ultra run starts clean). */
  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  /** Remove the copies for good (a completed run no longer needs them). */
  async discard(): Promise<void> {
    await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Remove the private index (the copies stay for a continuation). */
  async close(): Promise<void> {
    await rm(dirname(this.mainIndex), { recursive: true, force: true }).catch(() => undefined);
  }
}
