import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRouteConfig } from '../orchestration/routing.js';
import type { RouteConfig } from '../orchestration/routing.js';
import type { RunMode, RunEvent } from '../orchestration/events.js';
import { runOrchestrated, type RunReport, type RunOptions } from '../orchestration/coordinator.js';
import { runBaseline } from './baseline.js';
import { problemA, prepareWorkspace, gradeWorkspace, type GradeResult, type PreparedWorkspace } from './scenarios.js';
import { computeMetrics, computeUsageByKind, numericMetrics, statistics, type RunMetrics, type TokenTotals } from './metrics.js';

export interface Trial { mode: RunMode; trial: number; round?: number; artifactDir: string; report: RunReport; grade: GradeResult | null; metrics: RunMetrics; usageByKind: Record<string, TokenTotals>; error?: string }
export async function runBenchmark(args: { runs: number; modes: readonly RunMode[]; config: string; outputDir?: string; limits?: RunOptions['limits'] }) {
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('runs must be a positive integer');
  if (!args.modes.length || args.modes.some(m => m !== 'baseline' && m !== 'orchestrated')) throw new Error('modes must be baseline and/or orchestrated');
  const routes = await loadRouteConfig(args.config);
  const outputDir = args.outputDir ?? join('results', 'bench', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'config.json'), JSON.stringify({ routes, runs: args.runs, modes: args.modes, limits: args.limits ?? null }, null, 2));
  const trials: Trial[] = [];
  for (let i = 1; i <= args.runs; i++) for (const mode of args.modes) {
    const artifactDir = join(outputDir, `${mode}-${i}`);
    await mkdir(artifactDir, { recursive: true });
    const events: RunEvent[] = [];
    let grade: GradeResult | null = null;
    let workspace: PreparedWorkspace | undefined;
    const startedAt = Date.now();
    let report: RunReport = { status: 'failed', taskClass: 'unclassified', answer: 'Run did not start', summary: 'Run did not start', tasks: [], startedAt, finishedAt: startedAt };
    let error: string | undefined;
    try {
      workspace = await prepareWorkspace();
      const run = mode === 'baseline' ? runBaseline : runOrchestrated;
      report = await run({ problem: problemA.userProblemPrompt, cwd: workspace.dir, routes, sink: event => events.push(event), ...(args.limits ? { limits: args.limits } : {}) });
      grade = await gradeWorkspace(workspace.dir);
    } catch (caught) {
      error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
      report = { ...report, status: 'failed', answer: error, summary: error, finishedAt: Date.now() };
      if (!events.some(e => e.type === 'run_started')) events.push({ type: 'run_started', timestamp: startedAt, mode, problem: problemA.userProblemPrompt });
      if (!events.some(e => e.type === 'run_finished')) events.push({ type: 'run_finished', timestamp: report.finishedAt, status: 'failed', summary: error });
      if (workspace && !grade) { try { grade = await gradeWorkspace(workspace.dir); } catch { /* Grade remains explicitly undefined. */ } }
    } finally {
      const metrics = computeMetrics(events, problemA.groundTruth, grade);
      const trial: Trial = { mode, trial: i, artifactDir, report, grade, metrics, usageByKind: computeUsageByKind(events), ...(error ? { error } : {}) };
      trials.push(trial);
      try {
        await Promise.all([
          writeFile(join(artifactDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n'),
          writeFile(join(artifactDir, 'report.json'), JSON.stringify(report, null, 2)),
          writeFile(join(artifactDir, 'grade.json'), JSON.stringify(grade, null, 2)),
          writeFile(join(artifactDir, 'metrics.json'), JSON.stringify(metrics, null, 2)),
        ]);
      } finally { await workspace?.cleanup(); }
      console.log(`${mode}-${i}: ${report.status}; grade=${grade?.passed ?? 'undefined'}; wall=${metrics.wallClockMs}; requests=${metrics.requests}`);
    }
  }
  return writeSummary(outputDir, routes, trials, args.modes, args.config);
}

async function writeSummary(outputDir: string, routes: RouteConfig, trials: Trial[], modes: readonly RunMode[], config: string) {
  const summaries = Object.fromEntries(modes.map(mode => {
    const subset = trials.filter(t => t.mode === mode);
    const keys = Object.keys(numericMetrics(subset[0]!.metrics));
    return [mode, { runs: subset.length, correctnessRate: subset.filter(t => t.report.status === 'done' && t.grade?.passed).length / subset.length,
      gradePassRate: subset.filter(t => t.grade?.passed).length / subset.length,
      metrics: Object.fromEntries(keys.map(key => [key, statistics(subset.map(t => numericMetrics(t.metrics)[key] ?? null))])),
      usageByKind: Object.fromEntries([...new Set(subset.flatMap(t => Object.keys(t.usageByKind)))].map(kind => {
        const total: TokenTotals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
        for (const trial of subset) for (const key of Object.keys(total) as (keyof TokenTotals)[]) total[key] += trial.usageByKind[kind]?.[key] ?? 0;
        return [kind, total];
      })),
    }];
  }));
  const summary = { outputDir, scenario: problemA.id, routes, trials, modes: summaries };
  await writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const lines = ['# Problem A benchmark', '', `Configuration: \`${config}\`. Interleaved modes: ${modes.join(', ')}. Population standard deviation; null observations excluded, count reported. Correctness requires completed run plus both grade suites.`, '', '| Round | Mode | Trial | Status | Grade | Wall ms | Requests | Nudges | Input | Output | Cache read | Root cause ms |', '|---:|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const t of trials) lines.push(`| ${t.round ?? 1} | ${t.mode} | ${t.trial} | ${t.report.status} | ${t.grade?.passed ?? 'null'} | ${t.metrics.wallClockMs} | ${t.metrics.requests} | ${t.metrics.nudgeCount} | ${t.metrics.inputTokens} | ${t.metrics.outputTokens} | ${t.metrics.cacheRead} | ${t.metrics.timeToRootCauseMs} |`);
  for (const [mode, result] of Object.entries(summaries)) {
    lines.push('', `## ${mode}`, '', `Correctness rate: ${result.correctnessRate}. Grade pass rate: ${result.gradePassRate}.`, '', '| Metric | n | Mean | Min | Max | Stddev |', '|---|---:|---:|---:|---:|---:|');
    for (const [key, stats] of Object.entries(result.metrics)) lines.push(`| ${key} | ${stats.count} | ${stats.mean} | ${stats.min} | ${stats.max} | ${stats.stddev} |`);
    lines.push('', '### Assignment-kind usage totals', '', '| Kind | Requests | Input | Output | Cache read | Cache write |', '|---|---:|---:|---:|---:|---:|');
    for (const [kind, total] of Object.entries(result.usageByKind) as [string, TokenTotals][]) lines.push(`| ${kind} | ${total.requests} | ${total.inputTokens} | ${total.outputTokens} | ${total.cacheRead} | ${total.cacheWrite} |`);
  }
  await writeFile(join(outputDir, 'summary.md'), lines.join('\n') + '\n');
  console.log(`Artifacts: ${outputDir}`);
  return summary;
}

/** Re-score saved observations without creating a workspace or making a model call. */
export async function recomputeBenchmark(outputDir: string) {
  const config = JSON.parse(await readFile(join(outputDir, 'config.json'), 'utf8')) as { routes: RouteConfig; modes: RunMode[] };
  const trials: Trial[] = [];
  for (const entry of await readdir(outputDir, { withFileTypes: true })) {
    const match = /^(baseline|orchestrated)-(\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const artifactDir = join(outputDir, entry.name);
    const events = (await readFile(join(artifactDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RunEvent);
    const grade = JSON.parse(await readFile(join(artifactDir, 'grade.json'), 'utf8')) as GradeResult | null;
    const report = JSON.parse(await readFile(join(artifactDir, 'report.json'), 'utf8')) as RunReport;
    const metrics = computeMetrics(events, problemA.groundTruth, grade);
    await writeFile(join(artifactDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    trials.push({ mode: match[1] as RunMode, trial: Number(match[2]), artifactDir, report, grade, metrics, usageByKind: computeUsageByKind(events) });
  }
  trials.sort((a, b) => a.trial - b.trial || config.modes.indexOf(a.mode) - config.modes.indexOf(b.mode));
  if (!trials.length) throw new Error(`No saved trials in ${outputDir}`);
  return writeSummary(outputDir, config.routes, trials, config.modes.filter(mode => trials.some(t => t.mode === mode)), join(outputDir, 'config.json'));
}

/** Combine re-scored rounds while preserving source paths and as-run statuses. */
export async function combineBenchmarks(directories: readonly string[], outputDir: string) {
  if (!directories.length) throw new Error('At least one benchmark round is required');
  const rounds = [];
  const trials: Trial[] = [];
  for (const [index, dir] of directories.entries()) {
    const summary = await recomputeBenchmark(dir);
    rounds.push({ outputDir: dir, routes: summary.routes });
    trials.push(...summary.trials.map(trial => ({ ...trial, round: index + 1 })));
  }
  const modes: RunMode[] = ['baseline', 'orchestrated'].filter(mode => trials.some(t => t.mode === mode)) as RunMode[];
  await mkdir(outputDir, { recursive: true });
  const routes = rounds[0]!.routes;
  await writeFile(join(outputDir, 'config.json'), JSON.stringify({ routes, modes, rounds }, null, 2));
  return writeSummary(outputDir, routes, trials, modes, join(outputDir, 'config.json'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1] ?? ''; };
  if (args.includes('--recompute')) await recomputeBenchmark(value('--recompute', ''));
  else if (args.includes('--combine')) await combineBenchmarks(value('--combine', '').split(','), value('--output', join('results', 'bench', 'combined-' + new Date().toISOString().replaceAll(':', '-'))));
  else await runBenchmark({ runs: Number(value('--runs', '3')), modes: value('--modes', 'baseline,orchestrated').split(',') as RunMode[], config: value('--config', 'orche.config.json') });
}
