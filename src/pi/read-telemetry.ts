/**
 * Read telemetry of an orche session (docs/compaction.md "Measuring compaction"): how much an assignment reads again what it had read,
 * in total and right after each compaction. A repeated read after a compaction is a PROXY for context the summary did not keep
 * (it may as well be a deliberate re-check or a file that changed); it is recorded to compare summary budgets, never to steer.
 *
 * - A read is a successful call of the `read` tool; its key is the `path` input as given, its size the characters of its text result.
 * - A repeat is a read whose path this assignment read before (another range of the same file counts too: the summary keeps a path,
 *   not ranges).
 * - After a compaction, the first {@link POST_COMPACTION_WINDOW} tool calls form that compaction's window; a read there of a path read
 *   before the compaction counts as a post-compaction repeat. Windows end early at the next compaction.
 * Everything is per assignment ({@link beginReadTelemetry}) and per session; nothing leaves the process except through the records.
 */

/** Tool calls after a compaction that form its window. */
export const POST_COMPACTION_WINDOW = 30;

export interface CompactionReadWindow {
  /** 1-based index of the compaction in the assignment. */
  compaction: number;
  /** Tool calls seen in the window (at most {@link POST_COMPACTION_WINDOW}). */
  calls: number;
  reads: number;
  /** Reads of a path read before this compaction, and their characters. */
  repeats: number;
  repeatChars: number;
}

export interface ReadTelemetry {
  reads: number;
  readChars: number;
  /** Reads of a path this assignment read before, and their characters. */
  repeats: number;
  repeatChars: number;
  /** Distinct paths read. */
  paths: number;
  /** One window per compaction of the assignment. */
  afterCompaction: CompactionReadWindow[];
}

interface State {
  seen: Set<string>;
  reads: number;
  readChars: number;
  repeats: number;
  repeatChars: number;
  windows: CompactionReadWindow[];
  /** Paths read before the latest compaction. */
  beforeCompaction?: Set<string>;
}
const states = new WeakMap<object, State>();
const fresh = (): State => ({ seen: new Set(), reads: 0, readChars: 0, repeats: 0, repeatChars: 0, windows: [] });

/** An assignment start: forget the previous assignment's reads. */
export function beginReadTelemetry(session: object): void {
  states.set(session, fresh());
}

/** A successful compaction of the session: a new window starts. */
export function markCompaction(session: object): void {
  let state = states.get(session);
  if (!state) states.set(session, state = fresh());
  state.beforeCompaction = new Set(state.seen);
  state.windows.push({ compaction: state.windows.length + 1, calls: 0, reads: 0, repeats: 0, repeatChars: 0 });
}

const textChars = (content: unknown): number => Array.isArray(content)
  ? content.reduce((sum: number, part) => sum + (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text.length : 0), 0)
  : 0;

/** One tool result of the session (every tool: the post-compaction window counts calls). */
export function recordToolResult(session: object, event: { toolName: string; input?: Record<string, unknown>; isError: boolean; content: unknown }): void {
  let state = states.get(session);
  if (!state) states.set(session, state = fresh());
  const window = state.windows.at(-1);
  const open = window && window.calls < POST_COMPACTION_WINDOW ? window : undefined;
  if (open) open.calls++;
  const path = event.toolName === "read" && !event.isError && typeof event.input?.path === "string" ? event.input.path : undefined;
  if (path === undefined) return;
  const chars = textChars(event.content);
  state.reads++;
  state.readChars += chars;
  if (state.seen.has(path)) { state.repeats++; state.repeatChars += chars; }
  state.seen.add(path);
  if (open) {
    open.reads++;
    if (state.beforeCompaction?.has(path)) { open.repeats++; open.repeatChars += chars; }
  }
}

/** The assignment's read telemetry (undefined: nothing recorded). */
export function readTelemetry(session: object): ReadTelemetry | undefined {
  const state = states.get(session);
  if (!state || (!state.reads && !state.windows.length)) return undefined;
  return { reads: state.reads, readChars: state.readChars, repeats: state.repeats, repeatChars: state.repeatChars, paths: state.seen.size, afterCompaction: state.windows.map(window => ({ ...window })) };
}
