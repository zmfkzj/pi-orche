/**
 * Advisor / reviewer benchmark (docs/advisor-reviewer-bench.md): pure parts of the protocol, shared by the runner, the driver and the
 * analysis, and unit-tested without any model (test/experiments/advisor-reviewer.test.ts).
 *
 * Three arms, the same task, workspace, worker model/effort, tools and limits:
 * - `baseline`: one orche_task implement worker (single workflow, no orche_spawn) solves the task and reports.
 * - `advisor`: the same worker; when its first Task DAG (task_plan) exists, a fresh READ-ONLY advisor (orche_task `answer` role on the
 *   advisor model) reads the task, that plan and the workspace and writes advice. The advice reaches the worker once: injected into its
 *   running assignment (orche_task_message, the product's main→worker channel), or, when the worker reported before the advice was
 *   ready, as one follow-up assignment to the same worker (its one revision opportunity).
 * - `reviewer`: the same worker; after its report a fresh READ-ONLY reviewer (orche_task `verify` role on the reviewer model) checks the
 *   workspace against the task and reports passed true/false with issues. passed:false gives the worker one follow-up assignment (the
 *   same worker, its context intact) to fix or rebut the findings. No second review.
 * Final grading is independent of every model: visible + hidden tests of the fixture, never the advisor's or reviewer's verdict.
 */

export const ARMS = ["baseline", "advisor", "reviewer"] as const;
export type Arm = typeof ARMS[number];

/** The models under test (user request: worker Opus 5.5, advisor/reviewer GPT 6.1 Sol, all effort high). */
export const MODELS = {
  worker: { provider: "cliproxyapi", id: "claude-opus-5-5", thinking: "high" },
  helper: { provider: "cliproxyapi", id: "gpt-6.1-sol", thinking: "high" },
} as const;

/** Limits (identical across arms). The worker's per-assignment cap is orche's assignment deadline with no extension. */
export const LIMITS = {
  /** orche limits.assignmentMs for every assignment (worker, revision, advisor, reviewer); maxExtensions 0. */
  assignmentMs: 25 * 60_000,
  /** Harness abort for an advisor or reviewer assignment (they are consultations, not the work). */
  helperMs: 12 * 60_000,
  /** orche limits.assignmentRequests (soft request budget per assignment), the product default. */
  assignmentRequests: 150,
  /** Revision assignments the worker may get after advice or review. */
  revisions: 1,
  /** Outer guard for one run process (everything included). */
  runGuardMs: 90 * 60_000,
} as const;

export interface TaskSpec {
  id: string;
  kind: "suite" | "lcb" | "swe";
  title: string;
  /** The task text the worker gets (Original request). */
  instruction: string;
}

const CONSTRAINTS = "Constraints and non-goals: work only inside this workspace (your scratch directory is fine for temporary files); no git commits; no network access is needed or available; do not weaken or delete existing tests.";

/** The worker's assignment, identical in every arm (the single-workflow hand-off format main uses). */
export function workerRequest(task: TaskSpec): string {
  const r = task.kind === "lcb"
    ? ["R1: solution.py in the workspace root reads the input from standard input and prints the correct answer for every valid input of problem.md, within the stated time limit (CPython, standard library only)."]
    : task.kind === "swe"
    ? ["R1: The issue in the Original request below is resolved in this repository's code, including every behaviour its Interface section (if any) states.", "R2: The project's existing tests still pass (pytest), with regression coverage for the fix."]
    : ["R1: The task in the Original request below is fully implemented in this workspace, meeting every contract it states.", "R2: The project's test suite (node --test) passes, with regression coverage for the change."];
  return [
    `Intent/Purpose: solve the coding task "${task.title}" in this workspace; it is graded afterwards by tests you do not see.`,
    ...r,
    CONSTRAINTS,
    "Assumptions: the workspace is a fresh git repository whose first commit is the starting state.",
    "Original request",
    task.instruction,
  ].join("\n");
}

/** Quote a block so that none of its lines is read as a requirement or a section header of the helper's own assignment. */
export const quote = (text: string): string => text.split("\n").map(line => `> ${line}`).join("\n");

/** The advisor's assignment (orche_task answer role): no R-ids of its own, the worker's task and plan quoted after "Original request". */
export function advisorRequest(task: TaskSpec, plan: string | undefined): string {
  return [
    "Intent/Purpose: you are the ADVISOR of another coding agent (the worker) that is solving the task quoted below in this same workspace right now. Give it the advice that most raises its chance of passing hidden tests: wrong or risky parts of its plan, requirements or edge cases it is likely to miss, a better approach when its approach is wrong or too slow, and how to verify. Your report summary is delivered to the worker verbatim, once; it decides what to do with it.",
    "Constraints: read-only (never edit workspace files; temporary experiments only in your scratch directory). The worker keeps working while you think, so be quick (about 10 minutes at most). Do not write the full solution: at most short snippets (15 lines each). Summary at most 400 words, concrete and prioritized; no preamble. report_result {kind:\"answer\", summary: <the advice>, data:{evidence:[what you read or ran]}}.",
    `The worker's current plan (its task_plan): ${plan ? `\n${quote(plan)}` : "(no plan recorded yet)"}`,
    "Original request (the worker's assignment, quoted):",
    quote(workerRequest(task)),
  ].join("\n");
}

/** The reviewer's assignment (orche_task verify role). */
export function reviewerRequest(task: TaskSpec, workerSummary: string): string {
  return [
    "Intent/Purpose: you are an independent REVIEWER of another coding agent's (the worker's) finished result for the task quoted below. The workspace holds its result; `git diff HEAD` and `git status` show the change against the starting commit. Decide whether the result fully meets the task and would pass hidden tests: check every stated requirement and contract, run the visible tests/examples, and probe edge cases and performance with your own quick checks.",
    "Constraints: read-only (never edit workspace files; experiments only in your scratch directory). About 10 minutes at most. report_result {kind:\"verify\", summary, data:{passed: true only when you found no defect, evidence:[commands and outcomes], issues:[{file, description}] with each concrete defect, the failing input or the violated requirement, and the fix direction}}. Your issues are sent to the worker, which gets one chance to fix them.",
    "The worker's report:",
    quote(workerSummary.slice(0, 4000)),
    "Original request (the worker's assignment, quoted):",
    quote(workerRequest(task)),
  ].join("\n");
}

/** The worker's one follow-up assignment after review (passed:false) or after advice that arrived after its report. */
export function revisionRequest(task: TaskSpec, source: "advisor" | "reviewer", feedback: string): string {
  const who = source === "reviewer"
    ? "An independent reviewer (another model, read-only) checked your result for the same task and reported problems"
    : "An advisor (another model, read-only) reviewed your plan for the same task; its advice arrived after you had reported";
  return [
    `Intent/Purpose: ${who}. Re-check its points against the task and your code; fix every valid point, reject the ones you can show are wrong, and report again.`,
    `R1: Every ${source} point is either addressed in the workspace or rejected with evidence.`,
    "R2: The original task (your previous assignment, same workspace) is fully met.",
    CONSTRAINTS,
    "Assumptions: this is your only follow-up; no further review follows.",
    `${source === "reviewer" ? "Reviewer findings" : "Advisor notes"}:`,
    quote(feedback.slice(0, 6000)),
    "Original request (unchanged; quoted from your previous assignment):",
    quote(task.instruction),
  ].join("\n");
}

/** The text injected into the running worker when the advice is ready in time. */
export function adviceMessage(advice: string): string {
  return `Advisor notes (an independent advisor model read your plan and the workspace; advisory only, verify before acting on them):\n${advice.slice(0, 6000)}`;
}

export interface Cell { task: string; arm: Arm; repeat: number }

/**
 * Run order: repeat-major (every cell of repeat 1 before repeat 2), tasks in the given order, and within each task the three arms in
 * a rotated order (task index + repeat), so no arm is systematically first or last and the arms of one task run close together in time.
 */
export function schedule(tasks: readonly string[], arms: readonly Arm[], repeats: number): Cell[] {
  const cells: Cell[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    tasks.forEach((task, index) => {
      for (let k = 0; k < arms.length; k++) cells.push({ task, arm: arms[(index + repeat - 1 + k) % arms.length]!, repeat });
    });
  }
  return cells;
}

export const cellId = (cell: Cell): string => `${cell.task}/${cell.arm}/r${cell.repeat}`;

/** AtCoder-style comparison: whitespace-separated tokens equal; numeric tokens equal within 1e-6 when either has a decimal point. */
export function sameOutput(actual: string, expected: string): boolean {
  const a = actual.trim().split(/\s+/).filter(Boolean), e = expected.trim().split(/\s+/).filter(Boolean);
  if (a.length !== e.length) return false;
  return a.every((token, index) => {
    const want = e[index]!;
    if (token === want) return true;
    if (!/[.eE]/.test(token + want)) return false;
    const x = Number(token), y = Number(want);
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(y));
  });
}

export interface UsageTotals { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; reasoningReported: number; cost: number; errors: number; unknownUsage: number }
export const emptyUsage = (): UsageTotals => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, reasoningReported: 0, cost: 0, errors: 0, unknownUsage: 0 });

/** Usage of the assistant messages of one pi session JSONL text, per `provider/model`. */
export function usageByModel(jsonl: string): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {};
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant") continue;
    const key = `${message.provider}/${message.model}`;
    const total = out[key] ??= emptyUsage();
    total.requests++;
    if (message.stopReason === "error") total.errors++;
    const usage = message.usage;
    if (!usage || typeof usage.input !== "number") { total.unknownUsage++; continue; }
    total.input += usage.input; total.output += usage.output ?? 0; total.cacheRead += usage.cacheRead ?? 0; total.cacheWrite += usage.cacheWrite ?? 0;
    if (typeof usage.reasoning === "number") { total.reasoning += usage.reasoning; total.reasoningReported++; }
    total.cost += usage.cost?.total ?? 0;
  }
  return out;
}

export function addUsage(into: UsageTotals, add: UsageTotals): UsageTotals {
  for (const key of Object.keys(into) as (keyof UsageTotals)[]) into[key] += add[key];
  return into;
}

/** The last task_plan arguments and the tool calls of one session JSONL text (advisor trigger and leak audit). */
export function sessionToolCalls(jsonl: string): { name: string; arguments: any; timestamp?: string }[] {
  const calls: { name: string; arguments: any; timestamp?: string }[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) if (part?.type === "toolCall") calls.push({ name: part.name, arguments: part.arguments, ...(entry.timestamp ? { timestamp: entry.timestamp } : {}) });
  }
  return calls;
}

/** Compact plan text for the advisor: one line per node. */
export function formatPlan(args: any): string | undefined {
  const nodes = Array.isArray(args?.nodes) ? args.nodes : undefined;
  if (!nodes?.length) return undefined;
  return nodes.map((node: any) => `- ${node.id} [${node.status}]${node.dependsOn?.length ? ` after ${node.dependsOn.join(",")}` : ""}: ${node.title}${node.note ? ` — ${String(node.note).slice(0, 300)}` : ""}`).join("\n");
}

/**
 * Leak audit: tool calls whose arguments mention where hidden tests or reference solutions live. The workspace never contains them;
 * a match means a model went looking outside it.
 */
export const LEAK_PATTERNS = [/fixtures\/(suite|advisor-bench)/, /\/hidden\b/, /\breference\//, /iso-token/, /\bgold\b/, /results\/(advisor-reviewer\/(calibration|main|smoke)|iso-token)/,
  // SWE tasks: the upstream repository (later commits contain the fix) and package downloads are off limits.
  /github\.com|pypi\.org|\bgit\s+(clone|fetch|pull)\b|\bpip\s+(install|download)\b|\bcurl\b|\bwget\b/];
export function leakHits(calls: readonly { name: string; arguments: any }[]): string[] {
  const hits: string[] = [];
  for (const call of calls) {
    const text = JSON.stringify(call.arguments ?? {});
    if (LEAK_PATTERNS.some(pattern => pattern.test(text))) hits.push(`${call.name}: ${text.slice(0, 300)}`);
  }
  return hits;
}

export type Outcome = "pass" | "fail" | "timeout" | "infra";
/**
 * Final outcome of a run: `infra` when the harness or the provider failed before the worker could produce a result (no grade possible
 * or every request errored) or the grader itself failed, `timeout` when the worker's assignment hit its deadline and the grade fails, otherwise the grade.
 */
export function classify(run: { grade?: { passed: boolean; error?: string }; infraError?: string; workerTimedOut?: boolean }): Outcome {
  if (run.infraError || !run.grade || run.grade.error) return "infra";
  if (run.grade.passed) return "pass";
  return run.workerTimedOut ? "timeout" : "fail";
}
