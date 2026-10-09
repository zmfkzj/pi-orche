/**
 * Task ledger of the single workflow (Phase 1 of docs/specialist-orchestration.md).
 *
 * LLM sessions are caches: a worker compacts at 50% and disappears on reload, idle expiry or pool
 * eviction. The ledger is the task state that must survive all of that, kept outside every LLM
 * context: the user's original requests, each assignment's requirements with the status the
 * worker last reported, the readings it chose for ambiguous requirements, and a short history.
 * Workers see a rendered projection when they compact; the main session sees a short summary;
 * a restored ledger briefs a fresh worker when the old one is gone.
 *
 * Persistence is a log of small events (`create`, `handoff`, `result`, `failure`, `plan`), one session
 * entry each, never a copy of the whole ledger: the live state is built by the same `applyEvent`
 * that a restore replays, so the two cannot drift.
 *
 * `plan` is the resume checkpoint: every Task DAG a worker of the task gets accepted by task_plan is persisted at once (a compact
 * copy: node statuses and checkpoints), so an assignment that is stopped by a timeout leaves its finished nodes, their evidence and
 * the remaining nodes behind for the worker that continues it. Only what was recorded by task_plan survives; nothing after the
 * last accepted call (and no private reasoning) can be restored.
 */
import { requirementDefinitions, type Ambiguity, type ChecklistItem } from "../orchestration/result-schemas.js";

/** Session entry type (`pi.appendEntry`, not sent to the model) of one ledger event. */
export const LEDGER_ENTRY_TYPE = "orche-ledger";
/** Custom message re-introducing the ledger summary into the main session after it compacted. */
export const LEDGER_SUMMARY_TYPE = "orche-ledger-summary";

export const LEDGER_LIMITS = {
  originals: 10,
  originalChars: 4_000,
  requirements: 60,
  requirementChars: 1_000,
  decisions: 30,
  history: 50,
  itemChars: 300,
  workerChars: 8_000,
  summaryChars: 2_000,
  checks: 20,
  findings: 30,
} as const;

export type RequirementStatus = "open" | "met" | "partial" | "unmet";
const STATUSES: readonly string[] = ["open", "met", "partial", "unmet"];
export interface LedgerRequirement {
  /** Assignment (1-based) that declared it. Requirement ids restart in every hand-off, so (assignment, id) is the identity. */
  assignment: number;
  id: string;
  text: string;
  status: RequirementStatus;
  evidence?: string;
  verifiedBy?: string;
}
/** A reading chosen for ambiguous wording: by the worker (reported in its result) or by the Framer before the worker started (`quote` is the wording). */
export interface LedgerDecision { assignment: number; id?: string; readings: string[]; chosen: string; by: "worker" | "framer"; quote?: string; askUser?: boolean }
/** The risk assessment of an implement result and, when it ran, the Verifier's verdict (`error`: the Verifier failed). */
export interface LedgerCheck { assignment: number; at: number; score: number; threshold: number; decision: "verify" | "skip"; reason: string; verdict?: "pass" | "fail" | "error" }
export type FindingState = "open" | "fixed" | "disputed" | "unchecked" | "minor";
export interface LedgerFinding { assignment: number; id: string; severity: "blocking" | "minor"; requirement?: string; claim: string; status: FindingState; probe?: string; detail?: string }
export interface LedgerHistoryItem { assignment: number; at: number; role: string; worker: string; status: string; summary: string; record?: string }
export interface LedgerWorker { worker: string; model?: string; thinking?: string; sessionFile?: string }
/** The worker that last took the task; `live` is runtime state (false once that worker is gone), never persisted. */
export interface LedgerPrimary extends LedgerWorker { live: boolean }
export interface TaskLedger {
  v: 2;
  taskId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** Assignments handed off so far. */
  assignments: number;
  originalRequests: { assignment: number; text: string }[];
  requirements: LedgerRequirement[];
  decisions: LedgerDecision[];
  primary?: LedgerPrimary;
  history: LedgerHistoryItem[];
  /** Risk assessments and Verifier verdicts (single pipeline v2), oldest first. Absent in ledgers written before they existed. */
  checks?: LedgerCheck[];
  /** Verifier findings with their latest state. */
  findings?: LedgerFinding[];
  /** The last Task DAG recorded for this task (the resume checkpoint); absent until a worker's task_plan was accepted. */
  plan?: LedgerPlan;
}

/** A compact Task DAG node: what a continuation needs (status, requirement coverage, the node's checkpoint). */
export interface LedgerPlanNode {
  id: string;
  title: string;
  status: string;
  covers: string[];
  phase?: "integrate";
  checkpoint?: { result: string; verification: string; evidence?: string[]; open?: string };
}
/** The last Task DAG of the task: which assignment and worker recorded it, and when. */
export interface LedgerPlan { assignment: number; worker: string; at: number; nodes: LedgerPlanNode[] }

export interface RequirementUpdate { id: string; status: Exclude<RequirementStatus, "open">; evidence: string; verifiedBy?: string }
interface EventBase { v: 1; taskId: string; at: number }
export interface CreateEvent extends EventBase { event: "create"; cwd: string }
/** A hand-off: its original request when new, its requirement declarations (statuses carried from the previous assignment), the worker taking it, and the readings the Framer settled. */
export interface HandoffEvent extends EventBase { event: "handoff"; assignment: number; original?: string; requirements: LedgerRequirement[]; primary: LedgerWorker; decisions?: LedgerDecision[] }
export interface ResultEvent extends EventBase { event: "result"; assignment: number; statuses: RequirementUpdate[]; decisions: LedgerDecision[]; history: LedgerHistoryItem }
export interface FailureEvent extends EventBase { event: "failure"; history: LedgerHistoryItem }
/** The risk assessment of the current assignment's result and, when the Verifier ran, its findings. */
export interface CheckEvent extends EventBase { event: "check"; assignment: number; check: LedgerCheck; findings: LedgerFinding[] }
/** orche re-ran the blocking findings' probes after the fix round. */
export interface RecheckEvent extends EventBase { event: "recheck"; assignment: number; statuses: { id: string; status: FindingState; detail?: string }[] }
/** A worker's task_plan was accepted: the compact Task DAG, persisted at once (the resume checkpoint). */
export interface PlanEvent extends EventBase { event: "plan"; assignment: number; worker: string; nodes: LedgerPlanNode[] }
export type LedgerEvent = CreateEvent | HandoffEvent | ResultEvent | FailureEvent | CheckEvent | RecheckEvent | PlanEvent;

const clip = (text: string, max: number): string => {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const oneLine = (text: string, max: number = LEDGER_LIMITS.itemChars): string => clip(text.replace(/\s+/g, " "), max);
const normalized = (text: string): string => text.replace(/\s+/g, " ").trim();
/**
 * The header that starts the verbatim user request in a single-workflow hand-off (the one `requirementDefinitions` stops at),
 * with an optional parenthetical such as "(verbatim)" and a colon.
 */
const ORIGINAL_HEADER = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?Original(?:[ \t]+user)?[ \t]+request\b(?:[ \t]*\([^)\n]*\))?(?:\*\*)?[ \t]*:?[ \t]*/i;

/** The verbatim user request of a hand-off: everything after its Original request header; undefined without one. */
export function originalRequestOf(handoff: string): string | undefined {
  const lines = handoff.split(/\r?\n/);
  const index = lines.findIndex(line => ORIGINAL_HEADER.test(line));
  if (index < 0) return undefined;
  const sameLine = lines[index]!.replace(ORIGINAL_HEADER, "");
  const text = [sameLine, ...lines.slice(index + 1)].join("\n").trim();
  return text || undefined;
}

export function createLedger(taskId: string, cwd: string, now: number = Date.now()): TaskLedger {
  return { v: 2, taskId, cwd, createdAt: now, updatedAt: now, assignments: 0, originalRequests: [], requirements: [], decisions: [], history: [] };
}
/** A new task: its empty ledger and the `create` event to persist. */
export function startLedger(taskId: string, cwd: string, at: number = Date.now()): { ledger: TaskLedger; event: CreateEvent } {
  return { ledger: createLedger(taskId, cwd, at), event: { v: 1, event: "create", taskId, cwd, at } };
}

/** Keep the first item (where the task came from) and the newest ones. */
function boundKeepingFirst<T>(items: T[], max: number): T[] {
  return items.length <= max ? items : [items[0]!, ...items.slice(items.length - max + 1)];
}
const trimOldest = <T>(items: T[], max: number): void => { if (items.length > max) items.splice(0, items.length - max); };

/** Apply one event to its ledger (the live path and the restore path alike). Copies the event's data; never keeps references to it. */
export function applyEvent(ledger: TaskLedger, event: Exclude<LedgerEvent, CreateEvent>): void {
  switch (event.event) {
    case "handoff": {
      ledger.assignments = event.assignment;
      if (event.original !== undefined) ledger.originalRequests = boundKeepingFirst([...ledger.originalRequests, { assignment: event.assignment, text: event.original }], LEDGER_LIMITS.originals);
      ledger.requirements.push(...event.requirements.map(item => ({ ...item })));
      // Drop the oldest earlier-assignment requirements first; the current assignment's are never dropped.
      while (ledger.requirements.length > LEDGER_LIMITS.requirements) {
        const oldest = ledger.requirements.findIndex(item => item.assignment !== event.assignment);
        if (oldest < 0) break;
        ledger.requirements.splice(oldest, 1);
      }
      ledger.primary = { ...event.primary, live: true };
      if (event.decisions?.length) {
        ledger.decisions.push(...event.decisions.map(item => ({ ...item, readings: [...item.readings] })));
        trimOldest(ledger.decisions, LEDGER_LIMITS.decisions);
      }
      break;
    }
    case "result": {
      for (const update of event.statuses) {
        const requirement = ledger.requirements.find(entry => entry.assignment === event.assignment && entry.id === update.id);
        if (!requirement) continue;
        requirement.status = update.status;
        requirement.evidence = update.evidence;
        if (update.verifiedBy) requirement.verifiedBy = update.verifiedBy; else delete requirement.verifiedBy;
      }
      ledger.decisions.push(...event.decisions.map(item => ({ ...item, readings: [...item.readings] })));
      trimOldest(ledger.decisions, LEDGER_LIMITS.decisions);
      ledger.history.push({ ...event.history });
      trimOldest(ledger.history, LEDGER_LIMITS.history);
      break;
    }
    case "check":
      (ledger.checks ??= []).push({ ...event.check });
      trimOldest(ledger.checks, LEDGER_LIMITS.checks);
      (ledger.findings ??= []).push(...event.findings.map(item => ({ ...item })));
      trimOldest(ledger.findings, LEDGER_LIMITS.findings);
      break;
    case "recheck":
      for (const update of event.statuses) {
        const finding = ledger.findings?.find(entry => entry.assignment === event.assignment && entry.id === update.id);
        if (!finding) continue;
        finding.status = update.status;
        if (update.detail) finding.detail = update.detail; else delete finding.detail;
      }
      break;
    case "failure":
      ledger.history.push({ ...event.history });
      trimOldest(ledger.history, LEDGER_LIMITS.history);
      break;
    case "plan":
      ledger.plan = { assignment: event.assignment, worker: event.worker, at: event.at, nodes: event.nodes.map(copyPlanNode) };
      break;
  }
  ledger.updatedAt = event.at;
}

/**
 * A new assignment was handed off to `primary`: count it, keep its original request when new, and add its requirement
 * declarations. A requirement restated unchanged from the previous assignment keeps its last status. Returns the applied event.
 */
export function recordHandoff(ledger: TaskLedger, handoff: { request: string; primary: LedgerWorker; at?: number; decisions?: readonly Omit<LedgerDecision, "assignment" | "by">[] }): HandoffEvent {
  const assignment = ledger.assignments + 1;
  const found = originalRequestOf(handoff.request);
  const original = found === undefined ? undefined : clip(found, LEDGER_LIMITS.originalChars);
  const isNew = original !== undefined && !ledger.originalRequests.some(item => normalized(item.text) === normalized(original));
  const previous = ledger.requirements.filter(item => item.assignment === assignment - 1);
  const requirements = [...requirementDefinitions(handoff.request)].map(([id, declared]): LedgerRequirement => {
    const text = clip(declared, LEDGER_LIMITS.requirementChars);
    const carried = previous.find(item => item.id === id && item.text === text);
    return { assignment, id, text, status: carried?.status ?? "open", ...(carried?.evidence ? { evidence: carried.evidence } : {}), ...(carried?.verifiedBy ? { verifiedBy: carried.verifiedBy } : {}) };
  });
  const decisions = (handoff.decisions ?? []).map((item): LedgerDecision => ({ assignment, ...(item.id ? { id: item.id } : {}), readings: item.readings.map(reading => oneLine(reading)), chosen: oneLine(item.chosen), by: "framer", ...(item.quote ? { quote: oneLine(item.quote, 200) } : {}), ...(item.askUser ? { askUser: true } : {}) }));
  const event: HandoffEvent = { v: 1, event: "handoff", taskId: ledger.taskId, at: handoff.at ?? Date.now(), assignment, ...(isNew ? { original } : {}), requirements, primary: { ...handoff.primary }, ...(decisions.length ? { decisions } : {}) };
  applyEvent(ledger, event);
  return event;
}

const historyItem = (ledger: TaskLedger, item: { role: string; worker: string; status: string; summary: string; record?: string; at: number }): LedgerHistoryItem => ({
  assignment: ledger.assignments, at: item.at, role: item.role, worker: item.worker, status: item.status,
  summary: oneLine(item.summary.split(/\r?\n/).find(line => line.trim()) ?? ""), ...(item.record ? { record: item.record } : {}),
});

/** The worker reported a result for the current assignment. Returns the applied event. */
export function recordResult(ledger: TaskLedger, result: {
  role: string; worker: string; status: string; summary: string;
  checklist?: readonly ChecklistItem[]; ambiguities?: readonly Ambiguity[]; record?: string; at?: number;
}): ResultEvent {
  const assignment = ledger.assignments;
  const at = result.at ?? Date.now();
  const statuses = (result.checklist ?? []).filter(item => ledger.requirements.some(entry => entry.assignment === assignment && entry.id === item.id))
    .map((item): RequirementUpdate => ({ id: item.id, status: item.status, evidence: oneLine(item.evidence), ...(item.verifiedBy ? { verifiedBy: oneLine(item.verifiedBy, 200) } : {}) }));
  const decisions: LedgerDecision[] = [];
  for (const item of result.ambiguities ?? []) {
    const decision: LedgerDecision = { assignment, ...(item.id ? { id: item.id } : {}), readings: item.readings.map(reading => oneLine(reading)), chosen: oneLine(item.chosen), by: "worker" };
    const known = (entry: LedgerDecision) => entry.assignment === assignment && entry.id === decision.id && entry.chosen === decision.chosen;
    if (!ledger.decisions.some(known) && !decisions.some(known)) decisions.push(decision);
  }
  const event: ResultEvent = { v: 1, event: "result", taskId: ledger.taskId, at, assignment, statuses, decisions, history: historyItem(ledger, { ...result, at }) };
  applyEvent(ledger, event);
  return event;
}

/** The assignment ended without a result (failed, timed out, cancelled). Returns the applied event. */
export function recordFailure(ledger: TaskLedger, failure: { role: string; worker: string; status: string; reason: string; record?: string; at?: number }): FailureEvent {
  const at = failure.at ?? Date.now();
  const event: FailureEvent = { v: 1, event: "failure", taskId: ledger.taskId, at, history: historyItem(ledger, { ...failure, summary: failure.reason, at }) };
  applyEvent(ledger, event);
  return event;
}

/** The current assignment's risk assessment and, when the Verifier ran, its findings. Returns the applied event. */
export function recordCheck(ledger: TaskLedger, check: Omit<LedgerCheck, "assignment" | "at"> & { at?: number }, findings: readonly Omit<LedgerFinding, "assignment">[] = []): CheckEvent {
  const assignment = ledger.assignments;
  const at = check.at ?? Date.now();
  const event: CheckEvent = {
    v: 1, event: "check", taskId: ledger.taskId, at, assignment,
    check: { assignment, at, score: check.score, threshold: check.threshold, decision: check.decision, reason: oneLine(check.reason, 120), ...(check.verdict ? { verdict: check.verdict } : {}) },
    findings: findings.map(item => ({ assignment, id: item.id, severity: item.severity, ...(item.requirement ? { requirement: item.requirement } : {}), claim: oneLine(item.claim), status: item.status, ...(item.probe ? { probe: oneLine(item.probe, 200) } : {}), ...(item.detail ? { detail: oneLine(item.detail, 200) } : {}) })),
  };
  applyEvent(ledger, event);
  return event;
}

/** orche re-ran the blocking findings' probes after the fix round. Returns the applied event. */
export function recordRecheck(ledger: TaskLedger, statuses: readonly { id: string; status: FindingState; detail?: string }[], at: number = Date.now()): RecheckEvent {
  const event: RecheckEvent = { v: 1, event: "recheck", taskId: ledger.taskId, at, assignment: ledger.assignments, statuses: statuses.map(item => ({ id: item.id, status: item.status, ...(item.detail ? { detail: oneLine(item.detail, 200) } : {}) })) };
  applyEvent(ledger, event);
  return event;
}

/** Limits of the persisted Task DAG copy: it is written at every accepted task_plan, so it stays small. */
export const PLAN_LIMITS = { nodes: 60, titleChars: 160, resultChars: 300, evidenceItems: 4, evidenceChars: 160, openChars: 200, eventBytes: 24 * 1024, renderChars: 3_000 } as const;

const copyPlanNode = (node: LedgerPlanNode): LedgerPlanNode => ({
  id: node.id, title: node.title, status: node.status, covers: [...node.covers], ...(node.phase === "integrate" ? { phase: "integrate" as const } : {}),
  ...(node.checkpoint ? { checkpoint: { result: node.checkpoint.result, verification: node.checkpoint.verification, ...(node.checkpoint.evidence ? { evidence: [...node.checkpoint.evidence] } : {}), ...(node.checkpoint.open ? { open: node.checkpoint.open } : {}) } } : {}),
});

/** The shape task_plan accepts (src/tools/task-plan.ts TaskPlan), structurally: only what the ledger keeps is read. */
export interface PlanInput {
  nodes: readonly { id: string; title: string; status: string; covers: readonly string[]; phase?: string; checkpoint?: { result: string; verification: string; evidence?: readonly string[]; open?: string } }[];
}

/**
 * A worker's task_plan was accepted: persist the compact Task DAG of the current assignment as the task's resume checkpoint (node
 * statuses, coverage and checkpoints; notes and dependencies are left out, and evidence when the copy would be too large).
 */
export function recordPlan(ledger: TaskLedger, input: { worker: string; plan: PlanInput; at?: number }): PlanEvent {
  const compact = (evidence: boolean): LedgerPlanNode[] => input.plan.nodes.slice(0, PLAN_LIMITS.nodes).map(node => ({
    id: node.id, title: oneLine(node.title, PLAN_LIMITS.titleChars), status: node.status, covers: [...node.covers], ...(node.phase === "integrate" ? { phase: "integrate" as const } : {}),
    ...(node.checkpoint ? { checkpoint: {
      result: oneLine(node.checkpoint.result, PLAN_LIMITS.resultChars), verification: node.checkpoint.verification,
      ...(evidence && node.checkpoint.evidence?.length ? { evidence: node.checkpoint.evidence.slice(0, PLAN_LIMITS.evidenceItems).map(item => oneLine(item, PLAN_LIMITS.evidenceChars)) } : {}),
      ...(node.checkpoint.open ? { open: oneLine(node.checkpoint.open, PLAN_LIMITS.openChars) } : {}),
    } } : {}),
  }));
  let nodes = compact(true);
  if (Buffer.byteLength(JSON.stringify(nodes), "utf8") > PLAN_LIMITS.eventBytes) nodes = compact(false);
  const event: PlanEvent = { v: 1, event: "plan", taskId: ledger.taskId, at: input.at ?? Date.now(), assignment: ledger.assignments, worker: input.worker, nodes };
  applyEvent(ledger, event);
  return event;
}

/** `3/7 done` of a recorded plan (skipped nodes count as finished). */
export function planProgress(plan: LedgerPlan): { done: number; total: number; remaining: LedgerPlanNode[] } {
  const finished = plan.nodes.filter(node => node.status === "done" || node.status === "skipped");
  return { done: finished.length, total: plan.nodes.length, remaining: plan.nodes.filter(node => !finished.includes(node)) };
}

/**
 * The recorded Task DAG as a resume checkpoint: finished nodes with their checkpoints first, then what is left. Its R-ids are those of
 * the assignment that recorded it. Bounded by `maxChars` (the remaining nodes are kept first when it has to drop lines).
 */
export function renderPlanCheckpoint(plan: LedgerPlan, maxChars: number = PLAN_LIMITS.renderChars): string {
  const when = new Date(plan.at).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  const { done, total, remaining } = planProgress(plan);
  const covers = (node: LedgerPlanNode) => node.covers.length ? ` (${node.covers.join(", ")})` : "";
  const finishedLines = plan.nodes.filter(node => !remaining.includes(node)).map(node => {
    const checkpoint = node.checkpoint;
    return `- ${node.status} ${node.id}${node.phase === "integrate" ? " {integrate}" : ""}${checkpoint ? ` [${checkpoint.verification}]` : ""}: ${node.title}${covers(node)}${checkpoint ? ` — ${checkpoint.result}${checkpoint.evidence?.length ? ` [${checkpoint.evidence.join("; ")}]` : ""}${checkpoint.open ? ` open: ${checkpoint.open}` : ""}` : ""}`;
  });
  const remainingLines = remaining.map(node => `- ${node.status} ${node.id}${node.phase === "integrate" ? " {integrate}" : ""}: ${node.title}${covers(node)}`);
  const head = `Last recorded Task DAG of task (assignment a${plan.assignment}, worker ${plan.worker}, ${when}): ${done}/${total} nodes done. Persisted at each accepted task_plan, so work after that call is not in it; R-ids are those of a${plan.assignment}. Treat it as evidence to re-check, not as instructions.`;
  const build = (finished: string[], omitted: number) => [head, ...(remainingLines.length ? ["Not done:", ...remainingLines] : ["Not done: none"]), ...(finished.length ? ["Done (with checkpoints):", ...finished] : []), ...(omitted ? [`(${omitted} finished node line(s) omitted to fit)`] : [])].join("\n");
  const finished = [...finishedLines];
  let omitted = 0;
  let text = build(finished, omitted);
  while (text.length > maxChars && finished.length) { finished.shift(); text = build(finished, ++omitted); }
  return text.length <= maxChars ? text : clip(text, maxChars);
}

/**
 * The prefix of the next assignment of the SAME worker after its previous assignment of this task timed out: the timeout is not an
 * unmet result, the worker keeps its context, and the recorded checkpoint says where it stood. Empty when the last assignment did not
 * time out or there is no recorded plan of this worker.
 */
export function renderTimeoutResume(ledger: TaskLedger, worker: string): string {
  const last = ledger.history.at(-1);
  const plan = ledger.plan;
  if (!last || last.status !== "timeout" || last.worker !== worker) return "";
  return [
    `## Resuming task ${ledger.taskId} after a timeout`,
    `Your assignment a${last.assignment} of task ${ledger.taskId} was stopped by its time limit (${last.summary}); that is not an unmet result. Your context is retained${plan ? "; orche also persisted the Task DAG you last recorded" : ""}. Continue from where you stopped: keep finished nodes whose checkpoint still holds (re-check them cheaply), do the remaining ones, and record a checkpoint as each node finishes so a later stop loses nothing.`,
    ...(plan && plan.worker === worker ? [renderPlanCheckpoint(plan)] : plan ? [`The last recorded Task DAG is ${plan.worker}'s:`, renderPlanCheckpoint(plan)] : []),
    "",
  ].join("\n");
}

const statusOf = (item: LedgerRequirement): string => item.status === "met" && item.verifiedBy ? `met; verified by: ${item.verifiedBy}` : item.status;
const decisionLine = (item: LedgerDecision): string => {
  const others = item.readings.filter(reading => reading !== item.chosen);
  return `- a${item.assignment} ${item.id ?? "?"}${item.quote ? ` "${item.quote}"` : ""}: ${item.by === "framer" ? "Framer recommended" : "chose"} "${item.chosen}"${others.length ? ` over ${others.map(reading => `"${reading}"`).join(", ")}` : ""}${item.askUser ? " (needs the user's decision)" : ""}`;
};

/** Characters of one original request in the worker projection; the full text stays in the ledger entry. */
export const WORKER_ORIGINAL_CHARS = 1_000;

/**
 * What a worker gets back at compaction time, next to the verbatim current assignment (which already holds the current
 * original request): the cumulative task state. The latest assignment's requirement statuses and the chosen readings come
 * first; then the last recorded Task DAG (unless `skipPlanOf` names its assignment: the caller shows the live plan itself), earlier
 * requirements, the first and the newest earlier original request (a worker may have been reused across several user requests),
 * and the history. To fit `maxChars` it drops the oldest history, then the oldest earlier requirements, then the original
 * requests, then the oldest readings; a hard clip is the last resort.
 */
export function renderLedgerForWorker(ledger: TaskLedger, maxChars: number = LEDGER_LIMITS.workerChars, options: { skipPlanOf?: number } = {}): string {
  const current = ledger.requirements.filter(item => item.assignment === ledger.assignments);
  const earlier = ledger.requirements.filter(item => item.assignment !== ledger.assignments);
  const decisions = [...ledger.decisions];
  const history = [...ledger.history];
  const findings = (ledger.findings ?? []).filter(item => item.assignment === ledger.assignments && item.status !== "fixed");
  const priorOriginals = ledger.originalRequests.filter(item => item.assignment !== ledger.assignments);
  let originals = priorOriginals.length > 2 ? [priorOriginals[0]!, priorOriginals.at(-1)!] : priorOriginals;
  const plan = ledger.plan && ledger.plan.assignment !== options.skipPlanOf ? renderPlanCheckpoint(ledger.plan, Math.min(PLAN_LIMITS.renderChars, Math.floor(maxChars / 2))) : undefined;
  const build = (omitted: number): string => [
    `Task ledger ${ledger.taskId}: state across ${ledger.assignments} assignment(s), kept by orche outside your context and rendered when this message was written. The latest Assignment message wins where they differ; re-read files before relying on reported results.`,
    ...(current.length ? [`Requirements of assignment a${ledger.assignments} (the latest when rendered), last reported status:`, ...current.map(item => `- ${item.id} [${statusOf(item)}] ${oneLine(item.text)}`)] : []),
    ...(decisions.length ? ["Readings chosen for ambiguous requirements (keep them unless the user changes them):", ...decisions.map(decisionLine)] : []),
    ...(findings.length ? [`Verifier findings of assignment a${ledger.assignments} not fixed when rendered:`, ...findings.map(item => `- ${item.id} ${item.severity}${item.requirement ? ` ${item.requirement}` : ""} [${item.status}] ${item.claim}${item.probe ? ` (re-run: ${item.probe})` : ""}`)] : []),
    ...(plan ? [plan] : []),
    ...(earlier.length ? ["Requirements of earlier assignments (historical):", ...earlier.map(item => `- a${item.assignment} ${item.id} [${item.status}] ${oneLine(item.text, 160)}`)] : []),
    ...(originals.length ? [`Earlier original request(s) from the user${priorOriginals.length > originals.length ? ` (${priorOriginals.length - originals.length} more not shown)` : ""}:`, ...originals.map(item => `[a${item.assignment}] ${clip(item.text, WORKER_ORIGINAL_CHARS)}`)] : []),
    ...(history.length ? ["Assignment history:", ...history.map(item => `- a${item.assignment} ${item.role} ${item.status} (${item.worker}): ${item.summary}`)] : []),
    ...(omitted ? [`(${omitted} older ledger lines omitted to fit; the full ledger is in the session's orche-ledger entries.)`] : []),
  ].join("\n");
  let omitted = 0;
  let text = build(omitted);
  while (text.length > maxChars && (history.length || earlier.length || originals.length || decisions.length)) {
    if (history.length) history.shift();
    else if (earlier.length) earlier.shift();
    else if (originals.length) originals = originals.slice(1);
    else decisions.shift();
    text = build(++omitted);
  }
  return text.length <= maxChars ? text : clip(text, maxChars);
}

/** Tasks listed in the main-session summary: the most recently updated ones. */
export const SUMMARY_TASKS = 5;
/** One line per task for the main session (after its own compaction): where each task stands. Each line is clipped to `maxChars`. */
export function renderLedgerSummary(ledgers: readonly TaskLedger[], maxChars: number = LEDGER_LIMITS.summaryChars): string | undefined {
  if (!ledgers.length) return undefined;
  const recent = [...ledgers].sort((a, b) => b.updatedAt - a.updatedAt);
  const lines = recent.slice(0, SUMMARY_TASKS).map(ledger => {
    const current = ledger.requirements.filter(item => item.assignment === ledger.assignments);
    const counts = (["met", "partial", "unmet", "open"] as const).map(status => [status, current.filter(item => item.status === status).length] as const).filter(([, count]) => count > 0);
    const open = current.filter(item => item.status !== "met").map(item => `${item.id} ${item.status}: ${oneLine(item.text, 80)}`);
    const last = ledger.history.at(-1);
    const decisions = ledger.decisions.slice(-3).map(item => `${item.id ?? "?"}="${oneLine(item.chosen, 60)}"${item.askUser ? " (ask the user)" : ""}`);
    const check = ledger.checks?.filter(item => item.assignment === ledger.assignments).at(-1);
    const openFindings = (ledger.findings ?? []).filter(item => item.assignment === ledger.assignments && item.severity === "blocking" && item.status !== "fixed");
    const worker = ledger.primary ? `${ledger.primary.worker}${ledger.primary.live ? "" : " (gone)"}` : "no worker";
    const dag = ledger.plan ? planProgress(ledger.plan) : undefined;
    return clip([
      `- ${ledger.taskId} · ${worker} · ${ledger.assignments} assignment(s)`,
      counts.length ? ` · current a${ledger.assignments}: ${counts.map(([status, count]) => `${count} ${status}`).join(", ")}` : "",
      open.length ? ` · not met: ${open.join("; ")}` : "",
      decisions.length ? ` · readings: ${decisions.join(", ")}` : "",
      check ? ` · risk ${check.score}/${check.threshold}: ${check.decision === "verify" ? `verified ${check.verdict ?? "?"}` : "not verified"}${openFindings.length ? `, open findings: ${openFindings.map(item => `${item.id} ${item.status}`).join(", ")}` : ""}` : "",
      dag && ledger.plan ? ` · Task DAG a${ledger.plan.assignment} (${ledger.plan.worker}): ${dag.done}/${dag.total} done` : "",
      last ? ` · last: ${last.role} ${last.status}: ${oneLine(last.summary, 120)}` : "",
    ].join(""), maxChars);
  });
  const more = recent.length > SUMMARY_TASKS ? [`(${recent.length - SUMMARY_TASKS} older task ledger(s) not shown)`] : [];
  return [`orche task ledgers (kept outside the context; restored after compaction). Pass task "T…" to orche_task for a follow-up of that task, also with a new worker; omit it for a different task:`, ...lines, ...more].join("\n");
}

/** The briefing a worker gets when it takes over a task from another worker (gone, or replaced by a new one). */
export function renderResumeBriefing(ledger: TaskLedger, previous: { worker: string; sessionFile?: string; live: boolean }): string {
  const why = previous.live ? `${previous.worker} handed it over to you` : `${previous.worker} is no longer live (its session ended: a reload, idle expiry or pool eviction)`;
  const last = ledger.history.at(-1);
  const stopped = last && last.status === "timeout" ? ` Its last assignment a${last.assignment} was stopped by the time limit, not by an unmet result.` : "";
  const resume = ledger.plan ? " Resume from the last recorded Task DAG in the ledger below: keep finished nodes whose checkpoint still holds (re-check them cheaply) and continue with the ones not done." : "";
  return [
    `## Continuing task ${ledger.taskId}`,
    `Task ${ledger.taskId} was worked on by ${previous.worker}; ${why}.${stopped} You take it over without its context: rely on this ledger and re-read the workspace.${previous.sessionFile ? ` Its transcript is ${previous.sessionFile} (read it only for a specific detail).` : ""}${resume}`,
    renderLedgerForWorker(ledger),
    "",
  ].join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const isRequirement = (value: unknown): boolean => isRecord(value) && typeof value.assignment === "number" && isString(value.id) && isString(value.text)
  && STATUSES.includes(value.status as string) && optionalString(value.evidence) && optionalString(value.verifiedBy);
const isUpdate = (value: unknown): boolean => isRecord(value) && isString(value.id) && STATUSES.includes(value.status as string) && value.status !== "open" && isString(value.evidence) && optionalString(value.verifiedBy);
const isDecision = (value: unknown): boolean => isRecord(value) && typeof value.assignment === "number" && optionalString(value.id) && Array.isArray(value.readings) && value.readings.every(isString) && isString(value.chosen)
  && (value.by === undefined || value.by === "worker" || value.by === "framer") && optionalString(value.quote) && (value.askUser === undefined || typeof value.askUser === "boolean");
const FINDING_STATES: readonly string[] = ["open", "fixed", "disputed", "unchecked", "minor"];
const isCheck = (value: unknown): boolean => isRecord(value) && typeof value.assignment === "number" && typeof value.at === "number" && typeof value.score === "number" && typeof value.threshold === "number"
  && (value.decision === "verify" || value.decision === "skip") && isString(value.reason) && (value.verdict === undefined || ["pass", "fail", "error"].includes(value.verdict as string));
const isFinding = (value: unknown): boolean => isRecord(value) && typeof value.assignment === "number" && isString(value.id) && (value.severity === "blocking" || value.severity === "minor")
  && optionalString(value.requirement) && isString(value.claim) && FINDING_STATES.includes(value.status as string) && optionalString(value.probe) && optionalString(value.detail);
const isFindingStatus = (value: unknown): boolean => isRecord(value) && isString(value.id) && FINDING_STATES.includes(value.status as string) && optionalString(value.detail);
const isHistory = (value: unknown): boolean => isRecord(value) && typeof value.assignment === "number" && typeof value.at === "number"
  && isString(value.role) && isString(value.worker) && isString(value.status) && isString(value.summary) && optionalString(value.record);
const isWorker = (value: unknown): boolean => isRecord(value) && isString(value.worker) && optionalString(value.model) && optionalString(value.thinking) && optionalString(value.sessionFile);
const isPlanCheckpoint = (value: unknown): boolean => isRecord(value) && isString(value.result) && isString(value.verification) && optionalString(value.open)
  && (value.evidence === undefined || Array.isArray(value.evidence) && value.evidence.every(isString));
const isPlanNode = (value: unknown): boolean => isRecord(value) && isString(value.id) && isString(value.title) && isString(value.status) && Array.isArray(value.covers) && value.covers.every(isString)
  && (value.phase === undefined || value.phase === "integrate") && (value.checkpoint === undefined || isPlanCheckpoint(value.checkpoint));

/** A well-formed ledger event (session data is untrusted: anything else is skipped). */
export function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (!isRecord(value) || value.v !== 1 || !isString(value.taskId) || typeof value.at !== "number") return false;
  switch (value.event) {
    case "create": return isString(value.cwd);
    case "handoff": return typeof value.assignment === "number" && optionalString(value.original) && Array.isArray(value.requirements) && value.requirements.every(isRequirement) && isWorker(value.primary)
      && (value.decisions === undefined || Array.isArray(value.decisions) && value.decisions.every(isDecision));
    case "result": return typeof value.assignment === "number" && Array.isArray(value.statuses) && value.statuses.every(isUpdate) && Array.isArray(value.decisions) && value.decisions.every(isDecision) && isHistory(value.history);
    case "failure": return isHistory(value.history);
    case "check": return typeof value.assignment === "number" && isCheck(value.check) && Array.isArray(value.findings) && value.findings.every(isFinding);
    case "recheck": return typeof value.assignment === "number" && Array.isArray(value.statuses) && value.statuses.every(isFindingStatus);
    case "plan": return typeof value.assignment === "number" && isString(value.worker) && Array.isArray(value.nodes) && value.nodes.length <= PLAN_LIMITS.nodes && value.nodes.every(isPlanNode);
    default: return false;
  }
}
/** A whole-ledger snapshot, the entry format before events (still read so such sessions restore). */
function isSnapshot(value: unknown): value is TaskLedger {
  if (!isRecord(value)) return false;
  return value.v === 2 && isString(value.taskId) && isString(value.cwd) && typeof value.assignments === "number"
    && Array.isArray(value.originalRequests) && Array.isArray(value.requirements) && Array.isArray(value.decisions) && Array.isArray(value.history);
}

/** Replay events into ledgers (`ledgers` is updated in place; a `create` starts a task afresh; events of unknown tasks are skipped). */
export function replayLedgerEvents(events: readonly LedgerEvent[], ledgers: Map<string, TaskLedger> = new Map()): Map<string, TaskLedger> {
  for (const event of events) {
    if (event.event === "create") { ledgers.set(event.taskId, createLedger(event.taskId, event.cwd, event.at)); continue; }
    const ledger = ledgers.get(event.taskId);
    if (ledger) applyEvent(ledger, event);
  }
  return ledgers;
}

/** The ledgers rebuilt from session entries (oldest first, as `getBranch()` returns them); malformed entries are skipped. */
export function latestLedgers(entries: readonly { type: string; customType?: string; data?: unknown }[]): TaskLedger[] {
  const ledgers = new Map<string, TaskLedger>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== LEDGER_ENTRY_TYPE) continue;
    if (isLedgerEvent(entry.data)) replayLedgerEvents([entry.data], ledgers);
    else if (isSnapshot(entry.data)) ledgers.set(entry.data.taskId, structuredClone(entry.data));
  }
  return [...ledgers.values()];
}
