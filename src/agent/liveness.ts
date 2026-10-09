/**
 * Liveness: "is this session still actively working?", for the cases that are otherwise invisible (a bash command with no
 * stdout, a model request that has not answered yet, a provider backing off). One {@link LivenessTracker} per session
 * (every worker, the coordinator, every orche_task worker; advisors are NOT tracked: they have their own short timeouts) is
 * fed the session's own events and answers {@link LivenessTracker.liveness}`(now, windowMs)` at any moment. Nothing in here
 * changes a timeout or a limit: it only reports. A later consumer decides what to do with the verdict.
 *
 * ### What is observed (all structurally; nothing is imported from the SDK or from src/tools/bash.ts)
 *
 * - model output: any assistant `message_update` (text, thinking or tool-call deltas) and the end of a successful assistant message;
 * - a request in flight: `turn_start` (and the gap after a tool batch) until output arrives; `auto_retry_start` (provider backoff)
 *   and `compaction_start` count as a request too;
 * - tools in flight: `tool_execution_start` .. `tool_execution_end`, with their `tool_execution_update` partial output (an empty partial,
 *   such as the bash tool's acknowledgement at its start, is not output);
 * - bash heartbeats: `tool_execution_update` whose `partialResult.details.heartbeat` is a {@link BashHeartbeatSample}. A heartbeat
 *   that is `progressing` (output grew, CPU time grew or I/O grew) is a progress signal; one that is not means "the process is
 *   alive but is doing nothing" and is only reported, never counted.
 *
 * ### The verdict
 *
 * A session is *active* when it is not idle and at least one of these holds:
 *
 * 1. a **signal** happened within `windowMs`: model output, a tool start or end, tool partial output, or a progressing bash heartbeat;
 * 2. a **model request is in flight** and its last sign of life (the request start, or the last output/event of the run) is not
 *    older than {@link REQUEST_WAIT_MAX_MS}. This covers provider latency, long reasoning without streamed output and retry
 *    backoff, but a stuck HTTP call stops counting after the bound;
 * 3. a **non-bash tool is in flight** and has been for no longer than its bound ({@link TOOL_INFLIGHT_MAX_MS}, or the tool's own
 *    known timeout plus {@link TOOL_TIMEOUT_GRACE_MS}), even without updates: ast_rewrite, diagnostics, generate_image, ... are
 *    silent by nature. A bash call has NO such bound: it is judged by its progress alone (rule 1), so a silent `sleep 9999`
 *    stops counting once its last progress is older than the window, however long it has been "running";
 * 4. a **declared quiet wait**: a bash call started with an explicit `timeout` argument (seconds) counts as working while it runs
 *    within that timeout plus {@link TOOL_TIMEOUT_GRACE_MS}, even without output. The worker states how long the wait is meant to
 *    take; the tool kills it at that bound, and the owner's extension budget still caps the whole assignment, so a quiet wait can
 *    never extend a deadline without limit. A bash call without a timeout keeps rule 1 only.
 *
 * Idle sessions (no run in flight: waiting for an assignment) never count, whatever happened last. A session that is not idle
 * is in one of the states `tool` (a tool is in flight), `streaming` (a request is in flight and has produced output) or
 * `request-wait` (a request is in flight and has not, or the run is between steps).
 *
 * ### Constants and why
 *
 * - {@link DEFAULT_LIVENESS_WINDOW_MS} (2 min): how recent a signal must be when the caller names no window. Several bash
 *   heartbeats (every 15 s) and any streamed token fit well inside it, while a stalled session leaves it quickly.
 * - {@link REQUEST_WAIT_MAX_MS} (5 min): the longest a request is believed to be working without a sign of life. Slow reasoning
 *   models and provider retry backoff stay inside it; a hung connection does not count forever.
 * - {@link COMPACTION_MAX_MS} (15 min): a compaction in flight (its summary request) counts as working for at most this long
 *   after it started, even without events: a long summary of a large context is work, not a stall; a stuck one stops counting.
 *   How OFTEN a session compacts is never judged here (a long task compacts many times).
 * - {@link TOOL_INFLIGHT_MAX_MS} (10 min): the longest a silent non-bash tool is believed to be working; long type-checks or
 *   AST rewrites fit, a deadlocked tool does not count forever.
 * - {@link KNOWN_TOOL_TIMEOUTS_MS} / {@link TOOL_TIMEOUT_GRACE_MS}: a tool with its own timeout is bounded by it (plus a grace)
 *   instead of the generic bound; `generate_image` defaults to 180 s (see src/tools/generate-image.ts) and the owner of a
 *   configured `images.timeoutMs` passes it as `toolTimeoutsMs`.
 *
 * ### Limitations
 *
 * Without `/proc` (non-Linux) a bash heartbeat can only prove output: a silent but busy command is then reported as "alive,
 * no /proc data" and is not counted. A session without the heartbeat wrapper (a bash that never sends one) is judged by the
 * same rule: only start, output and progress within the window count.
 */

/** Window used when a caller names none. */
export const DEFAULT_LIVENESS_WINDOW_MS = 2 * 60_000;
/** A model request (or retry backoff, or the gap between steps) with no sign of life counts as working for at most this long. */
export const REQUEST_WAIT_MAX_MS = 5 * 60_000;
/** A compaction in flight counts as working for at most this long after its start, events or not. */
export const COMPACTION_MAX_MS = 15 * 60_000;
/** A non-bash tool without updates counts as working for at most this long after it started. */
export const TOOL_INFLIGHT_MAX_MS = 10 * 60_000;
/** Added to a tool's own known timeout: the tool is given this long to report its failure after its timer fired. */
export const TOOL_TIMEOUT_GRACE_MS = 30_000;
/** Known timeouts of tools that have their own, by tool name (ms). Mirrors the defaults in the tools themselves. */
export const KNOWN_TOOL_TIMEOUTS_MS: Readonly<Record<string, number>> = Object.freeze({ generate_image: 180_000 });
/** In-flight tools remembered per session; protects memory when a tool never reports its end. */
const MAX_FLIGHTS = 64;

export type LivenessState = "streaming" | "tool" | "request-wait" | "idle";

/** One session's verdict. `detail` is human-readable and has no tool arguments or output text. */
export interface SessionLiveness {
  id: string;
  role: string;
  state: LivenessState;
  /** Whether this session counts as working (see the module comment). */
  active: boolean;
  /** Last model output / tool event / tool partial output / progressing heartbeat (epoch ms); absent when there was none. */
  lastSignalAt?: number;
  detail: string;
}

export interface Liveness {
  /** Any session is active. */
  active: boolean;
  /** One line per active session: `<id> <detail>`, e.g. `W2 bash running 14m, output 20s ago`, `coordinator streaming 5s ago`. */
  reasons: string[];
  sessions: SessionLiveness[];
}

/**
 * A state change of a session, as it goes into the records/events stream (and the manager's event stream). Emitted when a
 * session's {@link LivenessState} changes and only then, never per heartbeat. `detail` is short: the tools in flight, or the retry.
 */
export interface LivenessEvent {
  type: "liveness";
  timestamp: number;
  /** The session id: a worker id, `coordinator`, or an orche_task worker id. */
  agentId: string;
  role: string;
  state: LivenessState;
  detail?: string;
}

/** The heartbeat a bash tool leaves as tool partial output (`partialResult.details.heartbeat`). Structural twin of the tool's own type. */
export interface BashHeartbeatSample {
  type: "bash_heartbeat";
  seq: number;
  at: number;
  elapsedMs: number;
  outputBytes: number;
  newOutput: boolean;
  cpuMs?: number;
  ioBytes?: number;
  processes?: number;
  procAvailable: boolean;
  progressing: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The heartbeat in a tool's `details` (`{ heartbeat: { type: "bash_heartbeat", ... } }`), or undefined when there is none. */
export function parseBashHeartbeat(details: unknown): BashHeartbeatSample | undefined {
  if (!isObject(details)) return undefined;
  const beat = details.heartbeat;
  if (!isObject(beat) || beat.type !== "bash_heartbeat") return undefined;
  return {
    type: "bash_heartbeat",
    seq: isFiniteNumber(beat.seq) ? beat.seq : 0,
    at: isFiniteNumber(beat.at) ? beat.at : 0,
    elapsedMs: isFiniteNumber(beat.elapsedMs) ? beat.elapsedMs : 0,
    outputBytes: isFiniteNumber(beat.outputBytes) ? beat.outputBytes : 0,
    newOutput: beat.newOutput === true,
    ...(isFiniteNumber(beat.cpuMs) ? { cpuMs: beat.cpuMs } : {}),
    ...(isFiniteNumber(beat.ioBytes) ? { ioBytes: beat.ioBytes } : {}),
    ...(isFiniteNumber(beat.processes) ? { processes: beat.processes } : {}),
    procAvailable: beat.procAvailable === true,
    // New output is progress by definition, whatever the sender computed.
    progressing: beat.progressing === true || beat.newOutput === true,
  };
}

/** The heartbeat carried by a `tool_execution_update` event, or undefined for any other event or a plain partial update. */
export function heartbeatOfEvent(event: { type: string }): BashHeartbeatSample | undefined {
  if (event.type !== "tool_execution_update") return undefined;
  const partial = (event as { partialResult?: unknown }).partialResult;
  return isObject(partial) ? parseBashHeartbeat(partial.details) : undefined;
}

/** True for a bash heartbeat that reports no progress: the process is alive and doing nothing, which is not activity. */
export function isIdleHeartbeat(event: { type: string }): boolean {
  const beat = heartbeatOfEvent(event);
  return beat !== undefined && !beat.progressing;
}

/**
 * A partial result that says nothing: no content parts (or only empty text) and no details. The SDK's bash tool sends one the moment
 * it starts (`{ content: [], details: undefined }`); that is the tool's start, not output.
 */
function isEmptyPartial(partial: unknown): boolean {
  if (!isObject(partial)) return true;
  const hasContent = Array.isArray(partial.content) && partial.content.some(part => !isObject(part) || part.type !== "text" || typeof part.text !== "string" || part.text.length > 0);
  return !hasContent && (partial.details === undefined || partial.details === null);
}

/** The time a tool is believed to be working without any update: its own timeout (plus a grace) when known, else the generic bound. */
export function toolInflightBoundMs(name: string, timeoutsMs?: Readonly<Record<string, number>>): number {
  const known = timeoutsMs && Object.hasOwn(timeoutsMs, name) ? timeoutsMs[name]
    : Object.hasOwn(KNOWN_TOOL_TIMEOUTS_MS, name) ? KNOWN_TOOL_TIMEOUTS_MS[name] : undefined;
  return known !== undefined && Number.isFinite(known) && known > 0 ? known + TOOL_TIMEOUT_GRACE_MS : TOOL_INFLIGHT_MAX_MS;
}

/** `45s`, `5m`, `2m05s`, `14m`, `1h`, `1h05m`: seconds are shown below ten minutes, minutes below an hour; a zero part is left out. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 10) return seconds ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h${String(rest).padStart(2, "0")}m` : `${Math.floor(minutes / 60)}h`;
}

interface Flight {
  toolCallId: string;
  name: string;
  startedAt: number;
  /** Last plain partial output (`tool_execution_update` without a heartbeat). */
  lastUpdateAt?: number;
  /** Last proof of progress: the start, partial output or a progressing heartbeat. */
  lastProgressAt: number;
  progress: "start" | "output" | "process";
  heartbeat?: { sample: BashHeartbeatSample; at: number };
  /** bash only: the explicit `timeout` of the call (ms), a declared quiet wait. */
  declaredMs?: number;
}

/** The explicit `timeout` (seconds, a number or an integer string) of a bash call's arguments, in ms; undefined without one. */
export function declaredBashTimeoutMs(args: unknown): number | undefined {
  if (!isObject(args)) return undefined;
  const raw = args.timeout;
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : undefined;
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export interface LivenessTrackerOptions {
  id: string;
  role: string;
  /** Known timeouts of tools that have their own (ms, by tool name), over {@link KNOWN_TOOL_TIMEOUTS_MS}. */
  toolTimeoutsMs?: Readonly<Record<string, number>>;
  /** Called when the session's state changes, and only then. It must not throw (a throw is ignored). */
  onChange?: (event: LivenessEvent) => void;
  /** Test seam: the clock used when `observe` / `liveness` get no explicit time. */
  now?: () => number;
}

/** An `AgentSessionEvent`, or anything shaped like one; the tracker looks at a few types and ignores the rest. */
export type SessionEventLike = { type: string; [key: string]: unknown };

export class LivenessTracker {
  readonly id: string;
  readonly role: string;
  private readonly toolTimeoutsMs: Readonly<Record<string, number>> | undefined;
  private readonly onChange: ((event: LivenessEvent) => void) | undefined;
  private readonly clock: () => number;
  private readonly flights = new Map<string, Flight>();
  /** A run (agent_start .. agent_settled) is in flight. */
  private running = false;
  /** When the current model request was sent (or is about to be: the gap after a tool batch). */
  private requestSince: number | undefined;
  /** Output arrived since `requestSince`. */
  private streamed = false;
  private lastOutputAt: number | undefined;
  /** The last event that shows the session moving (anything but a non-progressing heartbeat). */
  private lastEventAt: number | undefined;
  private lastSignalAt: number | undefined;
  private retry: { attempt: number; maxAttempts: number; delayMs: number } | undefined;
  private compaction: string | undefined;
  private compactionSince: number | undefined;
  private reported: LivenessState = "idle";

  constructor(options: LivenessTrackerOptions) {
    this.id = options.id;
    this.role = options.role;
    this.toolTimeoutsMs = options.toolTimeoutsMs;
    this.onChange = options.onChange;
    this.clock = options.now ?? Date.now;
  }

  /** Feed one session event (an `AgentSessionEvent`, or anything shaped like one). Never throws, never changes the session. */
  observe(event: SessionEventLike, now: number = this.clock()): void {
    try { this.apply(event, now); } catch { /* a malformed event is ignored */ }
    this.notify(now);
  }

  /** The state right now; independent of any time or window. */
  state(): LivenessState {
    if (this.flights.size) return "tool";
    if (!this.running && !this.retry && this.compaction === undefined) return "idle";
    return this.streamed ? "streaming" : "request-wait";
  }

  /** Verdict of this one session as the aggregate shape (`sessions` has one entry). */
  liveness(now: number = this.clock(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS, options: { idle?: boolean } = {}): Liveness {
    const session = this.session(now, windowMs, options);
    return { active: session.active, reasons: session.active ? [`${session.id} ${session.detail}`] : [], sessions: [session] };
  }

  /** `idle: true` forces the idle verdict (the owner knows the session has no assignment, whatever its events last said). */
  session(now: number = this.clock(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS, options: { idle?: boolean } = {}): SessionLiveness {
    const window = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : DEFAULT_LIVENESS_WINDOW_MS;
    const state = options.idle ? "idle" : this.state();
    const base = { id: this.id, role: this.role, state, ...(this.lastSignalAt !== undefined ? { lastSignalAt: this.lastSignalAt } : {}) };
    if (state === "idle") {
      return { ...base, state, active: false, detail: this.lastSignalAt !== undefined ? `idle, last signal ${formatDuration(now - this.lastSignalAt)} ago` : "idle" };
    }
    const recent = this.lastSignalAt !== undefined && now - this.lastSignalAt <= window;
    if (state === "tool") {
      const verdicts = [...this.flights.values()].map(flight => this.judge(flight, now, window));
      verdicts.sort((a, b) => Number(b.active) - Number(a.active));
      const shown = verdicts.slice(0, 3).map(verdict => verdict.text);
      if (verdicts.length > 3) shown.push(`+${verdicts.length - 3} more`);
      return { ...base, state, active: recent || verdicts.some(verdict => verdict.active), detail: shown.join("; ") };
    }
    // streaming / request-wait: a request is in flight (or about to be).
    const lastLife = Math.max(this.lastEventAt ?? 0, this.requestSince ?? 0);
    const compacting = this.compaction !== undefined && this.compactionSince !== undefined && now - this.compactionSince <= COMPACTION_MAX_MS;
    const waiting = now - lastLife <= REQUEST_WAIT_MAX_MS || compacting;
    const active = recent || waiting;
    let detail: string;
    if (state === "streaming" && this.lastOutputAt !== undefined && now - this.lastOutputAt <= window) {
      detail = `streaming ${formatDuration(now - this.lastOutputAt)} ago`;
    } else if (this.retry) {
      detail = `provider retry backoff (attempt ${this.retry.attempt}/${this.retry.maxAttempts}, ${formatDuration(this.retry.delayMs)})`;
    } else if (this.compaction !== undefined) {
      detail = `compaction (${this.compaction})${this.compactionSince !== undefined && now - this.compactionSince >= 60_000 ? ` running ${formatDuration(now - this.compactionSince)}` : ""}`;
    } else if (state === "streaming" && this.lastOutputAt !== undefined) {
      detail = `request in flight ${formatDuration(now - (this.requestSince ?? this.lastOutputAt))}, last output ${formatDuration(now - this.lastOutputAt)} ago`;
    } else {
      detail = `request in flight ${formatDuration(now - (this.requestSince ?? lastLife))}, no output yet`;
    }
    if (!active) detail += ` (no sign of life for ${formatDuration(now - lastLife)}, past the ${formatDuration(REQUEST_WAIT_MAX_MS)} bound)`;
    return { ...base, state, active, detail };
  }

  private judge(flight: Flight, now: number, window: number): { active: boolean; text: string } {
    const running = formatDuration(now - flight.startedAt);
    if (flight.name === "bash" || flight.heartbeat) {
      const age = now - flight.lastProgressAt;
      const quiet = flight.declaredMs !== undefined && now - flight.startedAt <= flight.declaredMs + TOOL_TIMEOUT_GRACE_MS;
      const active = age <= window || quiet;
      const parts = [`${flight.name} running ${running}`];
      if (flight.declaredMs !== undefined) parts.push(`declared quiet wait up to ${formatDuration(flight.declaredMs)}${quiet ? "" : " (passed)"}`);
      parts.push(flight.progress === "output" ? `output ${formatDuration(age)} ago`
        : flight.progress === "process" ? `cpu/io activity ${formatDuration(age)} ago` : "no output yet");
      // The latest heartbeat decides what is said about the process: idle now (even if it was busy a moment ago), or no heartbeat at all.
      if (flight.heartbeat && !flight.heartbeat.sample.progressing) parts.push("alive but not progressing");
      else if (age > window) parts.push("no recent progress");
      const beat = flight.heartbeat?.sample;
      if (beat) {
        const facts = [
          ...(beat.cpuMs !== undefined ? [`cpu ${beat.cpuMs < 1000 ? `${Math.round(beat.cpuMs)}ms` : `${(beat.cpuMs / 1000).toFixed(1)}s`}`] : []),
          ...(beat.processes !== undefined ? [`${beat.processes} proc${beat.processes === 1 ? "" : "s"}`] : []),
          ...(beat.procAvailable ? [] : ["no /proc data"]),
        ];
        if (facts.length) parts[parts.length - 1] += ` (${facts.join(", ")})`;
      }
      return { active, text: parts.join(", ") };
    }
    const bound = toolInflightBoundMs(flight.name, this.toolTimeoutsMs);
    const lastSignal = flight.lastUpdateAt ?? flight.startedAt;
    const withinBound = now - flight.startedAt <= bound;
    const active = withinBound || now - lastSignal <= window;
    let text = `${flight.name} running ${running}, ${flight.lastUpdateAt !== undefined ? `update ${formatDuration(now - flight.lastUpdateAt)} ago` : "no updates"}`;
    if (!active) text += `, past the ${formatDuration(bound)} bound`;
    return { active, text };
  }

  private progress(flight: Flight, kind: "output" | "process", now: number): void {
    flight.lastProgressAt = now;
    flight.progress = kind;
    this.lastSignalAt = now;
  }

  private startRequest(now: number): void {
    this.running = true;
    this.requestSince = now;
    this.streamed = false;
    this.retry = undefined;
  }

  private apply(event: SessionEventLike, now: number): void {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.startRequest(now);
        this.lastEventAt = now;
        break;
      case "message_start": {
        if (!isObject(event.message) || event.message.role !== "assistant") break;
        if (this.requestSince === undefined) this.startRequest(now);
        this.running = true;
        this.lastEventAt = now;
        break;
      }
      case "message_update": {
        if (isObject(event.message) && event.message.role !== undefined && event.message.role !== "assistant") break;
        this.running = true;
        this.streamed = true;
        this.retry = undefined;
        this.lastOutputAt = this.lastEventAt = this.lastSignalAt = now;
        break;
      }
      case "message_end": {
        if (!isObject(event.message) || event.message.role !== "assistant") break;
        this.running = true;
        this.lastEventAt = now;
        // A failed request ended; it did not produce work. The retry or the end of the run follows.
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") break;
        this.streamed = true;
        this.retry = undefined;
        this.lastOutputAt = this.lastSignalAt = now;
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId;
        if (typeof id !== "string") break;
        this.running = true;
        this.flights.delete(id);
        const name = String(event.toolName ?? "tool");
        const declaredMs = name === "bash" ? declaredBashTimeoutMs(event.args) : undefined;
        this.flights.set(id, { toolCallId: id, name, startedAt: now, lastProgressAt: now, progress: "start", ...(declaredMs !== undefined ? { declaredMs } : {}) });
        while (this.flights.size > MAX_FLIGHTS) this.flights.delete(this.flights.keys().next().value!);
        this.lastEventAt = this.lastSignalAt = now;
        break;
      }
      case "tool_execution_update": {
        const id = event.toolCallId;
        if (typeof id !== "string") break;
        this.running = true;
        let flight = this.flights.get(id);
        if (!flight) {
          flight = { toolCallId: id, name: String(event.toolName ?? "tool"), startedAt: now, lastProgressAt: now, progress: "start" };
          this.flights.set(id, flight);
        }
        const beat = heartbeatOfEvent(event);
        if (beat) {
          flight.heartbeat = { sample: beat, at: now };
          if (!beat.progressing) break; // alive but idle: reported, not counted
          this.progress(flight, beat.newOutput ? "output" : "process", now);
        } else if (isEmptyPartial(event.partialResult)) {
          break; // the tool's start acknowledgement, not output
        } else {
          flight.lastUpdateAt = now;
          this.progress(flight, "output", now);
        }
        this.lastEventAt = now;
        break;
      }
      case "tool_execution_end": {
        if (typeof event.toolCallId !== "string") break;
        this.flights.delete(event.toolCallId);
        this.lastEventAt = this.lastSignalAt = now;
        // The next model request follows the last tool of a batch.
        if (!this.flights.size) { this.requestSince = now; this.streamed = false; }
        break;
      }
      case "turn_end":
        this.lastEventAt = now;
        break;
      case "agent_end":
        this.flights.clear();
        this.requestSince = undefined;
        this.streamed = false;
        this.lastEventAt = now;
        // `willRetry`: a provider error is about to be retried; the run is not over.
        if (event.willRetry !== true) this.running = false;
        break;
      case "agent_settled":
        this.flights.clear();
        this.running = false;
        this.requestSince = undefined;
        this.streamed = false;
        this.retry = undefined;
        this.compaction = undefined;
        this.compactionSince = undefined;
        this.lastEventAt = now;
        break;
      case "auto_retry_start":
      case "summarization_retry_scheduled":
        this.streamed = false;
        this.retry = {
          attempt: isFiniteNumber(event.attempt) ? event.attempt : 1,
          maxAttempts: isFiniteNumber(event.maxAttempts) ? event.maxAttempts : 1,
          delayMs: isFiniteNumber(event.delayMs) ? event.delayMs : 0,
        };
        this.lastEventAt = now;
        break;
      case "auto_retry_end":
      case "summarization_retry_finished":
        this.retry = undefined;
        this.lastEventAt = now;
        break;
      case "compaction_start":
        this.compaction = typeof event.reason === "string" ? event.reason : "compaction";
        this.compactionSince = now;
        this.lastEventAt = now;
        break;
      case "compaction_end":
        this.compaction = undefined;
        this.compactionSince = undefined;
        this.lastEventAt = now;
        break;
      default:
        break;
    }
  }

  /** Compact detail of a state change for the events stream: the tools in flight, the retry, or nothing. */
  private shortDetail(state: LivenessState): string | undefined {
    if (state === "tool") {
      const names = [...new Set([...this.flights.values()].map(flight => flight.name))];
      return `${names.slice(0, 3).join(",")}${names.length > 3 ? `,+${names.length - 3}` : ""}`;
    }
    if (state === "request-wait") {
      if (this.retry) return `retry ${this.retry.attempt}/${this.retry.maxAttempts}`;
      if (this.compaction !== undefined) return "compaction";
    }
    return undefined;
  }

  private notify(now: number): void {
    const state = this.state();
    if (state === this.reported) return;
    this.reported = state;
    if (!this.onChange) return;
    const detail = this.shortDetail(state);
    try { this.onChange({ type: "liveness", timestamp: now, agentId: this.id, role: this.role, state, ...(detail ? { detail } : {}) }); } catch { /* an observer cannot alter a session */ }
  }
}

/** The verdict of several sessions as one: active when any is, every active session's reason, every session's entry. */
export function mergeLiveness(...parts: readonly (Liveness | undefined)[]): Liveness {
  const sessions: SessionLiveness[] = [];
  const reasons: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    sessions.push(...part.sessions);
    reasons.push(...part.reasons);
  }
  return { active: sessions.some(session => session.active), reasons, sessions };
}

/** {@link mergeLiveness} of the given trackers, evaluated at one `now` and `windowMs`. */
export function aggregateLiveness(trackers: Iterable<LivenessTracker>, now: number = Date.now(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS): Liveness {
  return mergeLiveness(...[...trackers].map(tracker => tracker.liveness(now, windowMs)));
}
