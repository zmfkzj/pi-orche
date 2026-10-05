import { join } from "node:path";

/**
 * Session records: opt-in persistence of orche's sub-sessions (coordinator, workers, verifiers, advisors) as regular
 * pi session JSONL files. Nothing here is on by default: a session is written only when its creator is handed a
 * {@link SessionTarget}, either directly (`SessionOptions.sessionDir` / `sessionFile`) or through a {@link SessionRecords}
 * hook (`AgentManagerOptions.records`, `RunOptions.records`). The orchestration layer only knows these neutral types;
 * where the files live (the extension's `<agentDir>/orche/records/...` layout) is decided by the hook's owner.
 */

/** Where a session is persisted; the fields mean what they mean in `SessionOptions` (`sessionFile` wins). */
export interface SessionTarget {
  /** Directory for a new JSONL file named by the SDK (`<timestamp>_<session id>.jsonl`). */
  sessionDir?: string;
  /** Exactly this file. Created when missing; an existing file is continued (its entries are loaded). */
  sessionFile?: string;
}

/** `specialist`: a one-shot session of the single workflow's v2 pipeline (Framer, Verifier). */
export type RecordedKind = "coordinator" | "worker" | "advisor" | "specialist";

/** The agent a session belongs to. `id` is unique within a run: `coordinator`, worker ids (`A1`, `V1`, `W3`), `advisor:<name>#<n>`. */
export interface RecordedActor {
  id: string;
  /** Route role (`coordinator`, `implementer`, `explorer-path`, `verifier`, `advisor`, ...). */
  role: string;
  kind: RecordedKind;
}

/**
 * Manifest entry of one agent (`run.json` → `agents[]`), produced by {@link AgentManager.agentRecord} for workers and
 * by the run for the coordinator and each advisor call.
 */
export interface AgentRecordEntry {
  id: string;
  role: string;
  kind: RecordedKind;
  /** Configured route model (`provider/model`) and thinking level. */
  model: string;
  thinking?: string;
  /** Model requests over the agent's whole life (every assignment; the request that was cut off by an abort counts). */
  requests: number;
  /** Models that actually answered, `provider/model` → requests (can differ from the configured route). */
  models: Record<string, number>;
  /** Time the agent spent working: the sum of its assignments (workers), or creation to disposal (coordinator, advisor calls). */
  durationMs: number;
  /** When the agent's session was created (epoch ms). */
  startedAt: number;
  /**
   * Workers: the last assignment's outcome (`completed`, `failed`, `no_result`, `stopped`, `superseded`), `running`, or `idle` when
   * it never finished one. Coordinator and advisors: `completed`, `failed` or `cancelled`.
   */
  status: string;
  /** Assignments the agent finished. */
  assignments?: number;
  /** Absolute path of the session JSONL; absent for in-memory sessions. */
  sessionFile?: string;
  error?: string;
}

/** Persistence hooks for one run or one manager. Every member is optional; an absent hook means "in memory, nothing collected". */
export interface SessionRecords {
  /** Persist this actor's session: return its target, or undefined to keep it in memory. Must not throw (a throw is treated as undefined). */
  sessionTarget?(actor: RecordedActor): SessionTarget | undefined;
  /**
   * Receives the entry of an agent once it is finished (worker disposed, coordinator torn down, advisor call ended), at most once per
   * agent. Must not throw (a throw is ignored).
   */
  onAgent?(entry: AgentRecordEntry): void;
}

/** File-name-safe form of an agent id (`advisor:sec#1` → `advisor-sec-1`). */
export function safeFileName(id: string): string {
  const name = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  return name || "agent";
}

/**
 * Call a user hook without letting it affect the caller: a throw means "no target" / "ignored".
 */
export function targetOf(records: SessionRecords | undefined, actor: RecordedActor): SessionTarget | undefined {
  try {
    const target = records?.sessionTarget?.(actor);
    return target && (target.sessionFile || target.sessionDir) ? target : undefined;
  } catch { return undefined; }
}

export function reportAgent(records: SessionRecords | undefined, entry: AgentRecordEntry): void {
  try { records?.onAgent?.(entry); } catch { /* a collector can never alter a run */ }
}

/**
 * The simplest opt-in: every actor's session goes to `<dir>/<safe id>.jsonl` (a repeated id gets `-2`, `-3`, ...), and the
 * entries are collected in `entries`. Used by the eval/benchmark runners when they are asked to keep transcripts.
 */
export function directorySessionRecords(dir: string): SessionRecords & { entries: AgentRecordEntry[] } {
  const used = new Set<string>();
  const entries: AgentRecordEntry[] = [];
  return {
    entries,
    sessionTarget(actor) {
      const base = safeFileName(actor.id);
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
      used.add(name);
      return { sessionFile: join(dir, `${name}.jsonl`) };
    },
    onAgent(entry) { entries.push(entry); },
  };
}
