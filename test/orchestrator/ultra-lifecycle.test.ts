/**
 * Ultra report/adoption/review lifecycle, replayed from the ultra A/B study (results/ultra-ab/main/runs/<task>/B/r<n>) through the same
 * code paths a real assignment uses: orche_spawn as createSpawnTool runs it (the verification cap included) with UltraRun as its stage
 * contract, orche_adopt (UltraRun.adopt), the probes the worker pool opens and closes around every call, a real tool-call ledger and the
 * report gate, on a real git workspace with real shell checks. Sub-workers are scripted (no model). What each test pins:
 *  - the verification cap counts rounds that reviewed something: a call refused before any verifier ran, or a round whose verifiers
 *    all crashed (marshmallow-2925 B/r1: a provider disconnect), does not use up the review a later adoption needs, while genuine
 *    rounds keep the cap and rounds without a verdict stop too;
 *  - a reproduced-open finding keeps the task blocked whatever the checks say (d8-build-graph B/r1);
 *  - a fix candidate (from: an adopted candidate) is adoptable over its own ancestor's adoption, nothing else (holoviz-1117 r1,
 *    marshmallow-2925 r1, isort-2491 r1, sqlfluff-7615 r1/r2, tox-3904 r1 were all refused "the workspace changed since the
 *    candidate's base" by their ancestor's adoption alone);
 *  - a continuation's carried state: carried candidates count only fresh checks of the continuation (refs restart per assignment),
 *    a changed or missing copy is not adoptable, a carried adoption still needs a new review, and no stage is recorded that did not run;
 *  - the report schema's recorded friction: review.source labels over 40 characters (10 rejections in 9 units) and the stage name
 *    "verification" for a blocked report (3 of 5 stage rejections; two assignments ended "failed" on it).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpawnTool, type PlannedWorker, type SpawnContext, type SubWorkerOutcome } from "../../src/orchestrator/spawn.js";
import { subWorkerFloor, UltraRun, type UltraState } from "../../src/orchestrator/ultra.js";
import { evidenceLedgerOf, recordToolCall } from "../../src/pi/tool-evidence.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo(): Promise<{ cwd: string; scratch: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "orche-ultra-lifecycle-")));
  dirs.push(base);
  const cwd = join(base, "repo");
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
  await writeFile(join(cwd, "greeting.txt"), "hello\n");
  await writeFile(join(cwd, "helper.txt"), "helper v1\n");
  return { cwd, scratch: join(base, "scratch") };
}

/** What a sub-worker does while its orche_spawn call runs (it may write in its copy); returns its status. */
type Act = (worker: PlannedWorker) => Promise<string> | string;
type Spec = { name: string; role: string; request: string; files?: string[]; from?: string };
const w = (name: string, role: string, request = `do ${name}`, files?: string[], from?: string): Spec => ({ name, role, request, ...(files ? { files } : {}), ...(from ? { from } : {}) });
const outcome = (worker: PlannedWorker, status: string): SubWorkerOutcome => ({
  id: worker.id, name: worker.name, role: worker.role, reason: worker.reason, status, summary: `${worker.name} ${status}`, model: "p/m", modelSource: "orchestrator",
  requests: 1, models: {}, startedAt: Date.now(), durationMs: 1, costUSD: 0,
  // A writer in the shared workspace reports its owned files as changed (the pool's snapshot diff); candidates are diffed by UltraRun.
  changes: worker.role === "implement" && !worker.workspace ? [...(worker.files ?? [])] : [],
  ...(worker.files ? { files: worker.files } : {}), ...(worker.workspace ? { workspace: worker.workspace } : {}),
  ...(status === "failed" ? { error: `${worker.id}: stream disconnected before completion` } : {}),
});
const textOf = (result: unknown) => ((result as { content?: { type: string; text?: string }[] }).content ?? []).map(part => part.text ?? "").join("\n");

/**
 * One ultra orchestrator assignment: its own ledger (refs T1, T2, … from the start, as every assignment's), UltraRun, and the
 * orche_spawn tool of createSpawnTool on a SpawnContext like the worker pool's. Every call runs between beginCall (the guard) and
 * endCall (the end of the call), and the ledger records it in between, as in a real session.
 */
async function orchestrator(options: { cwd?: string; scratch?: string; carried?: UltraState } = {}) {
  const { cwd, scratch } = options.cwd ? { cwd: options.cwd, scratch: options.scratch! } : await repo();
  const session = {};
  const ledger = evidenceLedgerOf(session);
  ledger.tag = true;
  const events: Record<string, unknown>[] = [];
  const ultra = new UltraRun({ orchestrator: "W1", cwd, readOnly: false, scratch, ledger: () => ledger, verifyCommands: ["sh test/basis.sh"], ...(options.carried ? { carried: options.carried } : {}), onEvent: event => events.push(event) });
  const acts = new Map<string, Act>();
  const refusals: [number, number][] = [];
  let sub = 0;
  let n = 0;
  const context: SpawnContext = {
    orchestrator: "W1", ultra,
    nextId: () => { sub = Math.max(sub, subWorkerFloor(ultra.state, "W1")) + 1; ultra.state.subWorkers = sub; return `W1.${sub}`; },
    runWorker: async worker => outcome(worker, await (acts.get(worker.name)?.(worker) ?? (worker.role === "verify" ? "passed" : "done"))),
    onVerificationRefused: (rounds, cap) => { refusals.push([rounds, cap]); },
  };
  const tool = createSpawnTool(() => context, { ultra: true });
  const call = async (name: string, input: Record<string, unknown>, run: () => Promise<{ isError?: boolean; text?: string }>) => {
    const id = `c${++n}`;
    await ultra.beginCall(id, name);
    let isError = false;
    let text = "";
    // A tool that throws ends as an error result (Pi's behaviour), like a refusal it returns itself.
    try { const result = await run(); isError = !!result.isError; text = result.text ?? ""; } catch (error) { isError = true; text = error instanceof Error ? error.message : String(error); }
    const ref = recordToolCall(session, { toolCallId: id, toolName: name, input, isError }, { request: n, atBaseline: true }).ref;
    await ultra.endCall(id);
    return { ref, isError, text };
  };
  const spawn = (reason: string, workers: Spec[], scripted: Record<string, Act> = {}) => {
    for (const [name, act] of Object.entries(scripted)) acts.set(name, act);
    const params = { reason, workers };
    return call("orche_spawn", params, async () => {
      const result = await tool.execute(`spawn-${n}`, params as never, undefined, undefined, undefined as never);
      return { isError: !!(result as { isError?: boolean }).isError, text: textOf(result) };
    });
  };
  /** A real shell command of the orchestrator; a failing exit is an error result (evidence too). */
  const shell = (command: string) => call("bash", { command }, async () => { try { execSync(command, { cwd, stdio: "pipe", shell: "/bin/sh" }); return {}; } catch { return { isError: true }; } });
  const adopt = (candidate: string) => call("orche_adopt", { candidate }, async () => ({ text: await ultra.adopt(candidate) }));
  /** An integration edit of the orchestrator in the workspace (allowed after an adoption). */
  const edit = (path: string, content: string) => call("write", { path }, async () => { await writeFile(join(cwd, path), content); return {}; });
  /** report_result alone: the gate's verdict (undefined: accepted). */
  const report = async (data: unknown) => {
    const id = `c${++n}`;
    await ultra.beginCall(id, "report_result");
    const error = ultra.gateError("implement", data);
    recordToolCall(session, { toolCallId: id, toolName: "report_result", input: {}, isError: !!error }, { request: n, atBaseline: true });
    await ultra.endCall(id);
    return error;
  };
  const copy = (id: string) => ultra.state.candidates.find(item => item.id === id)!.workspace!;
  return { cwd, scratch, ultra, spawn, shell, adopt, edit, report, events, refusals, copy };
}
type Run = Awaited<ReturnType<typeof orchestrator>>;

/** Exploration (a basis builder writes test/basis.sh, an analyst) and two candidates: W1.3 passes the basis (and changes helper.txt), W1.4 fails it. */
async function throughCandidates(run: Run): Promise<{ a: string; b: string }> {
  const explored = await run.spawn("exploration", [w("basis", "implement", "acceptance tests", ["test/"]), w("cause", "answer", "hypotheses")], {
    basis: async () => { await mkdir(join(run.cwd, "test"), { recursive: true }); await writeFile(join(run.cwd, "test", "basis.sh"), "grep -q fixed greeting.txt\n"); return "done"; },
  });
  expect(explored.isError).toBe(false);
  const round = await run.spawn("candidates", [w("a", "implement", "approach A", ["greeting.txt", "helper.txt"]), w("b", "implement", "approach B", ["greeting.txt"])], {
    a: async worker => { await writeFile(join(worker.workspace!, "greeting.txt"), "fixed\n"); await writeFile(join(worker.workspace!, "helper.txt"), "helper v2\n"); return "done"; },
    b: async worker => { await writeFile(join(worker.workspace!, "greeting.txt"), "broken\n"); return "done"; },
  });
  expect(round.isError).toBe(false);
  return { a: run.copy("W1.3"), b: run.copy("W1.4") };
}

const check = (run: Run, dir: string) => run.shell(`cd '${dir}' && sh test/basis.sh`);
const verify = (run: Run, status: string, name = "red") => run.spawn("verification", [w(name, "verify", "find counterexamples on the integrated result")], { [name]: () => status });

/** A complete report: `chosen` with its selection check, every other candidate with its entry, the review, the integration checks. */
function complete(chosen: { id: string; evidence: string }, others: { id: string; verdict: string; evidence?: string[] }[], integration: string, review: unknown[] = []) {
  return {
    status: "done", ultra: {
      stage: "complete", criteria: ["greeting.txt says fixed (test/basis.sh)"],
      candidates: [{ id: chosen.id, verdict: "chosen", reason: "passes the protected basis", evidence: [chosen.evidence] }, ...others.map(item => ({ id: item.id, verdict: item.verdict, reason: "lost the comparison", ...(item.evidence ? { evidence: item.evidence } : {}) }))],
      selection: { chosen: chosen.id, reason: "passes the protected basis", evidence: [chosen.evidence] }, review, integration: { evidence: [integration] },
    },
  };
}
const blocked = (stage: string) => ({ status: "blocked", reason: "the review the gate requires cannot run in this assignment", ultra: { stage } });

describe("ultra lifecycle: the verification cap counts rounds that reviewed something", () => {
  // (1) A refused-before-execution call and a round whose verifiers all crashed, then a late adoption: a legal completion stays possible.
  it("a call refused before any verifier ran and a round whose verifiers all crashed do not use up the review a late adoption needs", async () => {
    const run = await orchestrator();
    const { a, b } = await throughCandidates(run);
    const checkA = await check(run, a);
    const failB = await check(run, b);
    expect(failB.isError).toBe(true);
    // Refused before execution (a verification round takes role verify only): no verifier ran.
    const refused = await run.spawn("verification", [w("reader", "answer", "review it")]);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('reason "verification" takes role verify only');
    // Every verifier crashed (a provider disconnect, as W1.5 in marshmallow-2925 B/r1): the round reviewed nothing.
    const crashed = await verify(run, "failed");
    expect(crashed.isError).toBe(false);
    expect(crashed.text).toContain("Ultra review: 0 verifier(s) finished");
    // The late adoption, then the review the gate requires after it.
    expect((await run.adopt("W1.3")).text).toContain("Adopted W1.3");
    const review = await verify(run, "passed", "final");
    expect(review.text).not.toContain("Refused");
    expect(review.isError).toBe(false);
    const integration = await run.shell("sh test/basis.sh");
    expect(await run.report(complete({ id: "W1.3", evidence: checkA.ref }, [{ id: "W1.4", verdict: "failed", evidence: [failB.ref] }], integration.ref))).toBeUndefined();
    expect(run.refusals).toEqual([]);
    // Both say what happened: the crashed round did not count, and the record keeps it apart from the reviews.
    expect(crashed.text).toContain("No verifier finished with a verdict (each failed or was cancelled): this round does not count against the verification cap (1 such round left)");
    expect(run.ultra.lines()[0]).toContain("verification 1/2 round(s) (+1 without a finished verifier)");
  });

  // marshmallow-2925 B/r1 as it ran: adopt W1.4; round 1 crashed; round 2 found a counterexample; fix W1.8 from W1.4; adopt W1.8. (Here the
  // verifiers take W1.5 and W1.6, so the fix candidates are W1.7 and W1.8.)
  it("replay of marshmallow-2925 B/r1: crashed round, genuine round, fix candidate from the adopted one, late adoption, final review, complete", async () => {
    const run = await orchestrator();
    const { a, b } = await throughCandidates(run);
    const failB = await check(run, b);
    await check(run, a);
    expect((await run.adopt("W1.3")).text).toContain("Adopted W1.3");
    expect((await verify(run, "failed")).isError).toBe(false);
    expect((await verify(run, "not passed", "construction-review")).isError).toBe(false);
    const repro = await run.shell("grep -q 'fixed!' greeting.txt"); // the verifier's counterexample, reproduced (fails)
    expect(repro.isError).toBe(true);
    const fix = await run.spawn("candidates", [w("mro-repair", "implement", "repair W1.3 from the reproduced finding", ["greeting.txt"], "W1.3"), w("static-repair", "implement", "repair W1.3 another way", ["greeting.txt"], "W1.3")], {
      "mro-repair": async worker => { await writeFile(join(worker.workspace!, "greeting.txt"), "fixed!\n"); return "done"; },
      "static-repair": () => "blocked",
    });
    expect(fix.isError).toBe(false);
    const checkA = await check(run, a);
    const checkFix = await check(run, run.copy("W1.7"));
    const adopted = await run.adopt("W1.7");
    expect(adopted.text).not.toContain("the workspace changed since the candidate's base");
    expect(adopted).toMatchObject({ isError: false });
    expect(await readFile(join(run.cwd, "greeting.txt"), "utf8")).toBe("fixed!\n");
    const final = await verify(run, "passed", "final-review");
    expect(final.text).not.toContain("Refused");
    const fixed = await run.shell("grep -q 'fixed!' greeting.txt");
    const integration = await run.shell("sh test/basis.sh");
    const data = complete({ id: "W1.7", evidence: checkFix.ref }, [{ id: "W1.3", verdict: "rejected", evidence: [checkA.ref] }, { id: "W1.4", verdict: "failed", evidence: [failB.ref] }, { id: "W1.8", verdict: "failed" }], integration.ref,
      [{ finding: "greeting.txt lacks the exclamation mark", source: "W1.6 construction-review", status: "reproduced-fixed", evidence: [repro.ref, fixed.ref] }]);
    expect(await run.report(data)).toBeUndefined();
  });

  // (2) The anti-loop cap still binds genuine rounds: two completed rounds, then a late adoption at the cap → blocked is the only way out.
  it("two genuine rounds, then a late adoption at the cap: a third round is refused and only a blocked report is accepted", async () => {
    const run = await orchestrator();
    const { a, b } = await throughCandidates(run);
    const checkA = await check(run, a);
    const failB = await check(run, b);
    expect((await verify(run, "not passed")).isError).toBe(false);
    expect((await verify(run, "passed", "second")).isError).toBe(false);
    expect((await run.adopt("W1.3")).text).toContain("Adopted W1.3");
    const third = await verify(run, "passed", "third");
    expect(third).toMatchObject({ isError: true });
    expect(third.text).toContain("already ran 2 verification rounds (the cap is 2");
    expect(third.text).toContain("data.unresolved");
    expect(run.refusals).toEqual([[2, 2]]);
    const integration = await run.shell("sh test/basis.sh");
    const review = [{ finding: "a counterexample of the first round", source: "W1.5", status: "refuted", evidence: [integration.ref] }];
    expect(await run.report(complete({ id: "W1.3", evidence: checkA.ref }, [{ id: "W1.4", verdict: "failed", evidence: [failB.ref] }], integration.ref, review)))
      .toContain('an independent counterexample review is missing: orche_spawn reason "verification" on the integrated result (after the last orche_adopt)');
    expect(await run.report(blocked("review"))).toBeUndefined();
    expect(run.ultra.summary()).toMatchObject({ stage: "review", gate: "accepted as incomplete (stopped at review)" });
  });

  it("rounds in which no verifier finished are bounded too: repeated crashes stop at the cap", async () => {
    const run = await orchestrator();
    await throughCandidates(run);
    expect((await verify(run, "failed")).isError).toBe(false);
    expect((await verify(run, "failed", "again")).isError).toBe(false);
    const third = await verify(run, "passed", "third");
    expect(third).toMatchObject({ isError: true });
    expect(third.text).toContain("data.unresolved");
    expect(run.refusals).toHaveLength(1);
  });

  // The same counting outside ultra (createSpawnTool is shared by every mode): a refused call uses no round, a round that ran is never given back.
  it("single/strong orche_spawn: a refused call uses no round; verifiers that ran count even when the call then fails", async () => {
    let n = 0;
    const plain = (overrides: Partial<SpawnContext> = {}): SpawnContext => ({ orchestrator: "W1", nextId: () => `W1.${++n}`, runWorker: async worker => outcome(worker, "passed"), ...overrides });
    const run = (tool: ReturnType<typeof createSpawnTool>, workers: Spec[]) => tool.execute("c", { reason: "verification", workers } as never, undefined, undefined, undefined as never).then(result => ({ isError: !!(result as { isError?: boolean }).isError, text: textOf(result) }), (error: Error) => ({ isError: true, text: error.message }));
    const assignment = plain();
    const tool = createSpawnTool(() => assignment);
    expect(await run(tool, [w("v", "verify"), w("v", "verify")])).toMatchObject({ isError: true, text: expect.stringContaining("Duplicate worker name v") });
    expect(await run(tool, [w("v", "verify")])).toMatchObject({ isError: false });
    expect(await run(tool, [w("v", "verify")])).toMatchObject({ isError: false });
    expect((await run(tool, [w("v", "verify")])).text).toContain("already ran 2 verification rounds (the cap is 2");
    // Verifiers that ran, then the call failed (its record threw): no verdict reached the orchestrator, but the round is not given back.
    const failing = plain({ onSpawned: () => { throw new Error("record failed"); } });
    const second = createSpawnTool(() => failing);
    expect((await run(second, [w("v", "verify")])).text).toBe("record failed");
    expect((await run(second, [w("v", "verify")])).text).toBe("record failed");
    expect(await run(second, [w("v", "verify")])).toMatchObject({ isError: true, text: expect.stringContaining("Refused: ") });
  });
});

describe("ultra lifecycle: open reviews keep the task blocked", () => {
  // (3) d8-build-graph B/r1: the orchestrator's own reproductions stayed open; the artifact passing its checks does not override them.
  it("a reproduced-open finding keeps the gate closed although every check passes; fixed and re-checked, it completes", async () => {
    const run = await orchestrator();
    const { a, b } = await throughCandidates(run);
    const checkA = await check(run, a);
    const failB = await check(run, b);
    expect((await run.adopt("W1.3")).text).toContain("Adopted W1.3");
    expect((await verify(run, "not passed")).isError).toBe(false);
    const repro = await run.shell("grep -q 'fixed!' greeting.txt"); // reproduces the verifier's counterexample
    expect(repro.isError).toBe(true);
    const integration = await run.shell("sh test/basis.sh");
    expect(integration.isError).toBe(false); // the artifact passes its checks
    const open = [{ finding: "greeting.txt lacks the exclamation mark", source: "W1.5", status: "reproduced-open", evidence: [repro.ref] }];
    const others = [{ id: "W1.4", verdict: "failed", evidence: [failB.ref] }];
    expect(await run.report(complete({ id: "W1.3", evidence: checkA.ref }, others, integration.ref, open))).toContain("reproduced counterexample still open (greeting.txt lacks the exclamation mark)");
    expect(await run.report(complete({ id: "W1.3", evidence: checkA.ref }, others, integration.ref, []))).toContain("a verifier did not pass: classify each of its findings");
    expect(await run.report(blocked("review"))).toBeUndefined();
    // The finding fixed in the workspace and re-checked: complete.
    await run.edit("greeting.txt", "fixed!\n");
    const fixed = await run.shell("grep -q 'fixed!' greeting.txt");
    const after = await run.shell("sh test/basis.sh");
    expect(await run.report(complete({ id: "W1.3", evidence: checkA.ref }, others, after.ref, [{ ...open[0], status: "reproduced-fixed", evidence: [repro.ref, fixed.ref] }]))).toBeUndefined();
  });
});

describe("ultra lifecycle: a fix candidate from an adopted candidate", () => {
  // holoviz-1117 r1, marshmallow-2925 r1, isort-2491 r1, sqlfluff-7615 r1/r2, tox-3904 r1: refused only because its ancestor was adopted.
  it("is adoptable over its ancestor's adoption; the workspace then holds the fix's content (a change of the ancestor it reverted included)", async () => {
    const run = await orchestrator();
    const { a } = await throughCandidates(run);
    await check(run, a);
    expect((await run.adopt("W1.3")).text).toContain("Adopted W1.3 into the workspace: 2 file(s): greeting.txt, helper.txt");
    expect((await verify(run, "not passed")).isError).toBe(false);
    // The fix (W1.6; the verifier took W1.5) starts from W1.3's copy: it changes greeting.txt further and reverts W1.3's helper.txt change
    // (sqlfluff-7615 r2's W1.8 did that to select.py).
    await run.spawn("candidates", [w("fix", "implement", "fix W1.3", ["greeting.txt", "helper.txt"], "W1.3"), w("idle", "implement", "another fix", ["greeting.txt"], "W1.3")], {
      fix: async worker => { await writeFile(join(worker.workspace!, "greeting.txt"), "fixed better\n"); await writeFile(join(worker.workspace!, "helper.txt"), "helper v1\n"); return "done"; },
      idle: () => "done",
    });
    await check(run, run.copy("W1.6"));
    const adopted = await run.adopt("W1.6");
    expect(adopted.text).not.toContain("the workspace changed since the candidate's base");
    expect(adopted.text).toContain("Adopted W1.6 into the workspace: 2 file(s): greeting.txt, helper.txt");
    expect(await readFile(join(run.cwd, "greeting.txt"), "utf8")).toBe("fixed better\n");
    expect(await readFile(join(run.cwd, "helper.txt"), "utf8")).toBe("helper v1\n");
    expect(run.ultra.summary().adoptions).toEqual(["W1.3", "W1.6"]);
  });

  it("stays refused when the workspace changed otherwise: an integration edit after the adoption, another process's change, a sibling over an adopted one", async () => {
    const fixFrom = (run: Run, write: Record<string, string>) => run.spawn("candidates", [w("fix", "implement", "fix W1.3", ["greeting.txt", "helper.txt"], "W1.3"), w("idle", "implement", "another fix", ["greeting.txt"], "W1.3")], {
      fix: async worker => { for (const [path, content] of Object.entries(write)) await writeFile(join(worker.workspace!, path), content); return "done"; },
    });
    // An integration edit after the ancestor's adoption, at a path the fix also changes: adopting the fix would overwrite the edit.
    const edited = await orchestrator();
    await check(edited, (await throughCandidates(edited)).a);
    await edited.adopt("W1.3");
    await edited.edit("greeting.txt", "fixed by hand\n");
    await fixFrom(edited, { "greeting.txt": "fixed better\n" });
    await check(edited, edited.copy("W1.5"));
    expect((await edited.adopt("W1.5")).text).toContain("the workspace changed since the candidate's base in greeting.txt");
    expect(await readFile(join(edited.cwd, "greeting.txt"), "utf8")).toBe("fixed by hand\n");
    // Another process changes a path of the ancestor's adoption after the fix was made: the fix did not see it, refused.
    const outside = await orchestrator();
    await check(outside, (await throughCandidates(outside)).a);
    await outside.adopt("W1.3");
    await fixFrom(outside, { "greeting.txt": "fixed better\n" });
    await writeFile(join(outside.cwd, "helper.txt"), "someone else\n");
    await check(outside, outside.copy("W1.5"));
    const refusal = (await outside.adopt("W1.5")).text;
    expect(refusal).toContain("the workspace changed since the candidate's base in");
    expect(refusal).toContain("helper.txt");
    expect(await readFile(join(outside.cwd, "helper.txt"), "utf8")).toBe("someone else\n");
    expect(await readFile(join(outside.cwd, "greeting.txt"), "utf8")).toBe("fixed\n");
    // A first-round sibling over the adopted candidate: no blind merge.
    const sibling = await orchestrator();
    const copies = await throughCandidates(sibling);
    await check(sibling, copies.a);
    await sibling.adopt("W1.3");
    await sibling.shell(`cd '${copies.b}' && test -s greeting.txt`); // a successful check of its copy
    expect((await sibling.adopt("W1.4")).text).toContain("the workspace changed since the candidate's base in greeting.txt");
    expect(await readFile(join(sibling.cwd, "greeting.txt"), "utf8")).toBe("fixed\n");
  });
});

describe("ultra lifecycle: a continuation's carried state", () => {
  /** The first assignment of a task: `before` calls ahead of the candidates (the old refs carried candidates were spawned at), then candidates; ends unfinished. */
  async function first(before: number) {
    const run = await orchestrator();
    const explored = await run.spawn("exploration", [w("basis", "implement", "acceptance tests", ["test/"]), w("cause", "answer", "hypotheses")], {
      basis: async () => { await mkdir(join(run.cwd, "test"), { recursive: true }); await writeFile(join(run.cwd, "test", "basis.sh"), "grep -q fixed greeting.txt\n"); return "done"; },
    });
    expect(explored.isError).toBe(false);
    for (let i = 0; i < before; i++) await run.shell("true");
    await run.spawn("candidates", [w("a", "implement", "approach A", ["greeting.txt"]), w("b", "implement", "approach B", ["greeting.txt"])], {
      a: async worker => { await writeFile(join(worker.workspace!, "greeting.txt"), "fixed\n"); return "done"; },
      b: async worker => { await writeFile(join(worker.workspace!, "greeting.txt"), "broken\n"); return "done"; },
    });
    return run;
  }
  const carry = async (run: Run) => { await run.ultra.end(false); return orchestrator({ cwd: run.cwd, scratch: run.scratch, carried: structuredClone(run.ultra.state) }); };

  // (4a) Refs restart per assignment while carried candidates kept the ref of the spawn that made them (here T6).
  it("carried candidates are evaluated and adopted with the continuation's fresh checks, whatever ref their old round had", async () => {
    const earlier = await first(4);
    const run = await carry(earlier);
    expect(run.ultra.carried).toBe(true);
    // No check of this assignment yet: refused (the previous assignment's checks never count).
    expect((await run.adopt("W1.3")).text).toContain("Run the checks in W1.3's workspace first");
    const checkA = await check(run, run.copy("W1.3"));
    const adopted = await run.adopt("W1.3");
    expect(adopted.text).not.toContain("Run the checks");
    expect(adopted.text).toContain("Adopted W1.3");
    const failB = await check(run, run.copy("W1.4"));
    expect((await verify(run, "passed")).isError).toBe(false);
    const integration = await run.shell("sh test/basis.sh");
    expect(await run.report(complete({ id: "W1.3", evidence: checkA.ref }, [{ id: "W1.4", verdict: "failed", evidence: [failB.ref] }], integration.ref))).toBeUndefined();
  });

  it("a carried candidate whose copy changed after this assignment's check, or is missing, is not adoptable", async () => {
    const earlier = await first(0);
    const run = await carry(earlier);
    await run.shell("true");
    await run.shell("true"); // this assignment's refs pass the old round's ref
    await check(run, run.copy("W1.3"));
    await writeFile(join(run.copy("W1.3"), "greeting.txt"), "fixed, changed after the check\n");
    expect((await run.adopt("W1.3")).text).toContain("W1.3's copy is not what your checks in it");
    const checkB = await check(run, run.copy("W1.4"));
    await rm(run.copy("W1.4"), { recursive: true, force: true });
    expect(await run.adopt("W1.4")).toMatchObject({ isError: true });
    expect(await readFile(join(run.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
    expect(run.ultra.summary().adoptions).toEqual([]);
    // Its earlier evaluation does not stand for the missing copy either.
    const checkA = await check(run, run.copy("W1.3"));
    await run.adopt("W1.3");
    await verify(run, "passed");
    const integration = await run.shell("sh test/basis.sh");
    expect(await run.report(complete({ id: "W1.3", evidence: checkA.ref }, [{ id: "W1.4", verdict: "failed", evidence: [checkB.ref] }], integration.ref))).toContain("W1.4's copy could not be fingerprinted for this report");
  });

  it("a carried adoption (ref 0) still needs a review of this assignment after it", async () => {
    const earlier = await first(0);
    await check(earlier, earlier.copy("W1.3"));
    await earlier.adopt("W1.3");
    await verify(earlier, "passed");
    const run = await carry(earlier);
    expect(run.ultra.summary()).toMatchObject({ stage: "review", adoptions: ["W1.3"], verificationRounds: 0, carried: true });
    await run.shell("true");
    await run.shell("true");
    const checkA = await check(run, run.copy("W1.3"));
    const failB = await check(run, run.copy("W1.4"));
    const integration = await run.shell("sh test/basis.sh");
    const data = () => complete({ id: "W1.3", evidence: checkA.ref }, [{ id: "W1.4", verdict: "failed", evidence: [failB.ref] }], integration.ref);
    expect(await run.report(data())).toContain("an independent counterexample review is missing");
    expect((await verify(run, "passed")).isError).toBe(false);
    expect(await run.report(data())).toBeUndefined();
    expect(run.ultra.summary()).toMatchObject({ stage: "complete", gate: "passed" });
  });

  // (4d) isort-2491 r1's continuation was recorded "accepted as incomplete (stopped at complete)"; d8-build-graph r1's "stage: integration" with nothing run.
  it("no stage is recorded as reached that did not run: a blocked report naming a later stage keeps the runtime's stage", async () => {
    const earlier = await first(0);
    await check(earlier, earlier.copy("W1.3"));
    await earlier.adopt("W1.3");
    await verify(earlier, "passed");
    const run = await carry(earlier);
    for (const stage of ["complete", "integration"]) {
      expect(await run.report(blocked(stage))).toBeUndefined();
      expect(run.ultra.summary()).toMatchObject({ stage: "review", gate: "accepted as incomplete (stopped at review)" });
      expect(run.ultra.lines()[0]).not.toMatch(/stage (complete|integration)|stopped at (complete|integration)/);
    }
    expect(await run.report(blocked("candidates"))).toBeUndefined();
    expect(run.ultra.summary()).toMatchObject({ stage: "candidates", gate: "accepted as incomplete (stopped at candidates)" });
  });
});

describe("ultra lifecycle: report schema friction from the records", () => {
  /** A finished run up to the report: adopted W1.3 after a round that did not pass, the finding reproduced, integration checked. */
  async function reported() {
    const run = await orchestrator();
    const { a, b } = await throughCandidates(run);
    const checkA = await check(run, a);
    const failB = await check(run, b);
    await run.adopt("W1.3");
    await verify(run, "not passed");
    const repro = await run.shell("grep -q fixed greeting.txt");
    const integration = await run.shell("sh test/basis.sh");
    const data = (review: unknown[]) => complete({ id: "W1.3", evidence: checkA.ref }, [{ id: "W1.4", verdict: "failed", evidence: [failB.ref] }], integration.ref, review);
    return { run, repro, data };
  }

  // 10 rejections in 9 B units: "/review/N/source: must not have more than 40 characters" (labels of 42-99 characters).
  it("review.source is a free-text label: the recorded labels pass; it never stands for evidence", async () => {
    const { run, repro, data } = await reported();
    const sources = ["W1.7 compatibility-review, [orche ref T28]", "W1.9 syntax-review and W1.10 pipeline-review", "Previous verification worker W1.6; independently reproduced in previous-assignment T40.",
      "Prior final-ownership-review/final-style-review;pooled_duplication and duplicated-inline-directives"];
    const review = sources.map((source, index) => ({ finding: `finding ${index + 1} of the verifier`, source, status: "refuted", evidence: [repro.ref] }));
    expect(await run.report(data(review))).toBeUndefined();
    // A label is no evidence: a reproduced finding needs a ref of the orchestrator's own run.
    expect(await run.report(data([{ finding: "a reproduced finding", source: sources[2], status: "reproduced-fixed" }]))).toContain("is marked reproduced without a ref of your own run");
    expect(await run.report(data([{ finding: "x", source: "s".repeat(301), status: "refuted", evidence: [repro.ref] }]))).toContain("/review/0/source");
  });

  // 5 rejections "/stage: must be equal to constant": "verification" (d8-build-graph r1, marshmallow-2925 r1, isort-2491 r2), "reporting", "report-gate".
  it('a blocked report may name its stop "verification" (the review stage); done still needs "complete", and an unknown stage is refused with the stage names', async () => {
    const run = await orchestrator();
    const { a } = await throughCandidates(run);
    await check(run, a);
    await run.adopt("W1.3");
    expect(await run.report(blocked("verification"))).toBeUndefined();
    expect(run.ultra.summary()).toMatchObject({ stage: "review", gate: "accepted as incomplete (stopped at review)" });
    expect(await run.report({ status: "done", ultra: { stage: "verification" } })).toContain('status "done" needs stage "complete"');
    const unknown = await run.report(blocked("report-gate"));
    expect(unknown).toContain("/stage");
    expect(unknown).toContain("criteria|exploration|candidates|evaluation|selection|review|integration");
  });
});
