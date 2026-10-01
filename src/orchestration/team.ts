/**
 * Worker team shape: how many workers the coordinator may choose, which route roles diagnose
 * explorers use, and which angles read-only analysts take. Configured under `workers` in
 * orche.config.json; the defaults reproduce the original fixed three-worker design.
 */
export interface TeamSettings {
  /** Upper bound for the coordinator's workerCount (1..MAX_WORKERS_LIMIT). */
  readonly maxWorkers: number;
  /** Route roles of diagnose_fix explorers, in order; reused cyclically beyond its length. */
  readonly explorerRoles: readonly string[];
  /** Investigation angles of answer analysts, in order; reused cyclically beyond its length. */
  readonly answerAngles: readonly string[];
}
export const MAX_WORKERS_LIMIT = 8;
export const defaultTeam: TeamSettings = {
  maxWorkers: 3,
  explorerRoles: ["explorer-path", "explorer-cause", "explorer-repro"],
  answerAngles: [
    "Explain the relevant code and substantiate the requested answer",
    "Review boundary cases and contracts independently",
    "Check conclusions and identify review findings",
  ],
};
export function resolveTeam(settings: Partial<TeamSettings> = {}): TeamSettings {
  return { ...defaultTeam, ...settings };
}
/** The item for worker `index`, cycling when there are more workers than entries. */
export function cycled<T>(items: readonly T[], index: number): T {
  return items[index % items.length]!;
}
/** Route roles for `count` explorers: the configured roles, cycled. */
export function explorerRolesFor(team: TeamSettings, count: number): string[] {
  return Array.from({ length: count }, (_, index) => cycled(team.explorerRoles, index));
}
