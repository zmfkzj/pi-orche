/**
 * The thinking level of one orche worker session, owned in one place (docs/thinking-policy.md).
 *
 * Pi reads the session's level again for every model request (pi-agent-core agent-loop, `prepareNextTurn`), and a level set while a
 * response streams applies to the NEXT request only: nothing here can change the effort inside one response.
 *
 * Three things set the level, and all go through this module so they cannot undo each other:
 * - the assignment start fixes the baseline B (the route/config/main level after Pi's clamp to the model) and its step level S, the
 *   highest level the model supports whose EFFECTIVE effort is below B's (never `off`; S = B when there is none; src/pi/effort-mapping.ts:
 *   a level a proxy sends as the same effort as B, like CLIProxyAPI's xhigh → max for Claude, is not a step down). S is computed once
 *   from B, never from the current level, so it cannot drift lower step after step;
 * - the phase policy (src/pi/thinking-policy.ts) switches between B and S at Task DAG boundaries;
 * - the legacy output-limit recovery (src/pi/length-recovery.ts) may lower the CURRENT level by one supported level for its last
 *   attempt (`override`), cleared at the next delivered output, the next phase switch or the next assignment.
 *
 * Fixes two defects of the first output-limit recovery (test/pi/thinking-state.test.ts reproduces both): its step-down took the next
 * name of a fixed list (max → xhigh) and Pi clamped a level the model lacks back UP (xhigh → max), so nothing was lowered; and the
 * level it saved for the restore was re-applied at the next assignment start, over that assignment's own level.
 */

import { effectiveRank, effortMappingFor, type EffortAliasRule, type EffortMapping, type EffortModel } from "./effort-mapping.js";
import { THINKING_LEVELS } from "./thinking-levels.js";

export { THINKING_LEVELS, type ThinkingLevelName } from "./thinking-levels.js";

/** What this module needs of a Pi AgentSession (tests pass doubles). */
export interface ThinkingSession {
  readonly thinkingLevel?: string;
  setThinkingLevel(level: never): void;
  getAvailableThinkingLevels?(): string[];
  /** The session's model (its `thinkingLevelMap` and api decide which levels are one effective effort). */
  readonly model?: EffortModel;
}

/**
 * The highest level in `available` whose effective effort is strictly below `level`'s, never `off`; undefined when there is none (or
 * `level` is unknown). `names`: the effective level of each name ({@link effortMappingFor}); without it every name is its own level.
 */
export function stepDownLevel(available: readonly string[], level: string, names?: Readonly<Record<string, string>>): string | undefined {
  const index = (THINKING_LEVELS as readonly string[]).indexOf(level);
  const rank = effectiveRank(level, names);
  for (let i = index - 1; i >= 1; i--) {
    const candidate = THINKING_LEVELS[i]!;
    if (available.includes(candidate) && effectiveRank(candidate, names) < rank) return candidate;
  }
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
  /** S: the highest supported level whose effective effort is below B's (B when there is none), computed once per assignment. */
  step?: string;
  /** `thinkingPolicy.effortAliases` of the assignment (kept until the next assignment that passes them). */
  effortRules?: readonly EffortAliasRule[];
  /** The effective level of each name for the session's model, computed with B and S (records; src/pi/effort-mapping.ts). */
  effort?: EffortMapping;
  /** Which of the two the phase policy wants now. */
  phase: "baseline" | "step";
  /** A one-off lower level of the legacy output-limit recovery, above the phase level until cleared. */
  override?: string;
  /** The level this module last set, to tell a change made elsewhere (e.g. the owner's new level) from its own. */
  applied?: string;
  /** The level the latest model request ran at (noted when its response starts; {@link noteRequestLevel}). */
  requestLevel?: string;
  /** Model requests of this assignment so far (1 for the first); the request a tool call or task_plan call belongs to. */
  requestSeq: number;
  /** This assignment's level changes (records, result details). */
  switches: ThinkingSwitch[];
  /** Called for every switch (records); must not throw. */
  onSwitch?: (change: ThinkingSwitch) => void;
}

const states = new WeakMap<object, ThinkingState>();

export function thinkingStateOf(session: object): ThinkingState {
  let state = states.get(session);
  if (!state) states.set(session, state = { phase: "baseline", switches: [], requestSeq: 0 });
  return state;
}

const available = (session: ThinkingSession): string[] => {
  try { return session.getAvailableThinkingLevels?.() ?? [...THINKING_LEVELS]; } catch { return [...THINKING_LEVELS]; }
};

/** The level the state asks for now. */
export function wantedLevel(state: ThinkingState): string | undefined {
  return state.override ?? (state.phase === "step" ? state.step : state.baseline);
}

/** The effective level of each name for `session`'s model under the assignment's alias rules. */
function mappingOf(session: ThinkingSession, state: ThinkingState): EffortMapping {
  let model: EffortModel | undefined;
  try { model = session.model; } catch { model = undefined; }
  return effortMappingFor(model, state.effortRules);
}

/**
 * Whether `level` runs at the assignment's baseline effort: its effective effort is not below B's (so `xhigh` counts as B = `max`
 * where the proxy sends both as `max`). True when B is unknown (no assignment start: nothing is below it).
 */
export function atEffectiveBaseline(state: ThinkingState, level: string | undefined): boolean {
  if (state.baseline === undefined) return true;
  if (level === undefined) return false;
  return effectiveRank(level, state.effort?.names) >= effectiveRank(state.baseline, state.effort?.names);
}

/** Whether S runs at a lower effective effort than B (false: the phase policy degenerates to B throughout). */
export function hasLowerStep(state: ThinkingState): boolean {
  return state.step !== undefined && !atEffectiveBaseline(state, state.step);
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
 * `effortRules`: the assignment's `thinkingPolicy.effortAliases` (omitted: the previous ones stay).
 */
export function beginThinking(session: ThinkingSession, baseline?: string, effortRules?: readonly EffortAliasRule[]): ThinkingState {
  const state = thinkingStateOf(session);
  const current = session.thinkingLevel ?? "off";
  const wanted = baseline ?? (state.applied !== undefined && current !== state.applied ? current : state.baseline ?? current);
  if (effortRules !== undefined) state.effortRules = effortRules;
  state.override = undefined;
  state.phase = "baseline";
  state.switches = [];
  state.requestLevel = undefined;
  state.requestSeq = 0;
  apply(session, state, wanted, "assignment start");
  state.baseline = session.thinkingLevel ?? wanted;
  state.effort = mappingOf(session, state);
  state.step = stepDownLevel(available(session), state.baseline, state.effort.names) ?? state.baseline;
  state.applied = session.thinkingLevel ?? state.baseline;
  return state;
}

/**
 * Note the level of the model request whose response is starting. Pi reads the session's level when it prepares a request and
 * nothing here changes it while a response streams (tools run after it), so the level at the response start is the request's.
 */
export function noteRequestLevel(session: ThinkingSession): void {
  const state = thinkingStateOf(session);
  state.requestLevel = session.thinkingLevel ?? "off";
  state.requestSeq++;
}

/** Ensure B and S exist (a session used without an explicit assignment start). */
function ensure(session: ThinkingSession): ThinkingState {
  const state = thinkingStateOf(session);
  if (state.baseline === undefined) {
    state.baseline = session.thinkingLevel ?? "off";
    state.effort = mappingOf(session, state);
    state.step = stepDownLevel(available(session), state.baseline, state.effort.names) ?? state.baseline;
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
 * The legacy recovery's step-down: one supported level whose effective effort is below the CURRENT level's (the phase level), for
 * the next request only. False when the model has no lower level (above `off`).
 */
export function lowerThinkingForRecovery(session: ThinkingSession): boolean {
  const state = ensure(session);
  const current = session.thinkingLevel ?? "off";
  const lower = stepDownLevel(available(session), current, (state.effort ?? mappingOf(session, state)).names);
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
