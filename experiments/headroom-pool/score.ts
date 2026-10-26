/**
 * Model-free scoring of one baseline attempt (experiments/headroom-pool/README.md "Scoring"). Every execution of the candidate's code
 * runs in the bubblewrap sandbox without network. Scored separately, never folded into one number:
 *   witness:     the frozen public witness on the attempt's final workspace (protocol.ts outcomeOf: miss / solved / unscored) — the
 *                only promotion input;
 *   regressions: the dataset's test command on the final workspace with the visible test files restored to the snapshot, against the
 *                visible baseline frozen before any solving (tests that passed there and do not pass now);
 *   hidden:      the hidden tests applied offline (F2P / P2P; descriptive only, never used for promotion);
 *   integrity:   test files changed or deleted, commits, import-root hazards;
 *   process:     the attempt's stop, validity and wire totals stay in meta.json.
 * A regression or hidden-test error is recorded in its own field and never changes the witness outcome.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { removeTree } from "../swe-pool/env.js";
import { importRootHazards, runWitness } from "../witness-replay/witness-run.js";
import { runTests, statusesOf, type TestRun } from "./envbuild.js";
import { outcomeOf, WITNESS_GUARD_MS, type WitnessStatus } from "./protocol.js";
import type { FrozenCase } from "./unit.js";

/** Test-file rule (visible tests and runner configuration). */
export const isTestPath = (path: string): boolean => /(^|\/)(tests?|testing)\//.test(path) || /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path) || /(^|\/)conftest\.py$/.test(path) || /(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|noxfile\.py)$/.test(path);

/** Files named by a unified diff (a/ and b/ paths). */
export const patchFiles = (patch: string): string[] => [...new Set([...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].flatMap(match => [match[1]!, match[2]!]))];

/** Test files a test command names (`*.py` arguments, node ids cut at `::`). */
export const commandTestFiles = (testCmd: string): string[] => [...new Set(testCmd.split(/\s+/).map(part => part.split("::")[0]!).filter(part => /\.py$/.test(part)))];

/** Restore `files` in `tree` to their snapshot versions (deleted when absent from the snapshot). */
async function restore(tree: string, snapshot: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const target = join(tree, file);
    await removeTree(target);
    if (existsSync(join(snapshot, file))) { execFileSync("mkdir", ["-p", dirname(target)]); await cp(join(snapshot, file), target); }
  }
}

export interface Score {
  attempt: string; at: string; witness: { status: WitnessStatus; reason?: string; exit: number | null; cases?: unknown; outputTail: string };
  outcome: ReturnType<typeof outcomeOf>;
  regressions: { baselinePassed: number; nowNotPassing: string[]; run?: Omit<TestRun, "statuses"> & { counts: Record<string, number> }; error?: string };
  hidden: { f2p: Record<string, string>; p2p: Record<string, string>; f2pPassed: number; f2pTotal: number; p2pFailing: string[]; resolved: boolean; error?: string };
  integrity: { testFilesChanged: string[]; testFilesDeleted: string[]; commits: number; hazards: string[] };
}

export interface ScoreInput { c: FrozenCase; attemptDir: string; graderDir: string; scratch: string }

const counts = (statuses: Record<string, string>) => Object.values(statuses).reduce<Record<string, number>>((acc, value) => { acc[value] = (acc[value] ?? 0) + 1; return acc; }, {});
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1500);

/** A writable copy of the final workspace, `prepare`d, then the dataset test command in it (removed afterwards). */
async function testsOn(input: ScoreInput, finalTree: string, label: string, testCmd: string, prepare: (copy: string) => Promise<void>): Promise<TestRun> {
  const copy = await mkdtemp(join(input.scratch, `score-${label}-`));
  try {
    await cp(finalTree, copy, { recursive: true });
    execFileSync("chmod", ["-R", "u+w", copy]);
    await prepare(copy);
    return await runTests({ venv: input.c.venv, pythonDir: input.c.pythonInstallDir, tree: copy, layout: input.c.pythonPath, testCmd, scratch: input.scratch });
  } finally { await removeTree(copy); }
}

/** Score one completed attempt (writes <attemptDir>/score.json). */
export async function scoreAttempt(input: ScoreInput): Promise<Score> {
  const { c, attemptDir, graderDir, scratch } = input;
  execFileSync("mkdir", ["-p", scratch]);
  const meta = JSON.parse(readFileSync(join(attemptDir, "meta.json"), "utf8"));
  const finalTree = join(attemptDir, "workspace-final");
  if (!existsSync(finalTree)) throw new Error(`${attemptDir}: no workspace-final`);
  const record = JSON.parse(readFileSync(join(graderDir, "record.json"), "utf8"));
  const validation = JSON.parse(readFileSync(join(graderDir, "validation.json"), "utf8"));
  // Witness (the only promotion input).
  const witness = await runWitness({ name: `${meta.unit}-a${meta.attempt}-score`, file: c.witness.path, expectedSha256: c.witness.sha256, candidate: finalTree, venv: c.venv, pythonPath: c.pythonPath, scratch: join(scratch, "witness-runs"), guardMs: WITNESS_GUARD_MS, extra: { binds: [{ from: c.pythonInstallDir }], env: { TZ: "UTC" } } });
  // Visible regressions against the frozen visible baseline.
  const baseline: Record<string, string> = validation.visible?.statuses ?? {};
  const baselinePassed = Object.entries(baseline).filter(([, status]) => status === "PASSED").map(([id]) => id);
  let regressions: Score["regressions"];
  try {
    const run = await testsOn(input, finalTree, "visible", c.testCmd, copy => restore(copy, c.src, commandTestFiles(c.testCmd)));
    regressions = { baselinePassed: baselinePassed.length, nowNotPassing: baselinePassed.filter(id => run.statuses[id] !== "PASSED"), run: { exit: run.exit, guardFired: run.guardFired, ms: run.ms, tail: run.tail, counts: counts(run.statuses) } };
  } catch (error) { regressions = { baselinePassed: baselinePassed.length, nowNotPassing: [], error: errorText(error) }; }
  // Hidden tests (descriptive).
  let hidden: Score["hidden"];
  try {
    const testPatch = join(graderDir, "test.patch");
    const run = await testsOn(input, finalTree, "hidden", record.testCmd, async copy => {
      await restore(copy, c.src, patchFiles(readFileSync(testPatch, "utf8")));
      execFileSync("git", ["apply", "--whitespace=nowarn", testPatch], { cwd: copy, stdio: ["ignore", "pipe", "pipe"] });
    });
    const f2p = statusesOf(run, record.failToPass), p2pAll = statusesOf(run, record.passToPass);
    const excluded = new Set<string>(validation.excludedP2P ?? []);
    const p2p = Object.fromEntries(Object.entries(p2pAll).filter(([id]) => !excluded.has(id)));
    const p2pFailing = Object.entries(p2p).filter(([, status]) => status !== "PASSED").map(([id]) => id);
    const f2pPassed = Object.values(f2p).filter(status => status === "PASSED").length;
    hidden = { f2p, p2p, f2pPassed, f2pTotal: record.failToPass.length, p2pFailing, resolved: f2pPassed === record.failToPass.length && p2pFailing.length === 0 };
  } catch (error) { hidden = { f2p: {}, p2p: {}, f2pPassed: 0, f2pTotal: record.failToPass.length, p2pFailing: [], resolved: false, error: errorText(error) }; }
  // Integrity.
  const changed: string[] = meta.changedFiles ?? [];
  const testFilesChanged = changed.filter(line => isTestPath(line.split("\t").at(-1)!));
  const testFilesDeleted = changed.filter(line => line.startsWith("D") && isTestPath(line.split("\t").at(-1)!));
  const root = c.pythonPath === "." ? finalTree : join(finalTree, c.pythonPath);
  const score: Score = {
    attempt: attemptDir, at: new Date().toISOString(),
    witness: { status: witness.status, ...(witness.reason ? { reason: witness.reason } : {}), exit: witness.exit, cases: witness.result?.cases, outputTail: witness.output.slice(-6000) },
    outcome: outcomeOf({ valid: meta.valid === true, witness: witness.status }),
    regressions, hidden,
    integrity: { testFilesChanged, testFilesDeleted, commits: meta.commits ?? 0, hazards: importRootHazards(root) },
  };
  await writeFile(join(attemptDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
  return score;
}
