import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  concurrentActivityOf, defaultSessionsDirs, detectConcurrentSessions, formatConcurrentWarning, sessionsRootOf, type ConcurrentSession,
} from "../../src/extension/concurrent-sessions.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const MINUTE = 60_000;
async function tmp(prefix = "orche-conc-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
const GIT = ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function repo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, "init", "-q");
  await writeFile(join(path, "README.md"), "# repo\n");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "init");
  return path;
}
/** A superproject with `orche` as a real submodule (and a plain `docs` directory). */
async function superproject(): Promise<{ root: string; sub: string; docs: string }> {
  const base = await tmp();
  const origin = await repo(join(base, "origin-orche"));
  const root = await repo(join(base, "super"));
  git(root, "submodule", "add", "-q", origin, "orche");
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "a.md"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "add submodule");
  const sub = join(root, "orche");
  expect(git(sub, "rev-parse", "--show-superproject-working-tree")).toBe(root);
  return { root, sub, docs: join(root, "docs") };
}

let counter = 0;
interface SessionSpec { cwd?: unknown; id?: string; ageMs?: number; raw?: string; type?: string; dir?: string }
/** Writes `<sessions>/<dir>/<timestamp>_<id>.jsonl` with pi's header line and sets its mtime `ageMs` in the past. */
async function session(sessions: string, spec: SessionSpec = {}): Promise<string> {
  const id = spec.id ?? `id-${++counter}`;
  const dir = join(sessions, spec.dir ?? `--enc-${++counter}--`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `2026-10-02T06-10-${String(counter % 60).padStart(2, "0")}-000Z_${id}.jsonl`);
  const header = spec.raw ?? `${JSON.stringify({ type: spec.type ?? "session", version: 3, id, timestamp: "2026-10-02T06:10:00.000Z", ...("cwd" in spec ? { cwd: spec.cwd } : {}) })}\n${JSON.stringify({ type: "message", id: "m1" })}\n`;
  await writeFile(file, header);
  const when = new Date(Date.now() - (spec.ageMs ?? 5_000));
  await utimes(file, when, when);
  return file;
}
async function detect(cwd: string, sessions: string, extra: Partial<Parameters<typeof detectConcurrentSessions>[0]> = {}) {
  return (await detectConcurrentSessions({ cwd, sessionsDir: sessions, ...extra })).sessions;
}

describe("concurrent pi session detection", () => {
  it("detects a fresh session in the same repository, from the root or a subdirectory", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    await mkdir(join(project, "packages", "a"), { recursive: true });
    const file = await session(sessions, { cwd: join(project, "packages", "a"), id: "other-1", ageMs: 20_000 });

    const found = await detect(project, sessions);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "other-1", cwd: join(project, "packages", "a"), file });
    expect(Date.now() - found[0]!.lastWriteMs).toBeGreaterThanOrEqual(19_000);
    expect(Date.now() - found[0]!.lastWriteMs).toBeLessThan(MINUTE);
    // The run itself may be in a subdirectory of the repository.
    expect(await detect(join(project, "packages", "a"), sessions)).toHaveLength(1);
  });

  it("detects a session in the superproject from a submodule cwd", async () => {
    const { root, sub, docs } = await superproject();
    const sessions = join(await tmp(), "sessions");
    await session(sessions, { cwd: root, id: "in-root" });
    await session(sessions, { cwd: docs, id: "in-docs" });

    const found = await detect(sub, sessions);
    expect(found.map(item => item.id).sort()).toEqual(["in-docs", "in-root"]);
  });

  it("detects a session in a submodule from the superproject cwd", async () => {
    const { root, sub } = await superproject();
    const sessions = join(await tmp(), "sessions");
    await mkdir(join(sub, "src"));
    await session(sessions, { cwd: sub, id: "in-sub" });
    await session(sessions, { cwd: join(sub, "src"), id: "in-sub-src" });

    const found = await detect(root, sessions);
    expect(found.map(item => item.id).sort()).toEqual(["in-sub", "in-sub-src"]);
  });

  it("detects a fresh session in the same submodule", async () => {
    const { sub } = await superproject();
    const sessions = join(await tmp(), "sessions");
    await session(sessions, { cwd: sub, id: "same-sub" });
    expect((await detect(sub, sessions)).map(item => item.id)).toEqual(["same-sub"]);
  });

  it("does not report the current session (by file or by id) but reports the others", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    const current = await session(sessions, { cwd: project, id: "me" });
    await session(sessions, { cwd: project, id: "me-by-id" });
    await session(sessions, { cwd: project, id: "someone-else" });

    expect((await detect(project, sessions, { currentSessionFile: current, currentSessionId: "me-by-id" })).map(item => item.id)).toEqual(["someone-else"]);
    // A symlinked sessions directory still identifies the current file.
    const alias = join(base, "sessions-alias");
    await symlink(sessions, alias);
    const aliasedCurrent = current.replace(sessions, alias);
    expect((await detect(project, sessions, { currentSessionFile: aliasedCurrent })).map(item => item.id).sort()).toEqual(["me-by-id", "someone-else"]);
  });

  it("ignores sessions whose last write is outside the window (default 10 minutes, configurable)", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    await session(sessions, { cwd: project, id: "fresh", ageMs: 9 * MINUTE });
    await session(sessions, { cwd: project, id: "stale", ageMs: 11 * MINUTE });

    expect((await detect(project, sessions)).map(item => item.id)).toEqual(["fresh"]);
    expect((await detect(project, sessions, { windowMs: 30 * MINUTE })).map(item => item.id).sort()).toEqual(["fresh", "stale"]);
    expect(await detect(project, sessions, { windowMs: MINUTE })).toEqual([]);
    // `now` moves the window.
    expect(await detect(project, sessions, { now: Date.now() + 5 * MINUTE })).toEqual([]);
  });

  it("ignores sessions of unrelated repositories and of sibling directories that share a name prefix", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    const unrelated = await repo(join(base, "elsewhere"));
    const sibling = await repo(join(base, "project-two"));
    await session(sessions, { cwd: unrelated, id: "unrelated" });
    await session(sessions, { cwd: sibling, id: "sibling" });
    await session(sessions, { cwd: base, id: "parent-dir" });
    await session(sessions, { cwd: join(base, "gone", "missing"), id: "nonexistent" });
    await session(sessions, { cwd: project, id: "related" });

    expect((await detect(project, sessions)).map(item => item.id)).toEqual(["related"]);
  });

  it("ignores sessions of a repository outside the run's root chain", async () => {
    const { sub } = await superproject();
    const elsewhere = await repo(join(await tmp(), "other"));
    const sessions = join(await tmp(), "sessions");
    await session(sessions, { cwd: elsewhere, id: "other-repo" });
    expect(await detect(sub, sessions)).toEqual([]);
  });

  it("matches a session whose recorded cwd is a symlink into the repository", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    const link = join(base, "link-to-project");
    await symlink(project, link);
    await session(sessions, { cwd: link, id: "via-link" });
    expect((await detect(project, sessions)).map(item => item.id)).toEqual(["via-link"]);
  });

  it("ignores malformed session files without failing", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    await session(sessions, { raw: "{ not json\n" });
    await session(sessions, { raw: "" });
    await session(sessions, { raw: "\n" });
    await session(sessions, { raw: "[]\n" });
    await session(sessions, { raw: `${"x".repeat(40_000)}\n` });
    await session(sessions, { raw: "\u0000\u0001\u0002\n" });
    await session(sessions, { type: "message", cwd: project });
    await session(sessions, { type: "session" /* no cwd */ });
    await session(sessions, { cwd: 42 });
    await session(sessions, { cwd: "" });
    await mkdir(join(sessions, "--dir--", "looks-like-a-session.jsonl"), { recursive: true });
    await writeFile(join(sessions, "--dir--", "notes.txt"), "not a session\n");
    await session(sessions, { cwd: project, id: "valid" });

    expect((await detect(project, sessions)).map(item => item.id)).toEqual(["valid"]);
  });

  it("reads only the first line: a long session body is not parsed", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    const body = `${JSON.stringify({ type: "session", id: "big", cwd: project })}\n${"{broken\n".repeat(50_000)}`;
    await session(sessions, { raw: body });
    expect((await detect(project, sessions)).map(item => item.id)).toEqual(["big"]);
  });

  it("fails open: missing, non-directory and unreadable session directories, and non-repository cwds", async () => {
    const base = await tmp();
    const project = await repo(join(base, "project"));
    expect(await detect(project, join(base, "does-not-exist"))).toEqual([]);

    const file = join(base, "a-file");
    await writeFile(file, "x");
    expect(await detect(project, file)).toEqual([]);

    const sessions = join(base, "sessions");
    await session(sessions, { cwd: project });
    if (process.getuid?.() !== 0) {
      const locked = join(base, "locked");
      await session(locked, { cwd: project });
      await chmod(locked, 0o000);
      try { expect(await detect(project, locked)).toEqual([]); }
      finally { await chmod(locked, 0o755); }
      const lockedChild = join(sessions, "--locked-child--");
      await mkdir(lockedChild);
      await chmod(lockedChild, 0o000);
      try { expect((await detect(project, sessions)).length).toBe(1); }
      finally { await chmod(lockedChild, 0o755); }
    }

    const notRepo = await tmp();
    expect(await detect(notRepo, sessions)).toEqual([]);
    expect(await detect(join(base, "no", "such", "cwd"), sessions)).toEqual([]);
    expect(await detect("", sessions)).toEqual([]);
    expect(await detectConcurrentSessions({ cwd: project, sessionsDir: sessions, windowMs: Number.NaN })).toEqual({ sessions: [] });
    expect(await detectConcurrentSessions({ cwd: project, sessionsDir: sessions, maxFiles: 0 })).toEqual({ sessions: [] });
    expect(await detectConcurrentSessions({ cwd: undefined as unknown as string, sessionsDir: sessions })).toEqual({ sessions: [] });
  });

  it("caps the number of files inspected, newest-named files first", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    const dir = join(sessions, "--one-dir--");
    await mkdir(dir, { recursive: true });
    for (const stamp of ["06-00", "06-01", "06-02", "06-03", "06-04"]) {
      const file = join(dir, `2026-10-02T${stamp}-00-000Z_s${stamp}.jsonl`);
      await writeFile(file, `${JSON.stringify({ type: "session", id: `s${stamp}`, cwd: project })}\n`);
    }
    expect((await detect(project, sessions, { maxFiles: 2 })).map(item => item.id).sort()).toEqual(["s06-03", "s06-04"]);
    expect(await detect(project, sessions)).toHaveLength(5);
  });

  it("reads a flat custom session directory and several roots", async () => {
    const base = await tmp();
    const flat = join(base, "flat");
    const nested = join(base, "nested");
    const project = await repo(join(base, "project"));
    await mkdir(flat);
    await writeFile(join(flat, "2026-10-02T06-00-00-000Z_flat.jsonl"), `${JSON.stringify({ type: "session", id: "flat", cwd: project })}\n`);
    await session(nested, { cwd: project, id: "nested" });
    expect((await detect(project, flat)).map(item => item.id)).toEqual(["flat"]);
    expect((await detectConcurrentSessions({ cwd: project, sessionsDir: [flat, nested] })).sessions.map(item => item.id).sort()).toEqual(["flat", "nested"]);
  });

  it("returns the most recently written session first", async () => {
    const base = await tmp();
    const sessions = join(base, "sessions");
    const project = await repo(join(base, "project"));
    await session(sessions, { cwd: project, id: "older", ageMs: 5 * MINUTE });
    await session(sessions, { cwd: project, id: "newest", ageMs: 1_000 });
    await session(sessions, { cwd: project, id: "middle", ageMs: 2 * MINUTE });
    expect((await detect(project, sessions)).map(item => item.id)).toEqual(["newest", "middle", "older"]);
  });

  it("locates the default sessions directory from PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR", async () => {
    const base = await tmp();
    const project = await repo(join(base, "project"));
    const agentDir = join(base, "agent");
    await session(join(agentDir, "sessions"), { cwd: project, id: "default-location" });
    const previous = { dir: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    try {
      expect((await detectConcurrentSessions({ cwd: project })).sessions.map(item => item.id)).toEqual(["default-location"]);
      expect(defaultSessionsDirs({})).toEqual([join(agentDir, "sessions")]);
      expect(defaultSessionsDirs({ PI_CODING_AGENT_SESSION_DIR: "/custom/sessions" })).toEqual(["/custom/sessions", join(agentDir, "sessions")]);
    } finally {
      if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous.dir;
      if (previous.sessions !== undefined) process.env.PI_CODING_AGENT_SESSION_DIR = previous.sessions;
    }
  });

  it("derives the sessions root from a session manager's directory", () => {
    expect(sessionsRootOf("/home/u/.pi/agent/sessions/--home-u-Code-repo--")).toBe("/home/u/.pi/agent/sessions");
    expect(sessionsRootOf("/work/custom-sessions")).toBe("/work/custom-sessions");
  });
});

describe("concurrent session warning text", () => {
  const now = 1_000_000_000_000;
  const at = (cwd: string, secondsAgo: number): ConcurrentSession => ({ cwd, file: `${cwd}.jsonl`, lastWriteMs: now - secondsAgo * 1000 });

  it("is empty without sessions", () => {
    expect(formatConcurrentWarning([], now)).toBe("");
  });

  it("names the session count, cwd and the age of the latest write", () => {
    expect(formatConcurrentWarning([at("/repo", 12)], now)).toBe(
      "⚠ 1 other pi session active in this repository (cwd /repo, last write 12s ago); their changes are classified as external where possible",
    );
    const many = formatConcurrentWarning([at("/repo", 90), at("/repo/sub", 30), at("/repo", 200)], now);
    expect(many).toContain("⚠ 3 other pi sessions active in this repository");
    expect(many).toContain("cwd /repo, /repo/sub,");
    expect(many).toContain("last write 30s ago");
    expect(formatConcurrentWarning([at("/repo", 400)], now)).toContain("last write 7m ago");
    expect(formatConcurrentWarning([at("/a", 1), at("/b", 1), at("/c", 1), at("/d", 1), at("/e", 1)], now)).toContain("/a, /b, /c, +2 more");
  });

  it("summarises the sessions for the run options", () => {
    const summary = concurrentActivityOf([at("/repo", 12), at("/repo/sub", 45)], now);
    expect(summary.count).toBe(2);
    expect(summary.detail).toContain("/repo (last write 12s ago)");
    expect(summary.detail).toContain("/repo/sub (last write 45s ago)");
  });
});
