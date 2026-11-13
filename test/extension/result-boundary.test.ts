import { describe, expect, it } from "vitest";
import { delegationRules } from "../../src/extension/mode.js";
import { assignmentPrompt, subWorkerPrompt } from "../../src/extension/workers.js";
import { jobResultContent, type Job } from "../../src/extension/jobs.js";

/**
 * The main/worker boundary for results (user correction 2026-11-11: main acting as the reviewer was not the intended behaviour).
 * Main captures and states the requirements and reports results; the delegated worker owns interpretation, implementation,
 * validation and corrections. Explicit prose, not derived from the implementation under test.
 */
const MAIN_REPORTS = [
  "acceptance belongs to the worker and rests on the checks it ran and reports, not on a review of yours",
  "Results: the worker owns acceptance.",
  "do not re-judge the readings, designs or policy interpretations it chose, do not declare a reported completion wrong yourself, and never start a correction round or replace a worker on such a judgment of your own",
  "Report the result faithfully: the checklist as the worker's self-report, the checks it names, the readings it chose, and its unresolved, unverified and blocked items as such.",
  "a different reading goes to the same worker only when the user asks for it",
  "When the result arrives (attached result or message), report it to the user as the result rules below say.",
];
/** Kept: user follow-ups, the worker's own unmet/partial/blocked report, timeouts, gone workers, explicit verify requests. */
const KEPT = [
  "user follow-ups go to the SAME worker (pass its id in `worker`)",
  "A requirement the worker itself reported unmet or partial, or a blocked report, is remaining work, not a verdict of yours",
  "passing its reported items and evidence unchanged, without a diagnosis of your own",
  "When a requirement remains unmet or partial in 2 consecutive REPORTED results of that worker, hand ONLY the unmet items to a NEW worker",
  "A timeout is not an unmet result and never counts towards that rule: continue a timed-out assignment with the SAME worker and task",
  "a worker that is gone (/orche stop, a reload or session switch, a capability or mode change) is continued by a NEW worker briefed from its transcript",
  "Send a separate verify assignment only when the user",
];
/** The earlier main review that the user said was not intended. */
const REMOVED = [
  "Check every reported ambiguity's chosen reading",
  "send a correction",
  "Review the result",
  "with what is wrong",
  "review it as below",
  "requirements and acceptance",
  "a worker's report is not acceptance",
  "problems and user follow-ups",
];

const combos = [
  ["single", { spawn: true }], ["single", { spawn: false }],
  ["strong", { spawn: true }], ["strong", { spawn: false }],
  ["ultra", {}], ["mdsd", {}],
] as const;

describe("main reports results; the worker owns acceptance (every delegating mode)", () => {
  it.each(combos)("%s %j: main is told to report, not to review, and keeps operational follow-ups", (mode, options) => {
    const rules = delegationRules(mode, options);
    for (const text of [...MAIN_REPORTS, ...KEPT]) expect(rules).toContain(text);
    for (const text of REMOVED) expect(rules).not.toContain(text);
  });

  it("direct mode has no delegation, so no result rules", () => {
    for (const text of ["Results: the worker owns acceptance.", ...REMOVED]) expect(delegationRules("direct")).not.toContain(text);
  });
});

const request = "Intent/Purpose: x\nR1: y\nOriginal request\nz";
const IMPLEMENT_DUTIES = [
  "settle it from the Original request text and the instructions, documents or policies the request names as authoritative: choose the reading closest to them, implement it, and report it in data.ambiguities",
  "a conflict those sources cannot settle and only the user can decide also goes in data.unresolved",
  "running the project's relevant checks and iterating until they pass",
  "Before reporting, check the result yourself against every requirement and the Original request (outputs that git does not track included) and correct what falls short within this assignment",
  "you own acceptance, and main neither intervenes while you run nor reviews or corrects your result afterwards",
  "every met item needs verifiedBy, otherwise report it partial",
];
const ANSWER_DUTIES = [
  "Settle ambiguous readings from the Original request and the instructions or sources it names as authoritative, and check the answer against every requirement before reporting",
  "you own its correctness, and main does not review or correct it afterwards",
  "A question only the user can decide goes in data.unresolved, not into a guessed answer.",
  "Checklist is required when the request contains R-ids",
];

describe("the delegated assignment carries the verification main no longer does", () => {
  it.each(["single", "strong", "ultra", "mdsd"] as const)("%s: implement and answer workers own interpretation, checks and corrections, with or without orchestration", mode => {
    for (const orchestrate of [true, false]) {
      const implement = assignmentPrompt({ role: "implement", request, mainMode: mode, orchestrate }, []);
      for (const duty of IMPLEMENT_DUTIES) expect(implement).toContain(duty);
      const answer = assignmentPrompt({ role: "answer", request, mainMode: mode, orchestrate }, []);
      for (const duty of ANSWER_DUTIES) expect(answer).toContain(duty);
      expect(answer).toContain("Never change files.");
    }
  });

  it("sub-workers keep their own role texts: the orchestrator that spawned them reviews them", () => {
    const sub = subWorkerPrompt({ id: "W1.1", name: "part", role: "implement", reason: "parallelism", request: "Do the part.", files: ["a.ts"] } as Parameters<typeof subWorkerPrompt>[0], "W1", [], false);
    expect(sub).toContain("Implement completely, preserving unrelated changes.");
    expect(sub).not.toContain("you own acceptance");
  });
});

describe("a background job's result message asks main to report it, not to review it", () => {
  const job = (status: Job["status"]): Job => ({ id: "J1", role: "implement", request: "r", worker: "W1", startedAt: 0, finishedAt: 60_000, status, result: { text: "orche task W1 (implement, 60s)", isError: false }, abort: new AbortController(), done: Promise.resolve(), settled: true });
  it("done: report as the result rules say; the worker owns acceptance", () => {
    const content = jobResultContent(job("done"));
    expect(content).toContain("Report it to the user as the single-workflow result rules say (the worker owns acceptance; do not review it yourself).");
    expect(content).not.toMatch(/Review it/);
  });
  it("cancelled and failed jobs keep their operational guidance", () => {
    expect(jobResultContent(job("cancelled"))).toContain("The job was cancelled; tell the user what was done so far.");
    expect(jobResultContent(job("failed"))).toContain("decide with them whether to retry (same worker for a follow-up)");
  });
});
