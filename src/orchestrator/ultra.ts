/**
 * Ultra mode (docs/orchestrator.md 14): the quality-first orchestration of an implement/answer assignment, on the strong model tiers.
 *
 * The flow: requirements and acceptance criteria → (independent verification basis ∥ cause/approach hypotheses) → diverse independent
 * candidates → execution-based evaluation of every candidate (bounded fix round, incumbent kept) → evidence-based selection and
 * adoption → independent counterexample review → integration and full re-verification.
 *
 * What the runtime enforces (this module, spawn.ts, sub-worker.ts, candidate-workspace.ts) and what stays prompt-based:
 *  - enforced: stage order (no candidate before an exploration round with a finished verification-basis builder and a finished
 *    analyst; for a read-only task a finished analyst), caps (exploration and candidate rounds ≤ 2 each, ≤ 4 workers per call,
 *    verification rounds keep their cap, depth 1), ≥ 2 distinct candidate requests per round, isolation of implementation
 *    candidates in their own workspace copies made before any candidate runs (private dependency copies, every link verified,
 *    fail-closed), the protected verification basis (refused to candidates and to the orchestrator; a candidate that changes it by
 *    shell is not adoptable; a basis changed in the workspace fails the report), no orchestrator edits in the workspace before an
 *    adoption, an escape check around each candidates round (the workspace's content and its own dependency directories unchanged,
 *    else none of the round's candidates is adoptable), adoption only of a finished candidate whose copy is byte for byte what a
 *    successful check of the orchestrator saw before and after it ran (refused when the workspace moved underneath, rolled back on a
 *    failed write or when the copy changed meanwhile), and the report gate (`gateError`): ≥ 2 candidates with a report, every
 *    candidate accounted for, the chosen one adopted, selection evidence = successful shell checks in the chosen copy that saw the
 *    adopted content, integration evidence = successful shell checks in the workspace whose content fingerprints before and after
 *    the check equal the workspace's at the report (so any later change, by a tool, a shell command or another process, requires
 *    new checks), the report alone (no call that can change files in flight), a verification round after the last adoption, every
 *    reproduced counterexample fixed or the task blocked, and a non-empty review when a verifier did not pass;
 *  - prompt-based (the model's judgment, not checkable): that basis checks really encode the acceptance criteria, that hypotheses
 *    and candidates are semantically diverse, that a cited check run actually supports the claim (a passing command proves only
 *    that it ran and exited 0, and that it targets the copy is read from its command text), the tie-break between equally passing
 *    candidates, and the classification of review findings beyond the cited refs.
 * Fingerprints are content-based (candidate-workspace.ts manifests: raw bytes and modes of every in-scope file); a probe that is
 * missing, failed or overlapped another call that can change files never counts as evidence.
 * Failure path: any stage may end the assignment with status "blocked" and `data.ultra.stage` naming where it stopped (a read-only
 * answer: `data.unresolved`); the gate checks only that shape then.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatSchemaErrors } from "../orchestration/schema-errors.js";
import { WRITE_TOOLS } from "../orchestration/ownership.js";
import { READ_ONLY_TOOL_NAMES } from "../tools/index.js";
import { BOOKKEEPING_TOOLS, type EvidenceLedger, type ToolRecord } from "../pi/tool-evidence.js";
import { MAX_SUB_WORKERS, MAX_VERIFICATION_ROUNDS } from "./instructions.js";
import { CandidateWorkspaces, DEPENDENCY_DIRS, manifestDiff, manifestDigest, UnsafeLinksError, type Manifest, type MaterializeReport } from "./candidate-workspace.js";
import type { PlannedWorker, SpawnReason, SubWorkerOutcome, UltraSpawnHooks } from "./spawn.js";

export const ADOPT_TOOL = "orche_adopt";
export const MAX_EXPLORATION_ROUNDS = 2;
export const MAX_CANDIDATE_ROUNDS = 2;
export const ULTRA_STAGES = ["criteria", "exploration", "candidates", "evaluation", "selection", "review", "integration", "complete"] as const;
export type UltraStage = (typeof ULTRA_STAGES)[number];
export const ADOPT_UNAVAILABLE = "orche_adopt is available only to the orchestrator of an ultra implement assignment; do the work yourself.";

const text = (max: number) => Type.String({ minLength: 1, maxLength: max });
const refs = Type.Array(text(600), { maxItems: 20 });
const lit = <T extends string>(values: readonly T[]) => Type.Union(values.map(value => Type.Literal(value)));
/** `data.ultra` of an ultra orchestrator's report. */
export const ultraReportSchema = Type.Object({
  stage: lit(ULTRA_STAGES),
  criteria: Type.Optional(Type.Array(text(600), { minItems: 1, maxItems: 30 })),
  hypotheses: Type.Optional(Type.Array(Type.Object({ claim: text(600), verdict: lit(["supported", "refuted", "open"] as const), evidence: Type.Optional(refs) }), { maxItems: 20 })),
  candidates: Type.Optional(Type.Array(Type.Object({ id: text(40), verdict: lit(["chosen", "rejected", "failed"] as const), reason: text(1000), evidence: Type.Optional(refs) }), { maxItems: MAX_SUB_WORKERS * MAX_CANDIDATE_ROUNDS })),
  selection: Type.Optional(Type.Object({ chosen: text(40), reason: text(1000), evidence: refs })),
  review: Type.Optional(Type.Array(Type.Object({ finding: text(1000), source: Type.Optional(text(40)), status: lit(["reproduced-fixed", "reproduced-open", "unverified", "refuted"] as const), evidence: Type.Optional(refs) }), { maxItems: 30 })),
  integration: Type.Optional(Type.Object({ evidence: refs })),
  claims: Type.Optional(Type.Array(Type.Object({ claim: text(1000), sources: refs, status: lit(["supported", "contested", "unsupported"] as const) }), { maxItems: 40 })),
});
type UltraReport = {
  stage: UltraStage; criteria?: string[]; hypotheses?: { claim: string; verdict: string; evidence?: string[] }[];
  candidates?: { id: string; verdict: "chosen" | "rejected" | "failed"; reason: string; evidence?: string[] }[];
  selection?: { chosen: string; reason: string; evidence: string[] };
  review?: { finding: string; source?: string; status: "reproduced-fixed" | "reproduced-open" | "unverified" | "refuted"; evidence?: string[] }[];
  integration?: { evidence: string[] }; claims?: { claim: string; sources: string[]; status: string }[];
};
const FORMAT = 'ultra:{stage:"complete" (or the stage where it stopped),criteria:[acceptance criteria],hypotheses:[{claim,verdict:"supported"|"refuted"|"open",evidence:[refs]}],candidates:[{id,verdict:"chosen"|"rejected"|"failed",reason,evidence:[refs]}],selection:{chosen:candidate id,reason,evidence:[refs]},review:[{finding,source,status:"reproduced-fixed"|"reproduced-open"|"unverified"|"refuted",evidence:[refs]}],integration:{evidence:[refs]} (implement) | claims:[{claim,sources:[refs, paths or URLs],status:"supported"|"contested"|"unsupported"}] (answer)}';

export interface UltraCandidate {
  id: string; name: string; role: string; round: number; status: string;
  /** Ultra spawn call (ledger ref number) that ran it. */ spawnRef: number;
  workspace?: string; base?: string; from?: string; changes: string[]; tampered: string[];
  /** The workspace's manifest when its copy was made (a JSON file in the copies directory): the adoption's conflict check. */
  workspaceBase?: string;
  /** Why it cannot be adopted although it finished: its round changed the workspace or the workspace's dependency directories. */
  escaped?: string[];
}
/** What an ultra run keeps; carried over when the same worker continues the same task after a timeout or a blocked report. */
export interface UltraState {
  explorationRounds: number; basisDone: number; analystsDone: number;
  protectedPaths: string[];
  /** The protected basis as exploration left it: manifest entries under the protected paths. */
  basis?: Record<string, string>;
  candidateRounds: number; candidates: UltraCandidate[];
  /** `ref`: ledger ref number of the orche_adopt call (0: adopted in an earlier assignment); `fingerprint`: the candidate's content state adopted. */
  adoptions: { candidate: string; files: string[]; ref: number; fingerprint?: string }[];
  /** Verification rounds of this assignment: the orche_spawn ref and how its verifiers ended. */
  verifications: { ref: number; finished: number; notPassed: number }[];
}
export const newUltraState = (): UltraState => ({ explorationRounds: 0, basisDone: 0, analystsDone: 0, protectedPaths: [], candidateRounds: 0, candidates: [], adoptions: [], verifications: [] });

export interface UltraSummary {
  stage: string; explorationRounds: number; candidateRounds: number; protectedBasis: string[];
  candidates: { id: string; name: string; round: number; status: string; changes: number; tampered?: true; adopted?: true; escaped?: true }[];
  adoptions: string[]; verificationRounds: number; gate?: string; carried?: true;
}

/** Content fingerprints at one moment: the workspace (its git-visible files) and every finished candidate copy. */
interface Fingerprints { workspace?: string; candidates: Record<string, string> }
/**
 * One tool call of the orchestrator, from its guard to its end. Bash calls carry fingerprints taken before and after they ran, so a
 * cited check is tied to the content it evaluated; `overlapped`: another call that is not read-only ran at the same time (the
 * fingerprints then do not prove what the check saw).
 */
interface Probe { name: string; before?: Fingerprints; after?: Fingerprints; overlapped: boolean; ended: boolean }
const QUIET_TOOLS: ReadonlySet<string> = new Set([...READ_ONLY_TOOL_NAMES, "task_plan", "send_message"]);

const refNumber = (ref: string) => Number(ref.slice(1));
const REF = /\bT(\d{1,5})\b/g;
const citedRefs = (items: readonly string[] | undefined) => [...new Set((items ?? []).flatMap(item => [...item.matchAll(REF)].map(match => `T${Number(match[1])}`)))];
const under = (path: string, owned: string) => path === owned || path.startsWith(`${owned.replace(/\/$/, "")}/`);
const dataOf = (data: unknown): Record<string, unknown> => data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};

export interface UltraRunOptions {
  orchestrator: string;
  cwd: string;
  /** The assignment is read-only (answer): answer candidates, no workspaces, no adoption. */
  readOnly: boolean;
  /** The orchestrator's private scratch directory; candidate copies live under `<scratch>/ultra`. */
  scratch?: string;
  /** The orchestrator session's tool-call ledger (refs T1, T2, …; tagging on for ultra). */
  ledger(): EvidenceLedger;
  /** Shell checks the project runs (orche.config.json `verifyCommands`), suggested for candidate evaluation. */
  verifyCommands?: readonly string[];
  /** Carried state of the same worker and task (after a timeout or a blocked report). */
  carried?: UltraState;
  onEvent?(event: Record<string, unknown>): void;
}

/** One ultra orchestrator assignment: the orche_spawn hooks, orche_adopt, the write guard and the report gate. */
export class UltraRun implements UltraSpawnHooks {
  readonly state: UltraState;
  private workspaces?: CandidateWorkspaces | null;
  /** Protected basis paths that differ in the workspace now from the basis snapshot (refreshed before each report). */
  private basisChanged: string[] = [];
  /** The workspace's fingerprint taken for the report call `call` (when its guard opened it); `error` when it could not be taken. */
  private current: { call?: string; workspace?: string; error?: string } = {};
  private gateResult?: string;
  /** The stage the last accepted report named (blocked reports name where they stopped). */
  private reported?: UltraStage;
  readonly carried: boolean;
  /** Probes by tool call id (this assignment only: refs and fingerprints never carry over). */
  private readonly probes = new Map<string, Probe>();
  private readonly inFlight = new Set<string>();
  private reportCall?: string;
  /** git work on the copies and the workspace index runs one at a time (probes of parallel calls, adoption, stage hooks). */
  private queue: Promise<unknown> = Promise.resolve();
  /** The open candidates round: the workspace (manifest) and its dependency directories before it ran (escape check), notes for its result. */
  private round?: { manifest?: Manifest; dependencies?: string; notes: string[] };

  constructor(private readonly options: UltraRunOptions) {
    this.carried = !!options.carried;
    this.state = options.carried ? { ...structuredClone(options.carried), adoptions: options.carried.adoptions.map(item => ({ ...item, files: [...item.files], ref: 0 })), verifications: [] } : newUltraState();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get root(): string | undefined { return this.options.scratch ? join(this.options.scratch, "ultra") : undefined; }
  private nextRef(): number { return this.options.ledger().checks + 1; }
  private event(event: Record<string, unknown>): void { try { this.options.onEvent?.({ type: "ultra", timestamp: Date.now(), worker: this.options.orchestrator, ...event }); } catch { /* records are best effort */ } }

  /** The candidate workspaces, opened on first use; undefined outside a git work tree or without a scratch directory. */
  private async spaces(signal?: AbortSignal): Promise<CandidateWorkspaces | undefined> {
    if (this.workspaces !== undefined) return this.workspaces ?? undefined;
    const root = this.root;
    this.workspaces = root ? await CandidateWorkspaces.open(this.options.cwd, root, signal).catch(() => undefined) ?? null : null;
    if (this.workspaces && !this.carried) await this.workspaces.clear();
    return this.workspaces ?? undefined;
  }

  // ---- integrity probes: every allowed call of the orchestrator, with content fingerprints around each bash call ----
  /** The workspace's and every finished candidate copy's content now; undefined before there is anything to protect. Inside `serial`. */
  private async fingerprintsNow(): Promise<Fingerprints | undefined> {
    const state = this.state;
    if (this.options.readOnly || !state.candidates.length && !state.adoptions.length && !state.protectedPaths.length) return undefined;
    const spaces = await this.spaces();
    if (!spaces) return undefined;
    const prints: Fingerprints = { candidates: {} };
    try { prints.workspace = manifestDigest(await spaces.workspaceManifest()); } catch { /* the probe then proves nothing about the workspace */ }
    for (const candidate of state.candidates) {
      if (!candidate.workspace || candidate.status === "running") continue;
      try { prints.candidates[candidate.id] = await spaces.fingerprint(candidate.id); } catch { /* nor about this copy */ }
    }
    return prints;
  }

  /**
   * The worker's guard allowed a call: open its probe. A call that can change files and runs while another is in flight marks both
   * overlapped (Pi runs the calls of one response in parallel); a bash call gets the fingerprints before it runs.
   */
  async beginCall(toolCallId: string | undefined, name: string): Promise<void> {
    if (!toolCallId || this.probes.has(toolCallId)) return;
    const probe: Probe = { name, overlapped: false, ended: false };
    for (const id of this.inFlight) {
      const other = this.probes.get(id);
      if (!other) continue;
      if (!QUIET_TOOLS.has(name)) other.overlapped = true;
      if (!QUIET_TOOLS.has(other.name)) probe.overlapped = true;
    }
    this.probes.set(toolCallId, probe);
    this.inFlight.add(toolCallId);
    if (name === "report_result") { this.reportCall = toolCallId; await this.refresh(toolCallId); }
    if (name === "bash") probe.before = await this.serial(() => this.fingerprintsNow());
  }

  /** The call ended (`tool_execution_end`, awaited before the worker goes on): a bash call gets the fingerprints after it ran. */
  async endCall(toolCallId: string): Promise<void> {
    const probe = this.probes.get(toolCallId);
    if (!probe || probe.ended) return;
    if (probe.name === "bash" && probe.before) probe.after = await this.serial(() => this.fingerprintsNow());
    probe.ended = true;
    this.inFlight.delete(toolCallId);
  }

  /** The probe of a bash call that proves what it ran on: nothing else ran at the same time, and it had fingerprints on both sides. */
  private stable(call: ToolRecord): Probe | undefined {
    const probe = this.probes.get(call.toolCallId);
    return probe?.before && probe.after && !probe.overlapped ? probe : undefined;
  }

  /** A stable check that saw `print` in the candidate copy `id` before and after it ran. */
  private sawCandidate(call: ToolRecord, id: string, print: string | undefined): boolean {
    const probe = this.stable(call);
    return !!print && !!probe && probe.before!.candidates[id] === print && probe.after!.candidates[id] === print;
  }

  // ---- orche_spawn hooks ----
  /** The stage order, caps and roles of one call, before any id is given out (a refused call uses none). */
  validate(reason: SpawnReason, workers: readonly { role: string; name: string; from?: string }[]): void {
    const state = this.state;
    if (reason === "exploration") {
      if (state.explorationRounds >= MAX_EXPLORATION_ROUNDS) throw new Error(`Refused: ${state.explorationRounds} exploration rounds ran (cap ${MAX_EXPLORATION_ROUNDS}). Continue with candidates, or report status "blocked" with data.ultra.stage "exploration".`);
      if (!this.options.readOnly && !workers.some(worker => worker.role === "answer") && !state.analystsDone) throw new Error("Refused: the first exploration needs at least one hypothesis/approach analyst (role answer) next to the verification-basis builders.");
      if (!this.options.readOnly && !workers.some(worker => worker.role === "implement") && !state.basisDone) throw new Error("Refused: the first exploration needs at least one verification-basis builder (role implement, owning the test or check files it writes) next to the analysts.");
      return;
    }
    if (reason !== "candidates") return;
    if (this.options.readOnly ? !state.analystsDone : !state.basisDone || !state.analystsDone) throw new Error(`Refused: candidates come after an exploration round with ${this.options.readOnly ? "a finished analyst (sources and evaluation criteria, hypotheses)" : "a finished verification-basis builder and a finished analyst"}; so far: ${state.explorationRounds} exploration round(s), ${state.basisDone} basis builder(s) and ${state.analystsDone} analyst(s) done.`);
    if (state.candidateRounds >= MAX_CANDIDATE_ROUNDS) throw new Error(`Refused: ${state.candidateRounds} candidate rounds ran (cap ${MAX_CANDIDATE_ROUNDS}). Select among the candidates you have, or report status "blocked" with data.ultra.stage "candidates".`);
    if (workers.length && this.options.readOnly !== (workers[0]!.role === "answer")) throw new Error(this.options.readOnly ? "Refused: candidates of a read-only task are answers (role answer)." : "Refused: candidates of an implement task are implementations (role implement), each in its own workspace copy.");
    for (const worker of workers) {
      if (!worker.from) continue;
      const earlier = state.candidates.find(item => item.id === worker.from);
      if (!earlier?.workspace || !earlier.base) throw new Error(`Refused: ${worker.name}: from ${worker.from} is not an earlier implementation candidate with a workspace.`);
      if (earlier.tampered.length) throw new Error(`Refused: ${worker.name}: ${worker.from} changed the protected basis (${earlier.tampered.join(", ")}); start from the workspace instead.`);
    }
  }

  async prepare(reason: SpawnReason, workers: PlannedWorker[], signal: AbortSignal): Promise<PlannedWorker[]> {
    const state = this.state;
    this.validate(reason, workers);
    if (reason === "exploration") {
      state.explorationRounds++;
      this.event({ stage: "exploration", round: state.explorationRounds, workers: workers.map(worker => worker.id) });
      return workers;
    }
    if (reason === "candidates") {
      const round = state.candidateRounds + 1;
      const spawnRef = this.nextRef();
      if (this.options.readOnly) {
        state.candidateRounds = round;
        for (const worker of workers) state.candidates.push({ id: worker.id, name: worker.name, role: worker.role, round, status: "running", spawnRef, changes: [], tampered: [] });
        this.event({ stage: "candidates", round, workers: workers.map(worker => worker.id) });
        return workers;
      }
      return this.serial(async () => {
        const spaces = await this.spaces(signal);
        if (!spaces) throw new Error(`Refused: implementation candidates need a git work tree (and the worker's scratch directory) to get isolated workspace copies; ${this.options.cwd} has none. Report status "blocked" with data.ultra.stage "candidates", or ask main for strong mode.`);
        const base = await spaces.snapshot(signal);
        // The adoption's conflict check and this round's escape check: the workspace's content and its own dependency directories now.
        const manifest = await spaces.workspaceManifest(signal);
        const workspaceBase = join(spaces.root, `round-${round}.workspace.json`);
        await writeFile(workspaceBase, JSON.stringify(manifest));
        const dependencies = await spaces.dependencyFingerprint().catch(() => undefined);
        const added: UltraCandidate[] = [];
        const prepared: PlannedWorker[] = [];
        const reports: MaterializeReport[] = [];
        try {
          for (const worker of workers) {
            const earlier = worker.from ? state.candidates.find(item => item.id === worker.from) : undefined;
            reports.push(await spaces.materialize(worker.id, earlier?.base ?? base, earlier?.id, signal));
            const workspace = spaces.path(worker.id);
            const submodules = reports.at(-1)!.submodules;
            added.push({ id: worker.id, name: worker.name, role: worker.role, round, status: "running", spawnRef, workspace, base: earlier?.base ?? base, workspaceBase: earlier?.workspaceBase ?? workspaceBase, ...(earlier ? { from: earlier.id } : {}), changes: [], tampered: [] });
            prepared.push({ ...worker, workspace, protectedPaths: [...state.protectedPaths], ...(submodules.length ? { outsidePaths: submodules } : {}) });
          }
        } catch (error) {
          for (const item of added) await spaces.remove(item.id);
          throw new Error(`Refused: the candidate copies could not be made (${error instanceof Error ? error.message : String(error)}); no candidate ran. ${error instanceof UnsafeLinksError ? "Those links would let a candidate write outside its copy: remove or replace them (e.g. a venv made with --copies), or use strong mode, or" : "Fix the cause (e.g. free space for the private dependency copies) and call again, or"} report status "blocked" with data.ultra.stage "candidates".`);
        }
        state.candidates.push(...added);
        state.candidateRounds = round;
        this.round = { manifest, ...(dependencies ? { dependencies } : {}), notes: copyNotes(reports) };
        this.event({ stage: "candidates", round, workers: prepared.map(worker => ({ id: worker.id, workspace: worker.workspace, ...(worker.from ? { from: worker.from } : {}) })), copies: reports.map(report => ({ dependencies: report.dependencies, relinked: report.relinked, rewritten: report.rewritten, readOnly: report.readOnly.length, privatized: report.privatized.length, submodules: report.submodules.length })) });
        return prepared;
      });
    }
    if (reason === "verification") {
      state.verifications.push({ ref: this.nextRef(), finished: 0, notPassed: 0 });
      this.event({ stage: "review", workers: workers.map(worker => worker.id) });
    }
    return workers;
  }

  async finish(reason: SpawnReason, workers: readonly PlannedWorker[], outcomes: SubWorkerOutcome[]): Promise<string[]> {
    const state = this.state;
    const lines: string[] = [];
    if (reason === "exploration") {
      const done = outcomes.filter(outcome => outcome.status === "done");
      const basis = done.filter(outcome => outcome.role === "implement");
      state.basisDone += basis.length;
      state.analystsDone += done.filter(outcome => outcome.role === "answer").length;
      const added = [...new Set(basis.flatMap(outcome => outcome.changes))].filter(path => !state.protectedPaths.includes(path));
      if (added.length) state.protectedPaths.push(...added);
      if (state.protectedPaths.length) await this.serial(async () => {
        const spaces = await this.spaces();
        if (!spaces) return;
        const manifest = await spaces.workspaceManifest();
        state.basis = Object.fromEntries(Object.entries(manifest).filter(([path]) => state.protectedPaths.some(owned => under(path, owned))));
      });
      lines.push(`Ultra exploration round ${state.explorationRounds}/${MAX_EXPLORATION_ROUNDS}: ${basis.length} basis builder(s) and ${done.length - basis.length} analyst(s) finished (${outcomes.length - done.length} did not).`,
        state.protectedPaths.length ? `Protected verification basis (candidates and you cannot change it; only another exploration round can): ${state.protectedPaths.join(", ")}.` : this.options.readOnly ? "" : "No basis file was written: the candidates are judged by the existing project checks only; say so in data.ultra.criteria.",
        state.basisDone && state.analystsDone || this.options.readOnly && state.analystsDone ? `Next: orche_spawn reason "candidates" with 2-${MAX_SUB_WORKERS} independent ${this.options.readOnly ? "answers" : "implementations, each with a different approach or hypothesis"}.` : `Candidates still need a finished ${state.basisDone ? "analyst" : "verification-basis builder"}: run another exploration round (cap ${MAX_EXPLORATION_ROUNDS}) or report status "blocked".`);
      this.event({ stage: "exploration", round: state.explorationRounds, basisDone: state.basisDone, analystsDone: state.analystsDone, protected: [...state.protectedPaths] });
      return lines.filter(Boolean);
    }
    if (reason === "candidates") {
      const ids = new Set(workers.map(worker => worker.id));
      const record = async () => {
        const spaces = this.options.readOnly ? undefined : await this.spaces();
        for (const outcome of outcomes) {
          const candidate = state.candidates.find(item => item.id === outcome.id);
          if (!candidate) continue;
          candidate.status = outcome.status;
          if (spaces && candidate.workspace) {
            candidate.changes = (await spaces.changes(candidate.id)).map(change => change.path);
            candidate.tampered = candidate.changes.filter(path => state.protectedPaths.some(owned => under(path, owned)));
            outcome.changes = [...candidate.changes];
            if (candidate.tampered.length) outcome.tampered = [...candidate.tampered];
          }
        }
        // Escape check: a candidate writes only in its copy, so the workspace and its own dependency directories must be what they were.
        const escaped: string[] = [];
        const round = this.round;
        this.round = undefined;
        if (spaces && round) {
          const now = await spaces.workspaceManifest().catch(() => undefined);
          const moved = now && round.manifest ? manifestDiff(round.manifest, now).map(change => change.path) : ["(the workspace could not be fingerprinted)"];
          if (moved.length) escaped.push(`workspace files changed during the round: ${moved.slice(0, 10).join(", ")}${moved.length > 10 ? `, … ${moved.length - 10} more` : ""}`);
          if (round.dependencies !== undefined && await spaces.dependencyFingerprint().catch(() => undefined) !== round.dependencies) escaped.push(`the workspace's own dependency directories (${DEPENDENCY_DIRS.join(", ")}) changed during the round`);
          if (escaped.length) for (const candidate of state.candidates) if (ids.has(candidate.id)) candidate.escaped = escaped;
        }
        return { escaped, notes: round?.notes ?? [] };
      };
      const { escaped, notes } = this.options.readOnly ? await record() : await this.serial(record);
      const checks = this.options.verifyCommands?.length ? this.options.verifyCommands.join(" && ") : "<the project's checks and the basis tests>";
      lines.push(`Ultra candidates round ${state.candidateRounds}/${MAX_CANDIDATE_ROUNDS}: ${outcomes.map(outcome => `${outcome.id} ${outcome.name} ${outcome.status}${outcome.workspace ? `, ${outcome.changes.length} file(s) changed` : ""}`).join("; ")}.`, ...notes);
      if (escaped.length) lines.push(`Isolation breach: ${escaped.join("; ")}. A candidate (or another process) wrote outside its copy, so none of this round's candidates can be adopted. Find and undo the change, then run another candidates round, or report status "blocked" with data.ultra.stage "candidates".`);
      if (!this.options.readOnly) lines.push(`Evaluate EVERY candidate with the same checks in its own copy, one call at a time, e.g. bash: cd '<workspace>' && ${checks}; judge by those runs, not by the candidates' reports, and cite their [orche ref Tn] in data.ultra.candidates and data.ultra.selection. A check counts for a copy only if the copy was the same before and after it and nothing else ran meanwhile. Adopt the best verified candidate with orche_adopt; a second candidates round (from: <id>) may fix one from its failure evidence while the earlier stays unchanged.`);
      else lines.push("Check the key claims of every candidate answer against the sources yourself (read, grep, bash) and cite those [orche ref Tn]; a claim without a checked source stays unsupported.");
      this.event({ stage: "candidates", round: state.candidateRounds, outcomes: outcomes.map(outcome => ({ id: outcome.id, status: outcome.status, changes: outcome.changes.length, ...(outcome.tampered ? { tampered: outcome.tampered } : {}) })), ...(escaped.length ? { escaped } : {}) });
      return lines;
    }
    if (reason === "verification") {
      const round = state.verifications.at(-1);
      if (round) {
        round.finished = outcomes.filter(outcome => outcome.status === "passed" || outcome.status === "not passed").length;
        round.notPassed = outcomes.filter(outcome => outcome.status === "not passed").length;
        lines.push(`Ultra review: ${round.finished} verifier(s) finished, ${round.notPassed} did not pass. Reproduce each finding yourself before acting on it: data.ultra.review classifies every finding as reproduced-fixed, reproduced-open (keeps the task blocked), unverified or refuted, with the refs of your own runs.`);
        this.event({ stage: "review", finished: round.finished, notPassed: round.notPassed });
      }
    }
    return lines;
  }

  // ---- orche_adopt ----
  async adopt(id: string, signal?: AbortSignal): Promise<string> {
    if (this.options.readOnly) throw new Error("orche_adopt is refused in a read-only (answer) assignment: an ultra answer selects a candidate answer and changes no file.");
    return this.serial(async () => {
      const candidate = this.state.candidates.find(item => item.id === id);
      if (!candidate?.workspace || !candidate.base) throw new Error(`Unknown implementation candidate ${id}; candidates: ${this.state.candidates.filter(item => item.workspace).map(item => item.id).join(", ") || "none"}.`);
      if (candidate.status !== "done") throw new Error(`${id} did not finish with a report (status ${candidate.status}); it cannot be adopted.`);
      if (candidate.escaped?.length) throw new Error(`${id}'s round broke isolation (${candidate.escaped.join("; ")}); none of its candidates can be adopted.`);
      if (this.state.adoptions.some(item => item.candidate === id)) throw new Error(`${id} is already adopted.`);
      const spaces = await this.spaces(signal);
      if (!spaces) throw new Error("The candidate workspaces are unavailable (no git work tree).");
      // The copy as it is now, not as its round left it: a shell command may have changed it since.
      const changes = (await spaces.changes(id, signal)).map(change => change.path);
      const tampered = changes.filter(path => this.state.protectedPaths.some(owned => under(path, owned)));
      if (tampered.length) { candidate.tampered = tampered; throw new Error(`${id} changed the protected verification basis (${tampered.join(", ")}); it cannot be adopted.`); }
      if (!changes.length) throw new Error(`${id} changed no file; there is nothing to adopt.`);
      const print = await spaces.fingerprint(id, signal);
      const checks = this.options.ledger().calls.filter(call => call.name === "bash" && !call.isError && refNumber(call.ref) > candidate.spawnRef && !!call.target?.includes(candidate.workspace!));
      if (!checks.length) throw new Error(`Run the checks in ${id}'s workspace first (bash: cd '${candidate.workspace}' && <checks>); a candidate is adopted only after a successful check of your own in its copy.`);
      if (!checks.some(call => this.sawCandidate(call, id, print))) throw new Error(`${id}'s copy is not what your checks in it (${checks.map(call => call.ref).join(", ")}) evaluated: it changed during or after them, or another call that can change files ran at the same time. Run the checks in its copy again, alone, then adopt.`);
      const base = candidate.workspaceBase ? JSON.parse(await readFile(candidate.workspaceBase, "utf8")) as Manifest : undefined;
      if (!base) throw new Error(`${id}'s base (the workspace when its copy was made) is unavailable; it cannot be adopted safely.`);
      const ref = this.nextRef();
      const { applied } = await spaces.adopt(id, changes, base, signal, async () => await spaces.fingerprint(id, signal) === print ? undefined : `${id}'s copy changed while it was copied`);
      candidate.changes = changes;
      this.state.adoptions.push({ candidate: id, files: applied, ref, fingerprint: print });
      this.event({ stage: "selection", adopted: id, files: applied, fingerprint: print });
      return `Adopted ${id} into the workspace: ${applied.length} file(s): ${applied.slice(0, 30).join(", ")}${applied.length > 30 ? ", …" : ""}. Next: run the full checks in the workspace (cite them in data.ultra.integration.evidence) and an orche_spawn verification round on the integrated result (counterexamples). Integration edits are allowed from now on; the checks you cite must have run after the last change of the workspace (by any tool or command), alone.`;
    });
  }

  // ---- the orchestrator's own writes ----
  /** Why a write of the orchestrator is refused in ultra mode (candidate copies, the protected basis, the workspace before an adoption). */
  guardWrite(toolName: string, input: Record<string, unknown>): string | undefined {
    if (!WRITE_TOOLS.has(toolName) || typeof input.path !== "string") return undefined;
    const path = resolve(this.options.cwd, input.path);
    const root = this.root;
    if (root && (path === root || path.startsWith(`${root}${sep}`))) return "Blocked (ultra): candidate workspaces are written only by their candidates; start a fix candidate (orche_spawn candidates with from) instead.";
    const inside = relative(this.options.cwd, path);
    if (inside.startsWith("..") || resolve(this.options.cwd, inside) !== path) return undefined;
    const rel = inside.split(sep).join("/");
    if (this.state.protectedPaths.some(owned => under(rel, owned))) return `Blocked (ultra): ${rel} is part of the protected verification basis; change it only with another exploration round.`;
    if (!this.options.readOnly && !this.state.adoptions.length) return "Blocked (ultra): the implementation happens in candidates (orche_spawn reason \"candidates\"); you edit the workspace only to integrate after orche_adopt.";
    return undefined;
  }

  /**
   * The workspace as the report sees it (taken when the report_result call opens, bound to that call): its content fingerprint and
   * whether the protected basis is what exploration left. Failures are recorded, never skipped: the gate then refuses.
   */
  private async refresh(toolCallId: string): Promise<void> {
    this.current = { call: toolCallId, error: "not taken" };
    this.basisChanged = [];
    const state = this.state;
    if (this.options.readOnly || !state.candidates.length && !state.adoptions.length && !state.protectedPaths.length) { this.current = { call: toolCallId }; return; }
    await this.serial(async () => {
      const spaces = await this.spaces();
      if (!spaces) { this.current = { call: toolCallId, error: "no git work tree" }; return; }
      try {
        const manifest = await spaces.workspaceManifest();
        this.current = { call: toolCallId, workspace: manifestDigest(manifest) };
        if (state.basis && state.protectedPaths.length) this.basisChanged = manifestDiff(state.basis, manifest, state.protectedPaths).map(change => change.path);
      } catch (error) { this.current = { call: toolCallId, error: error instanceof Error ? error.message : String(error) }; }
    });
  }

  // ---- the report gate ----
  /** Validation of the orchestrator's report (`validateResult`); undefined: accepted. */
  gateError(kind: string, data: unknown): string | undefined {
    if (kind !== (this.options.readOnly ? "answer" : "implement")) return undefined;
    const record = dataOf(data);
    const error = this.check(record);
    // A fingerprint serves exactly one report: the next report_result takes its own (or is refused without one).
    this.current = { error: "not taken for this report" };
    const stage = (record.ultra as { stage?: UltraStage } | undefined)?.stage;
    const complete = stage === "complete" && record.status !== "blocked";
    this.gateResult = error ? `rejected: ${error.slice(0, 300)}` : complete ? "passed" : `accepted as incomplete (stopped at ${stage})`;
    if (!error) this.reported = stage;
    if (error) this.event({ stage: "gate", rejected: error.slice(0, 2000) });
    return error;
  }

  private check(record: Record<string, unknown>): string | undefined {
    const ultra = record.ultra;
    if (!Value.Check(ultraReportSchema, ultra)) return `data.ultra is required in ultra mode${ultra === undefined ? "" : `: ${formatSchemaErrors(ultraReportSchema, ultra, 4)}`}. Expected ${FORMAT}.`;
    const report = ultra as UltraReport;
    const readOnly = this.options.readOnly;
    const blocked = !readOnly && record.status === "blocked";
    if (blocked) return typeof record.reason === "string" && record.reason.trim() ? undefined : "A blocked ultra report needs data.reason: where it stopped (data.ultra.stage), why, and what is preserved (candidates, adopted changes).";
    if (report.stage !== "complete") {
      if (!readOnly) return `data.ultra.stage is "${report.stage}": an ultra task that did not complete reports status "blocked" with data.reason; status "done" needs stage "complete".`;
      return Array.isArray(record.unresolved) && record.unresolved.length ? undefined : `data.ultra.stage is "${report.stage}": an incomplete ultra answer lists what is missing in data.unresolved.`;
    }
    const state = this.state;
    const problems: string[] = [];
    // The report must stand alone: another call that can change files, running at the same time, would make every fingerprint moot.
    const reportProbe = this.reportCall ? this.probes.get(this.reportCall) : undefined;
    if (reportProbe?.overlapped) problems.push("report_result ran together with another call that can change files: report alone, after the other calls finished");
    const calls = new Map(this.options.ledger().calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name)).map(call => [call.ref, call]));
    const cited = (items: readonly string[] | undefined, accept: (call: ToolRecord) => boolean) => citedRefs(items).map(ref => calls.get(ref)).filter((call): call is ToolRecord => !!call && accept(call));
    const workspaces = state.candidates.flatMap(item => item.workspace ? [item.workspace] : []);
    // Stages that ran (runtime records).
    if (readOnly ? !state.analystsDone : !state.basisDone || !state.analystsDone) problems.push(`the exploration stage is missing (${state.basisDone} basis builder(s), ${state.analystsDone} analyst(s) finished): run orche_spawn reason "exploration"`);
    const valid = state.candidates.filter(item => item.status === "done" || item.status === "blocked");
    if (valid.length < 2) problems.push(`two or more candidates with a report are required (${valid.length} so far): run orche_spawn reason "candidates"`);
    if (!report.criteria?.length) problems.push("data.ultra.criteria lists the acceptance criteria the candidates were judged by");
    // Every candidate accounted for; the selection names a finished, adopted candidate with execution evidence.
    const listed = new Set((report.candidates ?? []).map(item => item.id));
    const missing = state.candidates.filter(item => !listed.has(item.id)).map(item => item.id);
    const unknown = [...listed].filter(id => !state.candidates.some(item => item.id === id));
    if (missing.length) problems.push(`data.ultra.candidates must account for every candidate (missing ${missing.join(", ")})`);
    if (unknown.length) problems.push(`data.ultra.candidates names unknown candidates ${unknown.join(", ")}`);
    const selection = report.selection;
    const chosen = selection ? state.candidates.find(item => item.id === selection.chosen) : undefined;
    if (!selection) problems.push("data.ultra.selection is required: {chosen, reason, evidence}");
    else if (!chosen || chosen.status !== "done") problems.push(`data.ultra.selection.chosen must be a finished candidate (${state.candidates.filter(item => item.status === "done").map(item => item.id).join(", ") || "none"})`);
    else {
      if ((report.candidates ?? []).some(item => item.verdict === "chosen" && item.id !== chosen.id) || (report.candidates ?? []).find(item => item.id === chosen.id)?.verdict !== "chosen") problems.push(`data.ultra.candidates marks exactly the selected candidate ${chosen.id} as "chosen"`);
      const evidence = cited(selection.evidence, call => !call.isError && (readOnly || call.name === "bash" && !!chosen.workspace && !!call.target?.includes(chosen.workspace)));
      if (!evidence.length) problems.push(readOnly ? "data.ultra.selection.evidence cites [orche ref Tn] of your own successful source checks (read, grep, bash)" : `data.ultra.selection.evidence cites [orche ref Tn] of successful checks you ran in ${chosen.id}'s workspace (bash: cd '${chosen.workspace}' && …); a vote or a candidate's own report is no evidence`);
      const adopted = state.adoptions.find(item => item.candidate === chosen.id);
      if (!readOnly && !adopted) problems.push(`${chosen.id} is selected but not adopted: orche_adopt {candidate:"${chosen.id}"}`);
      // The cited checks must have evaluated exactly the content that was adopted (fingerprints before and after each check).
      else if (!readOnly && evidence.length && !evidence.some(call => this.sawCandidate(call, chosen.id, adopted!.fingerprint))) problems.push(`the selection evidence (${evidence.map(call => call.ref).join(", ")}) did not evaluate the content of ${chosen.id} that was adopted: the copy changed during or after those checks, they overlapped another call, or they ran before this assignment; run the checks in its copy again, alone, and cite them`);
    }
    // Review: a verification round after the last adoption (implement) or the last candidates round (answer).
    const lastAdopt = Math.max(0, ...state.adoptions.map(item => item.ref));
    const after = readOnly ? Math.max(0, ...state.candidates.map(item => item.spawnRef)) : lastAdopt;
    if (!state.verifications.some(round => round.ref > after && round.finished > 0)) problems.push(`an independent counterexample review is missing: orche_spawn reason "verification" ${readOnly ? "after the candidates" : "on the integrated result (after the last orche_adopt)"} with at least one verifier that finished`);
    const review = report.review;
    if (!review) problems.push("data.ultra.review is required ([] only when the verifiers found nothing)");
    else {
      if (!review.length && state.verifications.some(round => round.notPassed > 0)) problems.push("a verifier did not pass: classify each of its findings in data.ultra.review");
      for (const item of review) {
        if (item.status === "reproduced-open") problems.push(`reproduced counterexample still open (${item.finding.slice(0, 80)}): fix it and re-run the checks, or report status "blocked"`);
        if ((item.status === "reproduced-fixed" || item.status === "reproduced-open") && !citedRefs(item.evidence).some(ref => calls.has(ref))) problems.push(`review finding "${item.finding.slice(0, 60)}" is marked reproduced without a ref of your own run that reproduced it`);
        if (item.status === "refuted" && !cited(item.evidence, call => !call.isError).length) problems.push(`review finding "${item.finding.slice(0, 60)}" is marked refuted without a successful run of your own that refutes it`);
      }
    }
    if (readOnly) {
      if (!report.claims?.length) problems.push("data.ultra.claims lists the answer's claims with their sources");
      else for (const claim of report.claims) {
        if (claim.status === "supported" && !claim.sources.length) problems.push(`supported claim without a source: ${claim.claim.slice(0, 60)}`);
        const bad = citedRefs(claim.sources).filter(ref => !calls.get(ref) || calls.get(ref)!.isError);
        if (bad.length) problems.push(`claim "${claim.claim.slice(0, 60)}" cites ${bad.join(", ")}, not a successful call of yours`);
      }
    } else {
      // Integration: successful workspace checks after the last adoption and the last edit, whose fingerprints before and after the
      // check equal the workspace's fingerprint at this report: nothing changed during or after them, by any tool, command or process.
      const lastWrite = Math.max(lastAdopt, ...[...calls.values()].filter(call => !call.isError && (WRITE_TOOLS.has(call.name) || call.name === ADOPT_TOOL)).map(call => refNumber(call.ref)));
      const integration = cited(report.integration?.evidence, call => call.name === "bash" && !call.isError && refNumber(call.ref) > lastWrite && !workspaces.some(path => call.target?.includes(path)));
      const current = this.current.call !== undefined && this.current.call === this.reportCall ? this.current : { error: "not taken for this report" };
      if (!integration.length) problems.push(`data.ultra.integration.evidence cites [orche ref Tn] of successful checks you ran in the workspace after the last adoption or edit (after T${lastWrite})`);
      else if (!current.workspace) problems.push(`the workspace's content could not be fingerprinted for this report (${current.error ?? "unknown"}), so the integration checks cannot be tied to it: report status "blocked" with the reason if it persists`);
      else if (!integration.some(call => { const probe = this.stable(call); return !!probe && probe.before!.workspace === current.workspace && probe.after!.workspace === current.workspace; })) problems.push(`the workspace now differs from what your integration checks (${integration.map(call => call.ref).join(", ")}) evaluated: it changed during or after them (a shell command, an edit or another process), or they overlapped another call; run the full checks again, alone, after the last change and cite the new refs`);
      if (this.basisChanged.length) problems.push(`the protected verification basis changed in the workspace: ${this.basisChanged.join(", ")}; restore it (only an exploration round may change it)`);
    }
    if (!problems.length) return undefined;
    return `Ultra report gate: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? `; … ${problems.length - 6} more` : ""}. If a stage cannot be completed, report status "blocked" (an answer: data.unresolved) with data.ultra.stage where it stopped.`;
  }

  /**
   * The assignment ended: a completed run (`done`) removes the candidate copies (their space is freed; the report and the run record
   * keep what they were); otherwise they stay for a continuation of the same task. The private index is removed either way.
   */
  async end(done: boolean): Promise<void> {
    await this.serial(async () => {
      if (!this.workspaces) { this.workspaces = null; return; }
      if (done) await this.workspaces.discard();
      await this.workspaces.close();
    });
    // Closed for good: a late end of a call cut short by the assignment's end must not reopen (and clear) the copies.
    this.workspaces = null;
  }

  // ---- reporting ----
  stage(): UltraStage {
    const state = this.state;
    if (state.adoptions.length) return state.verifications.some(round => round.finished > 0 && round.ref > Math.max(...state.adoptions.map(item => item.ref))) ? "integration" : "review";
    if (state.candidates.length) return "evaluation";
    if (state.explorationRounds) return "candidates";
    return "exploration";
  }

  summary(): UltraSummary {
    const state = this.state;
    return {
      stage: this.gateResult === "passed" ? "complete" : this.reported && this.reported !== "complete" ? this.reported : this.stage(), explorationRounds: state.explorationRounds, candidateRounds: state.candidateRounds, protectedBasis: [...state.protectedPaths],
      candidates: state.candidates.map(item => ({ id: item.id, name: item.name, round: item.round, status: item.status, changes: item.changes.length, ...(item.tampered.length ? { tampered: true as const } : {}), ...(state.adoptions.some(adopted => adopted.candidate === item.id) ? { adopted: true as const } : {}) })),
      adoptions: state.adoptions.map(item => item.candidate), verificationRounds: state.verifications.length, ...(this.gateResult ? { gate: this.gateResult } : {}), ...(this.carried ? { carried: true as const } : {}),
    };
  }

  /** The `Ultra:` lines of the task result. */
  lines(): string[] {
    const summary = this.summary();
    return [
      `Ultra: stage ${summary.stage}; exploration ${summary.explorationRounds}/${MAX_EXPLORATION_ROUNDS} round(s), candidates ${summary.candidateRounds}/${MAX_CANDIDATE_ROUNDS} round(s) (${summary.candidates.map(item => `${item.id} ${item.status}${item.adopted ? " adopted" : ""}${item.tampered ? " basis-changed" : ""}`).join(", ") || "none"}), verification ${summary.verificationRounds}/${MAX_VERIFICATION_ROUNDS} round(s); report gate ${summary.gate ?? "not reached"}${summary.carried ? "; continued from the previous assignment of this task" : ""}`,
      ...(summary.protectedBasis.length ? [`Ultra protected basis: ${summary.protectedBasis.join(", ")}`] : []),
    ];
  }
}

/** The candidates-round notes on what the copies contain and share (the same for every copy of a round; listed once). */
function copyNotes(reports: readonly MaterializeReport[]): string[] {
  const unique = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map(item => [key(item), item])).values()];
  const dependencies = [...new Set(reports.flatMap(report => report.dependencies))];
  const readOnly = unique(reports.flatMap(report => report.readOnly), item => item.path);
  const privatized = [...new Set(reports.flatMap(report => report.privatized))];
  const submodules = [...new Set(reports.flatMap(report => report.submodules))];
  return [
    dependencies.length ? `Candidate copies: private copies of ${dependencies.join(", ")} (never linked to the workspace's own; links in them that led into the workspace lead into each copy${reports.some(report => report.rewritten) ? ", Python environment paths rewritten to the copy" : ""}). Dependency changes a candidate makes there are not adopted; install them in the workspace when you integrate.` : "",
    privatized.length ? `Writable files outside the copies that dependency links led to were copied into each copy instead: ${privatized.slice(0, 5).join(", ")}${privatized.length > 5 ? ", …" : ""}.` : "",
    readOnly.length ? `Shared read-only (verified not writable by this user): ${readOnly.slice(0, 5).map(item => `${item.path} -> ${item.target}`).join(", ")}${readOnly.length > 5 ? ", …" : ""}.` : "",
    submodules.length ? `Submodules ${submodules.slice(0, 10).join(", ")} are empty in the copies (not copied): candidates cannot change them (their file tools are blocked there) and checks that need them fail in the copies; use strong mode for such work.` : "",
    "Git-ignored files other than those dependency directories (build outputs, local settings such as .env) are not in the copies and are never adopted.",
  ].filter(Boolean);
}

/** orche_adopt: copy a verified candidate's changes into the workspace (ultra implement orchestrators only). */
export function createAdoptTool(context: () => UltraRun | string): ToolDefinition {
  return {
    name: ADOPT_TOOL,
    label: "orche adopt",
    description: "Ultra mode: copy one finished candidate's changed files from its workspace copy into the task workspace, after you ran checks in that copy. Refused when the workspace changed underneath (no blind merge), for a candidate that changed the protected verification basis, and in read-only assignments; a failed write is rolled back.",
    parameters: Type.Object({ candidate: Type.String({ minLength: 1, description: "The candidate's id, e.g. W1.3." }) }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_id, params, signal): Promise<AgentToolResult<undefined>> => {
      const run = context();
      if (typeof run === "string") return { content: [{ type: "text", text: run }], details: undefined, isError: true } as AgentToolResult<undefined>;
      try {
        return { content: [{ type: "text", text: await run.adopt((params as { candidate: string }).candidate, signal) }], details: undefined };
      } catch (error) {
        return { content: [{ type: "text", text: `Refused: ${error instanceof Error ? error.message : String(error)}` }], details: undefined, isError: true } as AgentToolResult<undefined>;
      }
    },
  } as ToolDefinition;
}

/** The ultra part of an implement/answer assignment prompt (prompt-based guidance next to the enforced contract above). */
export function ultraSection(readOnly: boolean): string {
  const caps = `Caps: exploration ${MAX_EXPLORATION_ROUNDS} rounds, candidates ${MAX_CANDIDATE_ROUNDS} rounds, verification ${MAX_VERIFICATION_ROUNDS} rounds per assignment, ${MAX_SUB_WORKERS} workers per orche_spawn call; sub-workers cannot spawn.`;
  const evidence = "Evidence items cite the [orche ref Tn] that ends each of your tool results; only your own successful runs count, never a sub-worker's report, a vote or the number of agreeing reports.";
  if (readOnly) return [
    "Ultra mode (quality first; the runtime enforces the stage order, the caps and the report gate). You are the orchestrator of this read-only question; sub-workers are read-only.",
    "1. Criteria: fix the question's explicit evaluation criteria (what a correct, complete answer must show) in data.ultra.criteria.",
    `2. Exploration (orche_spawn reason "exploration", 2-${MAX_SUB_WORKERS} answer workers): independent source finders/criteria builders and hypothesis analysts; give them only the question and references, never a draft answer.`,
    `3. Candidates (reason "candidates", 2-${MAX_SUB_WORKERS} answer workers): independent answers, each from a different angle, each claim with its sources.`,
    "4. Evaluation: check every candidate's key claims against the sources yourself (read, grep, bash); no code tests are required for a question.",
    "5. Selection: choose the best-supported candidate answer by the criteria; merge only claims you checked. 6. Review: orche_spawn reason \"verification\" with fresh verifiers that try to refute the selected answer's claims; reproduce or refute each finding yourself.",
    `Report data.ultra: ${FORMAT}. ${evidence} If a stage cannot be completed, set data.ultra.stage to where it stopped and list what is missing in data.unresolved. ${caps}`,
  ].join("\n");
  return [
    "Ultra mode (quality first; the runtime enforces the stage order, the caps, candidate isolation, the protected basis, adoption and the report gate). You are the orchestrator: you do not implement the solution in the workspace yourself; candidates do, and you edit the workspace only to integrate after an adoption.",
    "1. Requirements: fix the requirements and acceptance criteria in your Task DAG (task_plan) and in data.ultra.criteria; report an ambiguity you cannot resolve instead of guessing.",
    `2. Exploration (orche_spawn reason "exploration", 2-${MAX_SUB_WORKERS} workers, before any candidate): verification-basis builders (role implement) write tests or executable checks for the acceptance criteria in files they own, from the requirements alone, so that a wrong solution fails them; hypothesis/approach analysts (role answer) propose causes or approaches, each with a prediction and a check that would falsify it. Give them only the requirements and references, never a planned solution. The files the basis builders changed become the protected verification basis: nobody changes it afterwards except another exploration round.`,
    `3. Candidates (reason "candidates", 2-${MAX_SUB_WORKERS} implement workers): independent implementations, each with a different approach or hypothesis, each in its own workspace copy (named in the result); they cannot see each other. A second round may fix a candidate from its failure evidence only (from: its id); the earlier candidate stays unchanged as the incumbent.`,
    "4. Evaluation: run the same checks (the protected basis, the project's tests, typecheck/lint) in every candidate's copy yourself (bash: cd '<workspace>' && <checks>), one tool call per response; judge only by these runs. A check counts only for the exact content it saw: the runtime fingerprints the copies and the workspace before and after every bash call, so a check that changed files, overlapped another call, or was followed by a change (by any tool, shell command or process) has to be run again.",
    "5. Selection and adoption: choose the candidate with the best execution evidence (on a tie the simpler, smaller, less risky change); orche_adopt {candidate} copies its changes into the workspace (refused unless a successful check of yours saw its copy exactly as it is now, when its round broke isolation, or when the workspace changed underneath).",
    "6. Counterexample review: orche_spawn reason \"verification\" on the integrated result, asking for concrete counterexamples with reproduction commands. Reproduce each finding yourself: reproduced-fixed (fixed and re-checked), reproduced-open (keeps the task blocked), unverified (could not reproduce), refuted (your run disproves it).",
    "7. Integration: after the last change of the workspace, run the full project checks in the workspace, alone, and report right after them (report_result alone too), citing them in data.ultra.integration.evidence; the report is refused when the workspace differs from what they saw.",
    `Report data.ultra: ${FORMAT}. ${evidence} If a stage cannot be completed (no git work tree, candidates failed, a cap reached), report status "blocked" with data.ultra.stage set to where it stopped, data.reason, and what is preserved (candidates and their workspaces, adopted files). ${caps}`,
  ].join("\n");
}
