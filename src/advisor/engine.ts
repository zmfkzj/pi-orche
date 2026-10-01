import { cleanupWait } from "../orchestration/run/deadline.js";
import { randomUUID } from "node:crypto";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent/agent-manager.js";
import type { ManagerEvent } from "../agent/agent-handle.js";
import type { CoordinatorEvent } from "../orchestration/events.js";
import type { CoordinatorDecision } from "../orchestration/phases.js";
import { resolveRoute, type ModelRoute, type RouteConfig } from "../orchestration/routing.js";
import {
  COMPLETING_DECISIONS, resolveAdvisor,
  type AdvisorConfig, type AdvisorTrigger, type AdvisorTriggerKind, type ResolvedAdvisor,
} from "./config.js";
import { clip, LIMITS, renderTranscript, workspaceDiff } from "./context.js";
import { advisorPrompt } from "./prompt.js";
import { runAdvisorSession, type AdvisorVerdict } from "./session.js";

export interface AdvisorHost {
  cwd: string;
  problem: string;
  runtime: ModelRuntime;
  routes: RouteConfig;
  manager: Pick<AgentManager, "subscribe" | "session" | "get" | "list" | "send">;
  coordinator: () => AgentSession | undefined;
  emit: (event: CoordinatorEvent) => void;
  signal?: AbortSignal;
}
interface Budget {
  calls: number; perTarget: Map<string, number>; lastStart: Map<string, number>; busy: Set<string>;
  /** Non-await reviews that arrived while the same recipient was busy; key `${recipient}|${subject}`. */
  queued: Map<string, () => void>;
}
interface Flight { recipient: string; task: Promise<number> }
/** Tool failures of the harness' own control tools are protocol noise, not worker trouble. */
const controlTools: readonly string[] = ["report_result", "send_message"];

/**
 * Trigger filtering, budgets and delivery for the configured advisors. No scheduler: every trigger is an
 * event filter plus counters. Calls run concurrently with the observed agents; only `await` decision
 * triggers and coordinator-bound advice that is still in flight at the next decision make the coordinator wait.
 */
export class AdvisorEngine {
  private readonly advisors: ResolvedAdvisor[];
  private readonly routeOf = new Map<string, ModelRoute>();
  private readonly budgets = new Map<string, Budget>();
  private readonly turns = new Map<string, number>();
  private readonly cursors = new Map<string, number>();
  private readonly attached = new Map<string, () => void>();
  private readonly flights = new Set<Flight>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly abort = new AbortController();
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private pendingCreations = 0;
  private pendingAborts = 0;

  constructor(configs: readonly AdvisorConfig[], private readonly host: AdvisorHost) {
    if (host.signal?.aborted) { this.disposed = true; this.abort.abort(host.signal.reason); }
    else host.signal?.addEventListener("abort", this.onHostAbort, { once: true });
    this.advisors = configs.filter(config => config.enabled !== false).map(resolveAdvisor);
    for (const advisor of this.advisors) {
      this.routeOf.set(advisor.name, resolveRoute(host.routes, advisor.route));
      this.budgets.set(advisor.name, { calls: 0, perTarget: new Map(), lastStart: new Map(), busy: new Set(), queued: new Map() });
    }
  }
  get active(): boolean {
    return this.advisors.length > 0;
  }

  start(): void {
    this.unsubscribe = this.host.manager.subscribe(event => this.onManagerEvent(event));
    for (const advisor of this.advisors) {
      for (const trigger of advisor.triggers) {
        if (trigger.on !== "interval") continue;
        const timer = setInterval(() => {
          for (const worker of this.host.manager.list()) {
            if (worker.status === "running") this.consider(advisor, trigger, worker.id, { agentId: worker.id, intervalMs: trigger.ms });
          }
        }, trigger.ms);
        timer.unref();
        this.timers.push(timer);
      }
    }
  }

  /**
   * Run the advisors matching a coordinator decision. Returns the number of NOTES injected by advisors the
   * coordinator had to wait for (await triggers and before_complete); background advisors never block.
   */
  async onDecision(decision: CoordinatorDecision, phase: string, maxMs: number): Promise<number> {
    const detail = { phase, decision };
    const waiting: Promise<number>[] = [];
    const background: (() => void)[] = [];
    for (const advisor of this.advisors) {
      for (const trigger of advisor.triggers) {
        const awaiting = trigger.on === "before_complete" || (trigger.on === "coordinator_decision" && trigger.await === true);
        const matches = trigger.on === "before_complete"
          ? COMPLETING_DECISIONS.includes(decision.type)
          : trigger.on === "coordinator_decision"
            && (!trigger.decisions || trigger.decisions.includes(decision.type))
            && (!trigger.phases || trigger.phases.includes(phase));
        if (!matches) continue;
        const start = () => this.launch(advisor, trigger.on, "coordinator", "coordinator", detail, awaiting, maxMs);
        if (awaiting) {
          const task = start();
          if (task) waiting.push(task);
        } else background.push(start);
      }
    }
    for (const start of background) start();
    return (await Promise.all(waiting)).reduce((sum, delivered) => sum + delivered, 0);
  }

  /** Let in-flight coordinator-bound advice land before the next decision (bounded; workers are never held). */
  async settle(maxMs: number): Promise<void> {
    const { promise: expired, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => resolve(false), Math.max(0, maxMs));
    try {
      // A finished call may start a queued one (see launch), so re-check until no coordinator-bound call is left.
      for (;;) {
        const pending = [...this.flights].filter(flight => flight.recipient === "coordinator").map(flight => flight.task);
        if (!pending.length || !(await Promise.race([Promise.all(pending).then(() => true), expired]))) return;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private readonly onHostAbort = () => { void this.disposeWithin(0); };
  async dispose(): Promise<void> { await this.disposeWithin(1000); }
  async disposeWithin(timeoutMs: number): Promise<boolean> {
    this.disposed = true;
    this.host.signal?.removeEventListener("abort", this.onHostAbort);
    this.abort.abort();
    this.unsubscribe?.();
    for (const timer of this.timers) clearInterval(timer);
    for (const detach of this.attached.values()) detach();
    this.attached.clear();
    const settled = await cleanupWait(Promise.allSettled([...this.flights].map(flight => flight.task)), timeoutMs);
    return settled && this.pendingCreations === 0 && this.pendingAborts === 0;
  }

  private onManagerEvent(event: ManagerEvent): void {
    if (this.disposed) return;
    if (event.type === "assignment_started") {
      this.attach(event.agentId);
      const { kind, prompt } = event.assignment;
      this.fire("assignment_started", event.agentId, { agentId: event.agentId, kind, assignment: clip(prompt, 1500) }, kind);
    } else if (event.type === "assignment_outcome") {
      const { outcome } = event;
      if (outcome.status === "superseded" || outcome.status === "stopped") return;
      this.fire("assignment_result", outcome.agentId, {
        agentId: outcome.agentId, kind: outcome.kind, status: outcome.status,
        result: outcome.result, ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.lastText ? { lastText: clip(outcome.lastText, 1500) } : {}),
      }, outcome.kind);
    }
  }
  /** Per-worker session hooks (turn counting, tool errors), installed on the first assignment. */
  private attach(agentId: string): void {
    if (this.attached.has(agentId)) return;
    let session: AgentSession;
    try { session = this.host.manager.session(agentId); } catch { return; }
    this.attached.set(agentId, session.subscribe(event => {
      if (this.disposed) return;
      if (event.type === "turn_end") this.fire("turn_end", agentId, { agentId });
      else if (event.type === "tool_execution_end" && event.isError && !controlTools.includes(event.toolName)) {
        this.fire("tool_error", agentId, { agentId, tool: event.toolName, error: clip(JSON.stringify(event.result ?? null), 1200) });
      }
    }));
  }

  private fire(kind: AdvisorTriggerKind, subject: string, detail: Record<string, unknown>, assignmentKind?: string): void {
    for (const advisor of this.advisors) {
      for (const trigger of advisor.triggers) {
        if (trigger.on !== kind) continue;
        if ((trigger.on === "assignment_started" || trigger.on === "assignment_result") && trigger.kinds && !trigger.kinds.includes(assignmentKind ?? "")) continue;
        this.consider(advisor, trigger, subject, detail);
      }
    }
  }
  private consider(advisor: ResolvedAdvisor, trigger: AdvisorTrigger, subject: string, detail: Record<string, unknown>): void {
    if (trigger.on === "turn_end") {
      const key = `${advisor.name}|${advisor.triggers.indexOf(trigger)}|${subject}`;
      const count = (this.turns.get(key) ?? 0) + 1;
      this.turns.set(key, count % trigger.every);
      if (count % trigger.every !== 0) return;
      detail = { ...detail, turnsObserved: trigger.every };
    }
    for (const recipient of this.recipients(advisor, subject)) this.launch(advisor, trigger.on, subject, recipient, detail, false);
  }
  private recipients(advisor: ResolvedAdvisor, subject: string): string[] {
    const out = new Set<string>();
    for (const target of advisor.targets) {
      if (target === "coordinator") out.add("coordinator");
      else if (target === "workers" || target === `agent:${subject}` || target === `role:${this.roleOf(subject)}`) out.add(subject);
    }
    return [...out];
  }
  private roleOf(agentId: string): string {
    if (agentId === "coordinator") return "coordinator";
    try { return this.host.manager.get(agentId).role; } catch { return "unknown"; }
  }

  /** Budget / cooldown / one-at-a-time gate, then run in the background. Returns the task unless gated. */
  private launch(
    advisor: ResolvedAdvisor, trigger: AdvisorTriggerKind, subject: string, recipient: string,
    detail: Record<string, unknown>, awaiting: boolean, maxMs = Infinity,
  ): Promise<number> | undefined {
    if (this.disposed) return undefined;
    const budget = this.budgets.get(advisor.name)!;
    const now = Date.now();
    const last = budget.lastStart.get(recipient);
    if (budget.busy.has(recipient)) {
      // Never drop a distinct review because another is running: remember it (one per subject) and start it when the call finishes.
      if (!awaiting) budget.queued.set(`${recipient}|${subject}`, () => this.launch(advisor, trigger, subject, recipient, detail, false));
      return undefined;
    }
    if (budget.calls >= advisor.maxCallsPerRun
      || (budget.perTarget.get(recipient) ?? 0) >= advisor.maxCallsPerTarget
      || (last !== undefined && now - last < advisor.cooldownMs)) return undefined;
    budget.calls++;
    budget.perTarget.set(recipient, (budget.perTarget.get(recipient) ?? 0) + 1);
    budget.lastStart.set(recipient, now);
    budget.busy.add(recipient);
    this.host.emit({ type: "advisor_triggered", timestamp: now, name: advisor.name, target: recipient, trigger, subject, await: awaiting });
    const task = this.execute(advisor, trigger, subject, recipient, detail, awaiting, maxMs);
    const flight: Flight = { recipient, task };
    this.flights.add(flight);
    void task.finally(() => {
      budget.busy.delete(recipient);
      this.flights.delete(flight);
      const next = [...budget.queued].find(([key]) => key.startsWith(`${recipient}|`));
      if (next) {
        budget.queued.delete(next[0]);
        next[1]();
      }
    }).catch(() => undefined);
    return task;
  }

  private async execute(
    advisor: ResolvedAdvisor, trigger: AdvisorTriggerKind, subject: string, recipient: string,
    detail: Record<string, unknown>, awaiting: boolean, maxMs: number,
  ): Promise<number> {
    const emitFailure = (reason: string) => {
      if (!this.disposed) this.host.emit({ type: "advisor_failed", timestamp: Date.now(), name: advisor.name, target: recipient, trigger, reason: clip(reason, 400) });
    };
    try {
      const prompt = await this.buildPrompt(advisor, trigger, subject, recipient, detail, awaiting);
      const verdict = await runAdvisorSession({
        advisor, route: this.routeOf.get(advisor.name)!, runtime: this.host.runtime, cwd: this.host.cwd, prompt,
        timeoutMs: Math.min(advisor.timeoutMs, maxMs), signal: this.abort.signal,
        onCreationPending: pending => { this.pendingCreations += pending ? 1 : -1; },
        onAbortPending: pending => { this.pendingAborts += pending ? 1 : -1; },
        onUsage: usage => this.host.emit({ type: "advisor_usage", timestamp: Date.now(), name: advisor.name, ...usage }),
        onContextWindow: info => this.host.emit({ type: "context_window", timestamp: Date.now(), actor: `advisor:${advisor.name}`, ...info }),
      });
      const delivered = await this.deliver(advisor, trigger, subject, recipient, verdict);
      if (!this.disposed) {
        this.host.emit({ type: "advisor_result", timestamp: Date.now(), name: advisor.name, target: recipient, trigger, verdict: verdict.verdict, notes: verdict.notes, delivered });
      }
      return delivered ? 1 : 0;
    } catch (error) {
      emitFailure(error instanceof Error ? error.message : String(error));
      return 0;
    }
  }
  private async deliver(advisor: ResolvedAdvisor, trigger: AdvisorTriggerKind, subject: string, recipient: string, verdict: AdvisorVerdict): Promise<boolean> {
    if (verdict.verdict === "ok" || !verdict.notes.length || this.disposed) return false;
    const lines = verdict.notes.map(note => `- [${note.domain}] ${note.text}${note.evidence ? ` (evidence: ${note.evidence})` : ""}`);
    const receipt = await this.host.manager.send({
      id: randomUUID(), type: "note", from: `advisor:${advisor.name}`, to: recipient === "coordinator" ? "main" : recipient,
      content: `Advisor ${advisor.name} — ${verdict.verdict.toUpperCase()} (on ${trigger} of ${subject}). Advisory only; you decide.\n${lines.join("\n")}`,
      signal: { kind: `advisor_${verdict.verdict}`, data: { advisor: advisor.name, trigger, subject } },
    });
    return receipt.status === "delivered";
  }
  private async buildPrompt(
    advisor: ResolvedAdvisor, trigger: AdvisorTriggerKind, subject: string, recipient: string,
    detail: Record<string, unknown>, awaiting: boolean,
  ): Promise<string> {
    let session: AgentSession | undefined;
    try { session = subject === "coordinator" ? this.host.coordinator() : this.host.manager.session(subject); } catch { /* agent gone */ }
    const cursorKey = `${advisor.name}|${subject}`;
    const tail = session ? renderTranscript(session.messages, this.cursors.get(cursorKey) ?? 0) : { text: "", next: 0 };
    this.cursors.set(cursorKey, tail.next);
    return advisorPrompt({
      advisorName: advisor.name, trigger, subject, subjectRole: this.roleOf(subject), recipient,
      problem: this.host.problem, detail, transcript: tail.text, diff: await workspaceDiff(this.host.cwd, LIMITS.diffChars, this.abort.signal), awaiting,
    });
  }
}
