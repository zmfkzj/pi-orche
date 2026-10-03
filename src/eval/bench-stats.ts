import { readFileSync } from 'node:fs';
import { normalizeSystem, defaultSystems } from './systems.js';
import type { CompareRun } from './compare.js';
import type { UsageTotals } from './omp-runner.js';
import { statistics } from './metrics.js';

export const pricing: { source: string; assumption: string; currency: string; unit: string; model: string; rates: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number> } = JSON.parse(readFileSync(new URL('./pricing.json', import.meta.url), 'utf8'));
export const oldTaskIds = new Set(['a1-rounding','a2-discount-codes','a3-refactor-tax','a4-tests-fx','a5-refund-explain-ko','a6-typo-message','a7-auth-rotation','b1-static-traversal','b2-patch-endpoint','b3-pagination','b4-router-review','b5-ctx-migration','b6-route-cache','b7-api-docs','c1-timezone','c2-since-flag-ko','c3-rootcause-report-ko','c4-malformed-lines','c5-aggregate-perf','c6-csv-export']);
export function estimateCost(tokens: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, rates = pricing.rates): number {
  return (tokens.input * rates.input + tokens.output * rates.output + tokens.cacheRead * rates.cacheRead + tokens.cacheWrite * rates.cacheWrite) / 1_000_000;
}
export function succeeded(run: CompareRun): boolean { return run.status === 'done' && run.grade?.passed === true && run.usage.validModelEffort; }
const mean = (values: readonly number[]) => values.length ? values.reduce((a,b) => a+b, 0) / values.length : null;
export function passPower(n: number, successes: number, k: number): number | null {
  if (![n, successes, k].every(Number.isInteger) || n < 0 || successes < 0 || successes > n || k < 1) throw new Error('Invalid pass^k counts');
  if (n < k) return null;
  let probability = 1;
  for (let i = 0; i < k; i++) probability *= Math.max(0, successes - i) / (n - i);
  return probability;
}
export function bootstrapCI(values: readonly number[], seed = 20261002, samples = 10_000) {
  if (!values.length) return { n: 0, mean: null, low: null, high: null };
  if (!Number.isInteger(samples) || samples < 1 || values.some(value => !Number.isFinite(value))) throw new Error('Invalid bootstrap input');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const draws: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let sum = 0; for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)]!;
    draws.push(sum / values.length);
  }
  draws.sort((a,b) => a-b);
  return { n: values.length, mean: mean(values), low: draws[Math.floor((samples - 1) * 0.025)]!, high: draws[Math.ceil((samples - 1) * 0.975)]! };
}
/** First terminal attempt per planned repeat is primary; subsequent reruns remain in allRuns and accounting. */
export function primaryRepeats(runs: readonly CompareRun[]): CompareRun[] {
  const map = new Map<string, CompareRun>();
  for (const run of runs) {
    const key = `${run.taskId}/${normalizeSystem(run.system)}/${run.repeat ?? run.attempt ?? 1}`;
    if (!map.has(key) || (run.attempt ?? 1) < (map.get(key)!.attempt ?? 1)) map.set(key, run);
  }
  return [...map.values()];
}
function systemStats(runs: readonly CompareRun[], repeats: number) {
  const successes = runs.filter(succeeded).length;
  const tasks = [...new Set(runs.map(run => run.taskId))].sort().map(taskId => {
    const trials = runs.filter(run => run.taskId === taskId), passed = trials.filter(succeeded).length;
    return { taskId, observedRepeats: trials.length, expectedRepeats: repeats, successes: passed, passRate: passed / trials.length,
      passPower: Object.fromEntries(Array.from({ length: repeats }, (_,i) => [String(i+1), passPower(trials.length, passed, i+1)])),
      plugInPassPower: (passed / trials.length) ** repeats, allK: trials.length >= repeats ? passed === trials.length : null };
  });
  const completeTasks = tasks.filter(task => task.allK !== null);
  const metric = (values: number[]) => ({ ...statistics(values), total: values.reduce((a,b) => a+b,0) });
  const totalCost = runs.reduce((sum,run) => sum + estimateCost(run.usage),0), totalTime = runs.reduce((sum,run) => sum + run.wallClockMs,0);
  return { runs: runs.length, successes, passRate: runs.length ? successes / runs.length : null, perTask: tasks,
    allKConsistency: { completeTasks: completeTasks.length, allKPassed: completeTasks.filter(task => task.allK).length, rate: completeTasks.length ? completeTasks.filter(task => task.allK).length / completeTasks.length : null },
    metrics: Object.fromEntries(['wallClockMs','requests','input','output','cacheRead','cacheWrite'].map(key => [key, metric(runs.map(run => key === 'wallClockMs' ? run.wallClockMs : run.usage[key as keyof UsageTotals]))])),
    estimatedCostUSD: totalCost, costPerSuccessfulTaskUSD: successes ? totalCost / successes : null, timePerSuccessfulTaskMs: successes ? totalTime / successes : null,
    unknownUsageRequests: runs.reduce((sum,run) => sum + run.usage.unknownUsageRequests.count,0), completeUsageRuns: runs.filter(run => run.usage.complete).length,
    failures: runs.filter(run => !succeeded(run)).map(run => ({ taskId: run.taskId, repeat: run.repeat ?? run.attempt ?? 1, classification: run.classification ?? 'unclassified legacy', error: run.error ?? null })) };
}
export function benchmarkStatistics(allRuns: readonly CompareRun[], repeats = 1) {
  const runs = primaryRepeats(allRuns);
  const systems = [...new Set([...defaultSystems, ...runs.map(run => normalizeSystem(run.system))])];
  const aggregate = (selected: readonly CompareRun[]) => Object.fromEntries(systems.map(system => [system, systemStats(selected.filter(run => normalizeSystem(run.system) === system), repeats)]));
  const paired = [['pi-orche','pi-solo'],['pi-orche','omp'],['omp','pi-solo']].map(([left,right]) => {
    const perTask = [...new Set(runs.map(run => run.taskId))].sort().flatMap(taskId => {
      // Match repeat indices, even for partial results; never compare disjoint repeats.
      const a = runs.filter(run => run.taskId === taskId && normalizeSystem(run.system) === left), b = runs.filter(run => run.taskId === taskId && normalizeSystem(run.system) === right);
      const matched = a.flatMap(x => { const y = b.find(y => (y.repeat ?? y.attempt ?? 1) === (x.repeat ?? x.attempt ?? 1)); return y ? [[x,y] as const] : []; });
      if (!matched.length) return [];
      const delta = (fn: (run: CompareRun) => number) => mean(matched.map(([x,y]) => fn(x) - fn(y)))!;
      return [{ taskId, repeats: matched.length, passRate: delta(run => +succeeded(run)), wallClockMs: delta(run => run.wallClockMs), requests: delta(run => run.usage.requests), input: delta(run => run.usage.input), output: delta(run => run.usage.output), cacheRead: delta(run => run.usage.cacheRead), cacheWrite: delta(run => run.usage.cacheWrite), costUSD: delta(run => estimateCost(run.usage)) }];
    });
    return { left, right, perTask, bootstrap95: Object.fromEntries(['passRate','wallClockMs','requests','input','output','cacheRead','cacheWrite','costUSD'].map(metric => [metric, bootstrapCI(perTask.map(task => task[metric as keyof Omit<typeof task, 'taskId' | 'repeats'>]))])) };
  });
  return { method: 'First terminal attempt per repeat is primary; all attempts retained. pass^k = choose(successes,k)/choose(observed repeats,k), sampling without replacement; null if incomplete. Plug-in p^k also shown. Paired differences left minus right, matched repeat means per task, percentile 95% bootstrap resampling tasks (10000 draws, seed 20261002). Costs/usage exclude judge. Partial reports provisional; no missing run imputation.', repeats, pricing,
    recordedRuns: allRuns.length, primaryRuns: runs.length, systems: aggregate(runs), allAttempts: aggregate(allRuns), paired,
    byCategory: Object.fromEntries([...new Set(runs.map(run => run.category ?? 'unknown'))].sort().map(category => [category,aggregate(runs.filter(run => (run.category ?? 'unknown') === category))])),
    byTaskAge: { old: aggregate(runs.filter(run => oldTaskIds.has(run.taskId))), new: aggregate(runs.filter(run => !oldTaskIds.has(run.taskId))) } };
}
export function benchmarkMarkdown(stats: ReturnType<typeof benchmarkStatistics>): string {
  const lines = ['# Three-system benchmark (partial until all planned runs finish)', '', stats.method, '', `Pricing: ${pricing.source}. ${pricing.assumption}`, '', '| System | Runs | Pass | Pass rate | All-k tasks | Mean wall s | Requests | Input | Output | Cache read | Cache write | Est. USD | USD/success | s/success | Unknown |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  const columns = lines.slice(6,8);
  const fmt = (n: number | null | undefined) => n == null ? 'n/a' : Number(n.toFixed(4)).toString();
  const table = (group: typeof stats.systems) => { for (const [system,s] of Object.entries(group)) lines.push(`| ${system} | ${s.runs} | ${s.successes} | ${fmt(s.passRate)} | ${s.allKConsistency.allKPassed}/${s.allKConsistency.completeTasks} | ${fmt(s.metrics.wallClockMs?.mean == null ? null : s.metrics.wallClockMs.mean/1000)} | ${s.metrics.requests?.total} | ${s.metrics.input?.total} | ${s.metrics.output?.total} | ${s.metrics.cacheRead?.total} | ${s.metrics.cacheWrite?.total} | ${fmt(s.estimatedCostUSD)} | ${fmt(s.costPerSuccessfulTaskUSD)} | ${fmt(s.timePerSuccessfulTaskMs == null ? null : s.timePerSuccessfulTaskMs/1000)} | ${s.unknownUsageRequests} |`); };
  table(stats.systems);
  lines.push('', '## Paired task bootstrap (left minus right)', '', '| Pair | Metric | Tasks | Mean delta | 95% CI |', '|---|---|---:|---:|---|');
  for (const pair of stats.paired) for (const [metric,ci] of Object.entries(pair.bootstrap95)) lines.push(`| ${pair.left} − ${pair.right} | ${metric} | ${ci.n} | ${fmt(ci.mean)} | [${fmt(ci.low)}, ${fmt(ci.high)}] |`);
  lines.push('', '## Category and old/new breakdown (same columns as overall)');
  for (const [name,group] of [...Object.entries(stats.byCategory),...Object.entries(stats.byTaskAge)]) { lines.push('', `### ${name}`, '', ...columns); table(group); }
  lines.push('', '## Per-task repeat consistency', '', '| System | Task | Observed/expected | Successes | pass^k (k=1..K) | All-k |', '|---|---|---:|---:|---|---|');
  for (const [system,s] of Object.entries(stats.systems)) for (const task of s.perTask) lines.push(`| ${system} | ${task.taskId} | ${task.observedRepeats}/${task.expectedRepeats} | ${task.successes} | ${Object.values(task.passPower).map(fmt).join(', ')} | ${task.allK ?? 'pending'} |`);
  return lines.join('\n')+'\n';
}
