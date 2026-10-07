/**
 * How the TUI draws an orche_run / orche_task tool block: a header with a live elapsed timer, and the progress / report lines below it.
 *
 *   orche_run Fix the login redirect
 *   ⏱ 12m 34s / 30m · ext 1/10            (while it runs: elapsed / current cap · extensions used / allowed)
 *   phase EXECUTE
 *   W1 implement · 14 requests · last tool: edit
 *
 *   orche_run Fix the login redirect
 *   took 41m 07s · ext 1/10               (when it is over: success, failure or cancellation alike)
 *   orche finished (change, 2467s, 213 model requests; …)
 *   …
 *
 * The timer is UI-only: every number comes from `details` (`startedAt`, `finishedAt`, `deadline`, `durationMs`, `extensions`, `progress`; see
 * progress.ts and the producers in controller.ts / workers.ts) and nothing of it is ever put into the `content` the model reads. A finished block
 * is drawn from the details alone, so a re-render or a reloaded session shows the same duration; the wall clock is used only for the running
 * block and, as a last resort, for a result without any timing details (an error thrown before a run existed) that was watched live.
 *
 * Lifecycle (pi has no dispose hook for tool blocks): the render context's `state` is shared by `renderCall` and `renderResult` of one tool call and
 * holds the one interval that calls `context.invalidate()` every {@link TICK_MS}. It starts at most once per call (re-renders find it running), is
 * cleared as soon as a final result is rendered, by `dispose()` of the component (if the host ever calls it), and by itself when nothing has drawn
 * the block for {@link STALE_RENDER_MS} (the block left the screen tree: a new session, `/clear`); it is `unref`ed so it never keeps a process alive.
 *
 * This module imports no TUI package: the components are plain `{ render(width), invalidate() }` objects whose lines are measured and wrapped here.
 */
import { keyText, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../agent/liveness.js";
import type { DeadlineInfo } from "./progress.js";
import { formatModelUse } from "../orchestration/model-use.js";

type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
/** What pi passes to `renderCall` / `renderResult` (`ToolRenderContext`). */
export type OrcheRenderContext = Parameters<CallRenderer>[2];
type Component = ReturnType<CallRenderer>;

/** The timer repaints this often while the call runs, with or without progress events. */
export const TICK_MS = 1000;
/** A running timer stops by itself when no component of its block has been drawn for this long (the block is gone); the next update restarts it. */
export const STALE_RENDER_MS = 15_000;
/** Lines of progress / report text shown while the block is collapsed. */
export const COLLAPSED_LINES = 10;
/** Lines of the request / context shown per argument when the block is expanded. */
const EXPANDED_ARG_LINES = 40;

/** What the renderer has learned from `details` so far (the newest value of each key wins). */
interface Observed {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  deadline?: DeadlineInfo;
  /** Extensions used / allowed, from `details.extensions` or a `⏱ timeout extended n/max` progress line, for details without `deadline`. */
  extensionsUsed?: number;
  extensionsMax?: number;
  progress?: readonly string[];
  /** A background job's attach state (`details.attach`: attached | detached | pending | already-ended | ended), its id and why it detached. */
  attach?: string;
  job?: string;
  reason?: string;
  detachedAt?: number;
}

/** The `context.state` of one tool call, shared by its `renderCall` and `renderResult`. */
export interface OrcheRenderState {
  observed?: Observed;
  /** When this renderer first saw the call executing / finished: the fallback clock for results without timing details. */
  seenStartedAt?: number;
  seenEndedAt?: number;
  /** A final result has been rendered: nothing ticks any more. */
  final?: boolean;
  timer?: ReturnType<typeof setInterval>;
  /** The newest `context.invalidate`. */
  invalidate?: () => void;
  /** When a component of this block was last drawn. */
  lastRenderAt?: number;
  /** The newest component of each kind (a `dispose()` of an older, replaced one must not stop the timer). */
  call?: object;
  result?: object;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// ---- time formatting ----

/** `45s`, `12m 34s`, `41m 07s`, `1h 05m 07s`: whole seconds, zero-padded below the leading unit. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${total}s`;
}

// ---- reading `details` ----

const EXTENDED_LINE = /^⏱ timeout extended (\d+)\/(\d+)\b/;

function deadlineOf(value: unknown): DeadlineInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { baseMs, capMs, deadlineAt, extensionMs, extensionsUsed, maxExtensions, hardLimitMs } = value;
  if (!finite(capMs) || !finite(extensionsUsed) || !finite(maxExtensions)) return undefined;
  return {
    baseMs: finite(baseMs) ? baseMs : capMs, capMs, deadlineAt: finite(deadlineAt) ? deadlineAt : 0, extensionMs: finite(extensionMs) ? extensionMs : 0,
    extensionsUsed, maxExtensions, hardLimitMs: finite(hardLimitMs) ? hardLimitMs : capMs,
  };
}

/** Fold the `details` of a partial update or of the final result into `state.observed`; keys the details lack keep their earlier value. */
function observe(state: OrcheRenderState, details: unknown): void {
  const seen: Observed = (state.observed ??= {});
  if (!isRecord(details)) return;
  if (finite(details.startedAt)) seen.startedAt = details.startedAt;
  if (finite(details.finishedAt)) seen.finishedAt = details.finishedAt;
  if (finite(details.durationMs)) seen.durationMs = details.durationMs;
  if (typeof details.attach === "string") seen.attach = details.attach;
  if (typeof details.job === "string") seen.job = details.job;
  if (typeof details.reason === "string") seen.reason = details.reason;
  if (finite(details.detachedAt)) seen.detachedAt = details.detachedAt;
  const deadline = deadlineOf(details.deadline);
  if (deadline) seen.deadline = deadline;
  if (Array.isArray(details.progress)) {
    seen.progress = details.progress.filter((line): line is string => typeof line === "string");
    for (const line of seen.progress) {
      const match = EXTENDED_LINE.exec(line);
      if (match) { seen.extensionsUsed = Number(match[1]); seen.extensionsMax = Number(match[2]); }
    }
  }
  if (Array.isArray(details.extensions) && details.extensions.length) {
    const first: unknown = details.extensions[0];
    seen.extensionsUsed = details.extensions.length;
    if (isRecord(first) && finite(first.max)) seen.extensionsMax = first.max;
  }
}

/** Extensions used / allowed as far as the details say; the `deadline` is the authority. */
function extensionsOf(seen: Observed | undefined): { used: number; max: number } | undefined {
  if (seen?.deadline) return { used: seen.deadline.extensionsUsed, max: seen.deadline.maxExtensions };
  if (seen?.extensionsMax !== undefined) return { used: seen.extensionsUsed ?? 0, max: seen.extensionsMax };
  return undefined;
}

/** The duration of a finished call: from the details (`finishedAt - startedAt`, else `durationMs`), only then from what this renderer watched. */
function finalElapsed(state: OrcheRenderState): number | undefined {
  const seen = state.observed;
  if (seen?.startedAt !== undefined && seen.finishedAt !== undefined) return Math.max(0, seen.finishedAt - seen.startedAt);
  if (seen?.durationMs !== undefined) return Math.max(0, seen.durationMs);
  if (state.seenStartedAt !== undefined && state.seenEndedAt !== undefined) return Math.max(0, state.seenEndedAt - state.seenStartedAt);
  return undefined;
}

// ---- the timer ----

function stopTimer(state: OrcheRenderState): void {
  if (state.timer !== undefined) clearInterval(state.timer);
  state.timer = undefined;
}

function tick(state: OrcheRenderState): void {
  if (state.final || Date.now() - (state.lastRenderAt ?? 0) > STALE_RENDER_MS) { stopTimer(state); return; }
  state.invalidate?.();
}

/**
 * Called by every render: follows the call's lifecycle. A running call (execution started, no final result) gets exactly one interval; a final
 * result clears it for good.
 */
function sync(state: OrcheRenderState, context: OrcheRenderContext, final: boolean, persistent: boolean): void {
  const now = Date.now();
  state.invalidate = context.invalidate;
  state.lastRenderAt ??= now;
  if (context.executionStarted && state.seenStartedAt === undefined) state.seenStartedAt = now;
  if (final) {
    state.final = true;
    state.seenEndedAt ??= now;
    stopTimer(state);
    return;
  }
  // A host that gives no persistent state could never tell this renderer to stop: no timer then.
  if (!persistent || state.final || state.timer !== undefined) return;
  if (!context.executionStarted && state.observed?.startedAt === undefined) return;
  state.lastRenderAt = now;
  const timer = setInterval(() => tick(state), TICK_MS);
  timer.unref?.();
  state.timer = timer;
}

// ---- measuring and wrapping plain text (no TUI package here) ----

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
/** Text made safe for a terminal line: no escape sequences or control characters (tabs become spaces). */
function clean(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "").replace(/\t/g, "   ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Terminal columns of one character: 0 for combining marks and joiners, 2 for East Asian wide characters and emoji. */
function charWidth(char: string): number {
  const code = char.codePointAt(0)!;
  if (code < 0x300) return 1;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe00 && code <= 0xfe0f) || code === 0x2060 || code === 0xfeff) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff) || (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

/** `text` cut to `max` columns, with an ellipsis when something was cut. */
function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (cellWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const width = charWidth(char);
    if (used + width > max - 1) break;
    out += char;
    used += width;
  }
  return `${out}…`;
}

/** `text` (one logical line) broken into lines of at most `width` columns: at spaces where it can, inside a word when it must. Leading indentation of the first line is kept. */
function wrap(text: string, width: number): string[] {
  const max = Math.max(1, width);
  if (cellWidth(text) <= max) return [text];
  const out: string[] = [];
  let line = "";
  let used = 0;
  const flush = () => { out.push(line.trimEnd()); line = ""; used = 0; };
  for (const token of text.match(/\s+|\S+/g) ?? []) {
    const size = cellWidth(token);
    if (/^\s/.test(token)) {
      if (used === 0 && out.length > 0) continue;
      if (used + size > max) { if (used > 0) flush(); continue; }
      line += token;
      used += size;
    } else if (used + size <= max) {
      line += token;
      used += size;
    } else {
      if (used > 0) flush();
      for (const char of token) {
        const w = charWidth(char);
        if (used + w > max) flush();
        line += char;
        used += w;
      }
    }
  }
  if (line.trim()) flush();
  return out.length ? out : [""];
}

const wrapAll = (lines: readonly string[], width: number): string[] => lines.flatMap(line => wrap(line, width));

/** The first line of `text`, whitespace collapsed. */
const oneLine = (text: string): string => clean(text).replace(/\s+/g, " ").trim();

/** `text` as the lines of an argument block: wrapped under `label`, continuation lines indented. */
function argLines(label: string, text: string, width: number): string[] {
  const all = clean(text).split("\n");
  const shown = all.slice(0, EXPANDED_ARG_LINES);
  const lines = wrapAll(shown.map((line, index) => `${index === 0 ? `  ${label}: ` : "    "}${line}`), width);
  if (all.length > shown.length) lines.push(`    … ${all.length - shown.length} more lines`);
  return lines;
}

// ---- components ----

/** A block of lines built at draw time from the current state: re-drawing it after the state changed shows the change without re-rendering. */
class Block {
  constructor(private readonly state: OrcheRenderState, private readonly kind: "call" | "result", private readonly build: (width: number) => string[]) {
    state[kind] = this;
  }
  render(width: number): string[] {
    this.state.lastRenderAt = Date.now();
    return this.build(Math.max(1, width));
  }
  invalidate(): void {}
  /** A host that disposes the block it removed stops the timer; one that disposes a block this renderer has since replaced does not. */
  dispose(): void {
    if (this.state[this.kind] === this) stopTimer(this.state);
  }
}

function timerLine(state: OrcheRenderState, theme: Theme, isError: boolean, width: number): string | undefined {
  const seen = state.observed;
  const ext = extensionsOf(seen);
  const showExt = ext !== undefined && ext.max > 0;
  const parts: Array<{ text: string; color: "accent" | "muted" | "warning" | "error" }> = [];
  if (state.final && (seen?.attach === "detached" || seen?.attach === "pending")) {
    // A background job this call stopped waiting for: it keeps running, so this is no duration of the task.
    const origin = seen.startedAt;
    const at = seen.detachedAt ?? state.seenEndedAt;
    const job = seen.job ?? "the job";
    parts.push({ text: seen.attach === "pending" ? "⇥ not attached" : `⇥ detached${origin !== undefined && at !== undefined ? ` after ${formatElapsed(Math.max(0, at - origin))}` : ""}`, color: "warning" });
    parts.push({ text: ` · ${job} keeps running in the background`, color: "muted" });
  } else if (state.final && seen?.attach === "already-ended") {
    parts.push({ text: `${seen.job ?? "the job"} had already ended`, color: "muted" });
  } else if (state.final) {
    const elapsed = finalElapsed(state);
    if (elapsed === undefined) return undefined;
    parts.push({ text: `took ${formatElapsed(elapsed)}`, color: isError ? "error" : "muted" });
    if (showExt && ext.used > 0) parts.push({ text: ` · ext ${ext.used}/${ext.max}`, color: "muted" });
  } else {
    const origin = seen?.startedAt ?? state.seenStartedAt;
    if (origin === undefined) return undefined;
    const elapsed = Math.max(0, Date.now() - origin);
    const cap = seen?.deadline?.capMs;
    parts.push({ text: `⏱ ${formatElapsed(elapsed)}`, color: "accent" });
    if (cap !== undefined) parts.push({ text: ` / ${formatDuration(cap)}`, color: cap > 0 && elapsed > cap ? "warning" : "muted" });
    if (showExt) parts.push({ text: ` · ext ${ext.used}/${ext.max}`, color: ext.used > 0 ? "warning" : "muted" });
    if (seen?.attach === "attached") parts.push({ text: ` · attached to ${seen.job ?? "the job"} (Esc or new input detaches)`, color: "muted" });
  }
  const plain = parts.map(part => part.text).join("");
  if (cellWidth(plain) > width) return theme.fg("muted", truncate(plain, width));
  return parts.map(part => theme.fg(part.color, part.text)).join("");
}

interface CallArgs { request?: unknown; context?: unknown; role?: unknown; worker?: unknown; files?: unknown; git?: unknown; job?: unknown }

function callLines(name: string, args: unknown, state: OrcheRenderState, theme: Theme, expanded: boolean, isError: boolean, width: number): string[] {
  const input: CallArgs = isRecord(args) ? args : {};
  const request = typeof input.request === "string" ? input.request : "";
  const role = typeof input.role === "string" ? input.role : "";
  const worker = typeof input.worker === "string" ? input.worker : "";
  const job = typeof input.job === "string" ? input.job : "";
  const subject = [job, role && (worker ? `${role} ${worker}` : role), oneLine(request)].filter(Boolean).join(" · ");
  const title = theme.bold(name);
  const room = width - cellWidth(name) - 1;
  const lines = [`${theme.fg("toolTitle", title)}${subject && room > 1 ? ` ${theme.fg("muted", truncate(subject, room))}` : ""}`];
  const timer = timerLine(state, theme, isError, width);
  if (timer) lines.push(timer);
  if (expanded) {
    const extra: string[] = [];
    if (request) extra.push(...argLines("request", request, width));
    if (typeof input.context === "string" && input.context) extra.push(...argLines("context", input.context, width));
    if (role || worker) extra.push(...wrapAll([`  ${[role && `role: ${role}`, worker && `worker: ${worker}`].filter(Boolean).join(" · ")}`], width));
    if (Array.isArray(input.files) && input.files.length) extra.push(...wrapAll([`  files: ${input.files.map(String).join(", ")}`], width));
    if (isRecord(input.git)) extra.push(...wrapAll([`  git: ${JSON.stringify(input.git)}`], width));
    lines.push(...extra.map(line => theme.fg("muted", line)));
  }
  return lines;
}

/** `ctrl+o to expand` as the host's own hint reads it (its key binding when the host initialised them). */
function expandHint(theme: Theme): string {
  let key = "ctrl+o";
  try { key = keyText("app.tools.expand") || key; } catch { /* key bindings not initialised: tests, non-interactive hosts */ }
  return `${theme.fg("dim", key)}${theme.fg("muted", " to expand")}`;
}

const textOf = (result: { content?: unknown }): string =>
  Array.isArray(result.content) ? result.content.flatMap(part => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";

/**
 * The `Model: …` line of a finished orche_task error result (a failed, timed-out or cancelled assignment: its text is the error message,
 * kept as it is for the model; a successful result has the line in its text) drawn from the details of the assignment that ran (see
 * model-use.ts). Nothing for an error without an assignment (thrown before any worker ran: no `worker` in the details) or for other tools.
 */
function missingModelLine(name: string, details: unknown): string | undefined {
  if ((name !== "orche_task" && name !== "orche_task_attach") || !isRecord(details) || typeof details.worker !== "string") return undefined;
  const answered = isRecord(details.models) ? Object.fromEntries(Object.entries(details.models).filter((entry): entry is [string, number] => finite(entry[1]))) : undefined;
  return `Model: ${formatModelUse({ model: typeof details.model === "string" ? details.model : undefined, thinking: typeof details.thinking === "string" ? details.thinking : undefined, answered })}`;
}

/**
 * The lines below the header. Running: the progress lines (newest last), collapsed to the newest {@link COLLAPSED_LINES}. Finished: the result text
 * the host would show without a renderer (its first {@link COLLAPSED_LINES} lines collapsed, all of them expanded), with the model line of
 * {@link missingModelLine} in an error result.
 */
/** The collapsed body of a call that detached from (or did not attach to) a background job: what happened, for the user; the model's text expanded. */
const DETACH_LABEL: Record<string, string> = {
  input: "new user input", followUp: "a queued follow-up", "session-bus": "a message from another Pi session", abort: "Esc",
  command: "/orche detach", background: "wait:false", shutdown: "session shutdown", replaced: "another attach",
};
function detachedLines(details: Record<string, unknown>, theme: Theme, width: number): string[] {
  const job = typeof details.job === "string" ? details.job : "the job";
  const reason = typeof details.reason === "string" ? DETACH_LABEL[details.reason] ?? details.reason : undefined;
  const text = details.attach === "pending"
    ? `${job} keeps running; not attached because input is waiting for main.`
    : details.attach === "already-ended"
      ? `${job} had already ended; its result was delivered once before.`
      : `${job} keeps running${reason ? ` (detached by ${reason})` : ""}; its result arrives as a message unless main attaches again.`;
  return [...wrapAll([text], width).map(line => theme.fg("toolOutput", line)), `${theme.fg("muted", "(")}${expandHint(theme)}${theme.fg("muted", " main's instructions)")}`];
}

function bodyLines(name: string, result: { content?: unknown; details?: unknown }, partial: boolean, isError: boolean, expanded: boolean, theme: Theme, width: number): string[] {
  if (!partial && !expanded && isRecord(result.details) && (result.details.attach === "detached" || result.details.attach === "pending" || result.details.attach === "already-ended")) return detachedLines(result.details, theme, width);
  const seen = isRecord(result.details) && Array.isArray(result.details.progress) ? result.details.progress.filter((line): line is string => typeof line === "string") : undefined;
  const source = partial && seen ? seen.map(clean) : clean(textOf(result)).split("\n");
  const logical = source.length === 1 && source[0] === "" ? [] : source;
  const modelLine = !partial && isError ? missingModelLine(name, result.details) : undefined;
  if (modelLine) {
    // Where a successful result has it: after the first line of the message (behind a leading concurrent-session warning and its blank
    // line) and the model warnings that follow it.
    let at = Math.min(logical[1] === "" && logical.length > 2 ? 3 : 1, logical.length);
    while (at < logical.length && logical[at]!.startsWith("Warning: ")) at++;
    logical.splice(at, 0, clean(modelLine));
  }
  if (!logical.length) return [];
  const hidden = expanded ? 0 : Math.max(0, logical.length - COLLAPSED_LINES);
  const shown = expanded ? logical : partial ? logical.slice(hidden) : logical.slice(0, COLLAPSED_LINES);
  const lines = wrapAll(shown, width).map(line => theme.fg("toolOutput", line));
  if (hidden > 0) {
    const note = partial ? `... (${hidden} earlier lines, ` : `... (${hidden} more lines, `;
    const hint = truncate(note, width);
    if (partial) lines.unshift(`${theme.fg("muted", hint)}${expandHint(theme)}${theme.fg("muted", ")")}`);
    else lines.push(`${theme.fg("muted", hint)}${expandHint(theme)}${theme.fg("muted", ")")}`);
  }
  return lines;
}

/** `renderCall` / `renderResult` of one tool (`name` is the title of the block). Register them with `pi.registerTool({ ..., ...createOrcheRenderers("orche_run") })`. */
export function createOrcheRenderers(name: string): { renderCall: CallRenderer; renderResult: ResultRenderer } {
  const stateOf = (context: OrcheRenderContext): OrcheRenderState | undefined => isRecord(context.state) ? context.state as OrcheRenderState : undefined;
  const renderCall: CallRenderer = (args, theme, context): Component => {
    const state = stateOf(context) ?? {};
    sync(state, context, !context.isPartial, stateOf(context) !== undefined);
    return new Block(state, "call", width => callLines(name, args, state, theme, context.expanded, context.isError, width));
  };
  const renderResult: ResultRenderer = (result, options, theme, context): Component => {
    const state = stateOf(context) ?? {};
    observe(state, result.details);
    sync(state, context, !options.isPartial, stateOf(context) !== undefined);
    return new Block(state, "result", width => bodyLines(name, result, options.isPartial, context.isError, options.expanded, theme, width));
  };
  return { renderCall, renderResult };
}

export const orcheRunRenderers = createOrcheRenderers("orche_run");
export const orcheTaskRenderers = createOrcheRenderers("orche_task");

/**
 * The `orche-task-result` message of a job that ended while detached: a status header (✓ done, ✗ failed, ⊘ cancelled, ! interrupted,
 * with the job, worker and duration), then the result text: its first {@link COLLAPSED_LINES} lines collapsed, all of it expanded.
 * Main reads the message content itself; this changes only what the TUI draws.
 */
export function renderJobResultMessage(message: { content: unknown; details?: unknown }, options: { expanded: boolean }, theme: Theme): Component {
  const details = isRecord(message.details) ? message.details : {};
  const raw = typeof message.content === "string" ? message.content : textOf({ content: message.content });
  const all = clean(raw).split("\n");
  if (/^\[orche task result ·/.test(all[0] ?? "")) all.shift();
  while (all.length && !all[0]!.trim()) all.shift();
  const status = typeof details.status === "string" ? details.status : "ended";
  const icon = ({ done: "✓", failed: "✗", cancelled: "⊘", interrupted: "!" } as Record<string, string>)[status] ?? "•";
  const color = status === "done" ? "success" : status === "cancelled" ? "warning" : "error";
  const took = finite(details.startedAt) && finite(details.finishedAt) ? ` after ${formatElapsed(details.finishedAt - details.startedAt)}` : "";
  const head = `${icon} orche task result · ${String(details.job ?? "?")} · ${String(details.worker ?? "?")} ${String(details.role ?? "")} · ${status}${took}`;
  return {
    render(width: number): string[] {
      const max = Math.max(1, width);
      const hidden = options.expanded ? 0 : Math.max(0, all.length - COLLAPSED_LINES);
      const shown = options.expanded ? all : all.slice(0, COLLAPSED_LINES);
      const lines = [theme.fg(color, theme.bold(truncate(head, max))), ...wrapAll(shown, max).map(line => theme.fg("toolOutput", line))];
      if (hidden > 0) lines.push(`${theme.fg("muted", truncate(`... (${hidden} more lines, `, max))}${expandHint(theme)}${theme.fg("muted", ")")}`);
      return lines;
    },
    invalidate() {},
  };
}
