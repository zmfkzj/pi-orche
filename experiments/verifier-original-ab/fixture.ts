/**
 * Materialize one case of cases.ts as a git workspace (base commit + the orchestrator's uncommitted change), and run its visible
 * suite and its hidden ground-truth check. The workspace holds only the fixture repository: no case id, label, hidden check or
 * stratum (README.md "Blinding").
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Case } from "./cases.js";

const GIT_ENV = { GIT_AUTHOR_NAME: "dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "dev", GIT_COMMITTER_EMAIL: "dev@example.com", GIT_AUTHOR_DATE: "2026-11-01T09:00:00+09:00", GIT_COMMITTER_DATE: "2026-11-01T09:00:00+09:00", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function writeAll(root: string, files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    if (text === null) { rmSync(file, { force: true }); continue; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** Write `item`'s repository into the empty directory `workspace`: base committed, the change left uncommitted. */
export function materialize(item: Case, workspace: string): void {
  mkdirSync(workspace, { recursive: true });
  writeAll(workspace, item.base);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, env: { ...process.env, ...GIT_ENV }, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "initial version");
  writeAll(workspace, item.change);
}

const nodeTest = (cwd: string, args: string[]) => spawnSync(process.execPath, ["--test", ...args], { cwd, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "" } });

/** `npm test` of the fixture (node --test in the workspace) passes. */
export function visiblePasses(workspace: string): boolean {
  return nodeTest(workspace, []).status === 0;
}

/** The hidden check (written to `outside`, never into the workspace) passes: the work is compliant. */
export function hiddenPasses(item: Case, workspace: string, outside: string): boolean {
  mkdirSync(outside, { recursive: true });
  const file = join(outside, "hidden.test.mjs");
  writeFileSync(file, item.hidden.replaceAll("WS/", pathToFileURL(`${workspace}/`).href));
  return nodeTest(outside, [file]).status === 0;
}

/** Truth established without a model: visible suite passes and the hidden check agrees with the label. */
export function checkTruth(item: Case, scratch: string): { visible: boolean; hidden: boolean; agrees: boolean } {
  const workspace = join(scratch, "workspace"), outside = join(scratch, "hidden");
  rmSync(scratch, { recursive: true, force: true });
  materialize(item, workspace);
  const visible = visiblePasses(workspace);
  const hidden = hiddenPasses(item, workspace, outside);
  return { visible, hidden, agrees: visible && hidden === (item.truth === "pass") };
}
