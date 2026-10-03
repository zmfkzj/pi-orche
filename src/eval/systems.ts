export const compareSystems = ['pi-solo', 'pi-orche', 'omp', 'pi-orche-direct'] as const;
export type CompareSystem = typeof compareSystems[number];
export type SavedCompareSystem = CompareSystem | 'pi';
export const defaultSystems: readonly CompareSystem[] = ['pi-solo', 'pi-orche', 'omp'];
export const benchmarkModel = 'openai-codex/gpt-6.1-sol';
export function normalizeSystem(value: string): CompareSystem {
  if (value === 'pi') return 'pi-orche-direct';
  if (!(compareSystems as readonly string[]).includes(value)) throw new Error(`Unknown system ${value}; expected ${compareSystems.join(',')} (pi aliases pi-orche-direct)`);
  return value as CompareSystem;
}
export function parseSystems(values: readonly string[] = defaultSystems): CompareSystem[] {
  const systems = values.map(normalizeSystem);
  if (!systems.length || new Set(systems).size !== systems.length) throw new Error('systems must be nonempty and unique');
  return systems;
}
export interface ComparisonJob { taskId: string; system: CompareSystem; repeat: number; force: boolean }
export function scheduleComparison(tasks: readonly string[], systems: readonly CompareSystem[], repeats: number): ComparisonJob[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('repeats must be a positive integer');
  const jobs: ComparisonJob[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const [index, taskId] of tasks.entries()) for (let offset = 0; offset < systems.length; offset++) {
    jobs.push({ taskId, system: systems[(index + repeat - 1 + offset) % systems.length]!, repeat, force: false });
  }
  return jobs;
}
/** A failed terminal record is completed too: resume never silently replaces failures. */
export function hasCompletedRepeat(runs: readonly { taskId: string; system: SavedCompareSystem; repeat?: number; attempt?: number }[], job: ComparisonJob): boolean {
  return runs.some(run => run.taskId === job.taskId && normalizeSystem(run.system) === job.system && (run.repeat ?? run.attempt ?? 1) === job.repeat);
}
