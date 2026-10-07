/**
 * The thinking level of one orche worker session, owned in one place (docs/thinking-policy.md).
 *
 * Pi reads the session's level again for every model request (pi-agent-core agent-loop, `prepareNextTurn`), and a level set while a
 * response streams applies to the NEXT request only: nothing here can change the effort inside one response.
 *
 * Three things set the level, and all go through this module so they cannot undo each other:
 * - the assignment start fixes the baseline B (the route/config/main level after Pi's clamp to the model) and its step level S, the
 *   highest level the model supports below B (never `off`; S = B when there is none). S is computed once from B, never from the
 *   current level, so it cannot drift lower step after step;
 * - the phase policy (src/pi/thinking-policy.ts) switches between B and S at Task DAG boundaries;
 * - the legacy output-limit recovery (src/pi/length-recovery.ts) may lower the CURRENT level by one supported level for its last
 *   attempt (`override`), cleared at the next delivered output, the next phase switch or the next assignment.
 *
 * Fixes two defects of the first output-limit recovery (test/pi/thinking-state.test.ts reproduces both): its step-down took the next
 * name of a fixed list (max → xhigh) and Pi clamped a level the model lacks back UP (xhigh → max), so nothing was lowered; and the
 * level it saved for the restore was re-applied at the next assignment start, over that assignment's own level.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = typeof THINKING_LEVELS[number];

/** What this module needs of a Pi AgentSession (tests pass doubles). */
export interface ThinkingSession {
  readonly thinkingLevel?: string;
  setThinkingLevel(level: never): void;
  getAvailableThinkingLevels?(): string[];
}

/** The highest level in `available` strictly below `level`, never `off`; undefined when there is none (or `level` is unknown). */
export function stepDownLevel(available: readonly string[], level: string): string | undefined {
  const index = (THINKING_LEVELS as readonly string[]).indexOf(level);
  for (let i = index - 1; i >= 1; i--) if (available.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i];
  return undefined;
}

export interface ThinkingSwitch {
  timestamp: number;
  from: string;
  to: string;
  /** Why: "assignment start", "step node N3", "integration node N9", "length recovery", ... */
  reason: string;
  node?: string;
}

export interface ThinkingState {
  /** B: the level this assignment was given, as the model runs it (after Pi's clamp). */
  baseline?: string;
  /** S: the highest supported level below B (B when there is none), computed once per assignment. */
  step?: string;
  /** Which of the two the phase policy wants now. */
  phase: "baseline" | "step";
  /** A one-off lower level of the legacy output-limit recovery, above the phase level until cleared. */
  override?: string;
  /** The level this module last set, to tell a change made elsewhere (e.g. the owner's new level) from its own. */
  applied?: string;
  /** The level the latest model request ran at (noted when its response starts; {@link noteRequestLevel}). */
  requestLevel?: string;
  /** This assignment's level changes (records, result details). */
  switches: ThinkingSwitch[];
  /** Called for every switch (records); must not throw. */
  onSwitch?: (change: ThinkingSwitch) => void;
}

const states = new WeakMap<object, ThinkingState>();

export function thinkingStateOf(session: object): ThinkingState {
  let state = states.get(session);
  if (!state) states.set(session, state = { phase: "baseline", switches: [] });
  return state;
}

const available = (session: ThinkingSession): string[] => {
  try { return session.getAvailableThinkingLevels?.() ?? [...THINKING_LEVELS]; } catch { return [...THINKING_LEVELS]; }
};

/** The level the state asks for now. */
export function wantedLevel(state: ThinkingState): string | undefined {
  return state.override ?? (state.phase === "step" ? state.step : state.baseline);
}

function apply(session: ThinkingSession, state: ThinkingState, level: string | undefined, reason: string, node?: string): void {
  if (level === undefined) return;
  const from = session.thinkingLevel ?? "off";
  if (from !== level) {
    try { session.setThinkingLevel(level as never); } catch { /* the level stays; recorded below as it is */ }
  }
  const to = session.thinkingLevel ?? level;
  state.applied = to;
  if (to !== from) {
    const change: ThinkingSwitch = { timestamp: Date.now(), from, to, reason, ...(node ? { node } : {}) };
    state.switches.push(change);
    if (state.switches.length > 200) state.switches.splice(0, state.switches.length - 200);
    try { state.onSwitch?.(change); } catch { /* observers cannot change the level */ }
  }
}

/**
 * Start an assignment: fix B and S and run at B. `baseline` is the assignment's level when its owner knows it (Pi clamps it to the
 * model). Without it: a level set on the session by someone else since this module last set one is the new B (an owner that changed
 * the level directly); otherwise the previous B stays (a recovery or phase level of the previous assignment never becomes B).
 */
export function beginThinking(session: ThinkingSession, baseline?: string): ThinkingState {
  const state = thinkingStateOf(session);
  const current = session.thinkingLevel ?? "off";
  const wanted = baseline ?? (state.applied !== undefined && current !== state.applied ? current : state.baseline ?? current);
  state.override = undefined;
  state.phase = "baseline";
  state.switches = [];
  state.requestLevel = undefined;
  apply(session, state, wanted, "assignment start");
  state.baseline = session.thinkingLevel ?? wanted;
  state.step = stepDownLevel(available(session), state.baseline) ?? state.baseline;
  state.applied = session.thinkingLevel ?? state.baseline;
  return state;
}

/**
 * Note the level of the model request whose response is starting. Pi reads the session's level when it prepares a request and
 * nothing here changes it while a response streams (tools run after it), so the level at the response start is the request's.
 */
export function noteRequestLevel(session: ThinkingSession): void {
  thinkingStateOf(session).requestLevel = session.thinkingLevel ?? "off";
}

/** Ensure B and S exist (a session used without an explicit assignment start). */
function ensure(session: ThinkingSession): ThinkingState {
  const state = thinkingStateOf(session);
  if (state.baseline === undefined) {
    state.baseline = session.thinkingLevel ?? "off";
    state.step = stepDownLevel(available(session), state.baseline) ?? state.baseline;
    state.applied = state.baseline;
  }
  return state;
}

/** Switch to the phase level (B or S); clears a recovery override. No-op when already there. */
export function setThinkingPhase(session: ThinkingSession, phase: "baseline" | "step", reason: string, node?: string): ThinkingState {
  const state = ensure(session);
  state.phase = phase;
  state.override = undefined;
  apply(session, state, wantedLevel(state), reason, node);
  return state;
}

/**
 * The legacy recovery's step-down: one supported level below the CURRENT level (the phase level), for the next request only.
 * False when the model has no lower level (above `off`).
 */
export function lowerThinkingForRecovery(session: ThinkingSession): boolean {
  const state = ensure(session);
  const current = session.thinkingLevel ?? "off";
  const lower = stepDownLevel(available(session), current);
  if (!lower) return false;
  state.override = lower;
  apply(session, state, lower, "length recovery");
  return session.thinkingLevel === lower;
}

/** Back to the phase level after the recovery delivered output. */
export function clearThinkingOverride(session: ThinkingSession): void {
  const state = thinkingStateOf(session);
  if (state.override === undefined) return;
  state.override = undefined;
  apply(session, state, wantedLevel(state), "output delivered");
}
