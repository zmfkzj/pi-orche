/**
 * Completion wait: a per-invocation opt-in that removes orche's own wall-clock and inactivity cut-offs for one Pi process.
 *
 * `pi --orche-completion-wait unbounded …` (a CLI flag the extension registers; nothing in orche.config.json can set it, so no
 * other session, user or project default changes) makes every orche_task assignment of THAT process, its orche_spawn sub-workers
 * and its plan advisor wait for their result instead of a deadline:
 * - no assignment deadline, no extension budget, no idle refusal and no stall stop (the observer still reports liveness and
 *   recorded progress, it never ends the wait);
 * - no startup cap on creating a worker session;
 * - no wall-clock cap on the advisor session (its turn cap stays);
 * - no idle-expiry retirement of a worker between assignments (workers live until the session ends or /orche stop).
 * What still ends the work: a result, a real failure (model or tool error, the advisor's turn cap, an MDSD cost budget, a process
 * exit), cancellation (Esc, /orche stop, the caller's abort signal, session shutdown). Limits that are not wall-clock or inactivity
 * based (the advisor's turn cap, MDSD cost and token budgets, output-limit recovery) are unchanged; request counts are only progress
 * checkpoints and never end anything.
 *
 * Without the flag (every other session) nothing changes: the finite, activity-aware deadlines of limits.ts apply.
 *
 * The waits are re-armed in {@link UNBOUNDED_WAIT_SEGMENT_MS} segments: a segment that passes is not a result and not a stop, it
 * only re-arms the wait (a JS timer cannot be infinite: Node fires a delay above 2^31-1 ms after 1 ms).
 */

/** The CLI flag (`--orche-completion-wait unbounded`). */
export const COMPLETION_WAIT_FLAG = "orche-completion-wait";
/** `deadline`: the finite defaults (no flag). `unbounded`: wait for the result. */
export type CompletionWait = "deadline" | "unbounded";
/** The only accepted flag value. */
export const COMPLETION_WAIT_UNBOUNDED = "unbounded";
/** Re-arm period of an unbounded wait (not a deadline: a segment that passes keeps waiting). */
export const UNBOUNDED_WAIT_SEGMENT_MS = 5 * 60_000;

export class CompletionWaitFlagError extends Error {
  override readonly name = "CompletionWaitFlagError";
}

/**
 * The flag value as Pi hands it to the extension (`pi.getFlag`): absent → `deadline`; `unbounded` → `unbounded`; anything else is
 * refused (an unknown value must not silently fall back to finite deadlines that the caller believes are gone).
 */
export function parseCompletionWait(value: unknown): CompletionWait {
  if (value === undefined || value === false) return "deadline";
  if (value === COMPLETION_WAIT_UNBOUNDED) return "unbounded";
  throw new CompletionWaitFlagError(`--${COMPLETION_WAIT_FLAG}: expected "${COMPLETION_WAIT_UNBOUNDED}" (got ${JSON.stringify(value)}); without the flag the finite deadlines apply`);
}

/** The line every result of an unbounded assignment carries (evidence for the caller). */
export const COMPLETION_WAIT_LINE = `Completion wait: unbounded (--${COMPLETION_WAIT_FLAG} ${COMPLETION_WAIT_UNBOUNDED}): no assignment deadline, extension budget, idle or stall stop; only a result, a real failure or cancellation ends it`;
