import { appendFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { runOmp, runProcess, listFiles, runnerUsageSchema, extractOmpProviderUsage, extractOmpSessionUsage, parseJsonLines, type RunnerResult, type RunnerUsage } from './omp-runner.js';
import { runPi, probePi, observedPiRuntime, extractPiRequestUsage, loadPromptVariant } from './pi-runner.js';
import { loadSuite, prepareTaskWorkspace, gradeTask, createPiJudge, type TaskGrade, type SuiteTask } from './suite.js';
import { statistics } from './metrics.js';
import { buildStudyArm, studyArmMetadata, piModel, validateBaseModel } from './arms.js';
import { loadProviderExtensions } from '../pi/provider-extensions.js';

export type CompareSystem = 'omp' | 'pi';
export type FailureClass = 'pi-orche defect' | 'harness defect' | 'omp-om-orche behavior' | 'fixture problem' | 'infrastructure';
export interface HoldWait { waitedMs: number; expired: boolean }
export interface CompareRun { taskId: string; system: CompareSystem; status: RunnerResult['status']; wallClockMs: number; usage: RunnerUsage; grade: TaskGrade | null; error?: string; artifactDir: string; attempt?: number; sourceRevision?: string; classification?: FailureClass; classificationBasis?: string; category?: string; language?: string; taskClass?: string | null; recomputed?: boolean; fixtureRegraded?: boolean; promptVariant?: string }
export interface RecomputedRun { label: string; result: CompareRun; originalStatus: CompareRun['status']; originalError?: string; accountingRevision: string }
const root = fileURLToPath(new URL('../../', import.meta.url));
const runSchema = Type.Object({ taskId: Type.String(), system: Type.Union([Type.Literal('omp'),Type.Literal('pi')]), status: Type.Union([Type.Literal('done'),Type.Literal('failed'),Type.Literal('timeout')]), wallClockMs: Type.Number(), usage: runnerUsageSchema, grade: Type.Union([Type.Null(),Type.Object({ passed: Type.Boolean(), checks: Type.Record(Type.String(),Type.Object({ passed: Type.Boolean(), detail: Type.String() })) })]), error: Type.Optional(Type.String()), artifactDir: Type.String(), attempt: Type.Optional(Type.Number()), sourceRevision: Type.Optional(Type.String()), classification: Type.Optional(Type.Union((['pi-orche defect','harness defect','omp-om-orche behavior','fixture problem','infrastructure'] as const).map(value=>Type.Literal(value)))), classificationBasis: Type.Optional(Type.String()), promptVariant: Type.Optional(Type.String()) });
const holdSchema = Type.Object({ waitedMs: Type.Number(), expired: Type.Boolean() });
const pairSchema = Type.Object({ taskId: Type.String(), system: Type.Union([Type.Literal('omp'), Type.Literal('pi')]), artifactDir: Type.String(), attempt: Type.Number({ minimum: 1 }), holdWait: holdSchema, promptVariant: Type.Optional(Type.String()), baseModel: Type.Optional(Type.String()) });
const savedMetaSchema = Type.Object({
  completed: Type.Boolean(), taskId: Type.String(), system: Type.Union([Type.Literal('omp'), Type.Literal('pi')]),
  sourceRevision: Type.Optional(Type.String()), attempt: Type.Optional(Type.Number()),
  result: Type.Composite([Type.Omit(runSchema, ['usage']), Type.Object({ usage: Type.Unknown() })]),
});

async function readSavedRuns(outDir: string, recompute = false, regrade: readonly string[] = [], fixtureRegrade: readonly string[] = []): Promise<CompareRun[]> {
  const runs: CompareRun[] = [];
  const suite = await loadSuite();
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const system of ['omp', 'pi'] as const) {
      const base = join(outDir, entry.name, system);
      let children;
      try { children = await readdir(base, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const directories = [base, ...children.filter(child => child.isDirectory() && /^attempt-\d+$/.test(child.name)).map(child => join(base, child.name))];
      for (const artifactDir of directories) {
      const metaPath = join(artifactDir, 'meta.json');
      let text: string;
      try { text = await readFile(metaPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const raw: unknown = JSON.parse(text);
      if (raw && typeof raw === 'object' && 'completed' in raw && raw.completed === false) continue;
      if (!Value.Check(savedMetaSchema, raw)) throw new Error('Malformed saved comparison metadata: ' + metaPath);
      if (!raw.completed) continue;
      let usage: RunnerUsage;
      if (!recompute && Value.Check(runnerUsageSchema, raw.result.usage)) usage = raw.result.usage;
      else {
        const trace = await readFile(join(artifactDir, 'provider-requests.jsonl'), 'utf8');
        const savedArm = (raw as { overlay?: { arm?: ReturnType<typeof studyArmMetadata> }; arm?: ReturnType<typeof studyArmMetadata>; baseModel?: string });
        usage = system === 'omp' ? extractOmpProviderUsage(parseJsonLines(trace)) : extractPiRequestUsage(trace, savedArm.overlay?.arm ?? savedArm.arm ?? studyArmMetadata(buildStudyArm(raw.result.promptVariant ?? 'C0', savedArm.baseModel)));
        if (recompute && !regrade.includes(`${entry.name}:${system}`)) {
          const destination = join(artifactDir, 'recomputed');
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, 'usage.json'), JSON.stringify(usage, null, 2));
        }
      }
      let result: CompareRun = { ...raw.result, usage, attempt: raw.result.attempt ?? raw.attempt ?? 1, sourceRevision: raw.result.sourceRevision ?? raw.sourceRevision };
      let recomputed = false;
      const task = suite.find(task => task.id === result.taskId);
      if (!task) throw new Error('Unknown saved suite task ' + result.taskId);
      if (regrade.includes(`${entry.name}:${system}`)) {
        if (system !== 'omp' || result.classification !== 'harness defect' || !result.error?.startsWith('Malformed JSON event/session record:') || result.grade !== null) throw new Error('Regrade only supports parser-affected omp runs: ' + artifactDir);
        if (task.grading.rubric || task.grading.mustNotModify) throw new Error('Saved snapshot regrade requires code checks without rubric or git history: ' + task.id);
        const grade = await gradeTask(task, join(artifactDir, 'workspace-final'), '', { judge: async () => { throw new Error('Model calls forbidden during recomputation'); }, timeoutMs: 120_000 });
        const destination = join(artifactDir, 'recomputed');
        await mkdir(destination, { recursive: true });
        const sessions = [];
        for (const file of await listFiles(join(artifactDir, 'sessions'))) if (file.endsWith('.jsonl')) {
          const rows = parseJsonLines(await readFile(file, 'utf8'));
          if (rows.some(row => row.type === 'session')) sessions.push(extractOmpSessionUsage(relative(artifactDir, file), rows));
        }
        const events = parseJsonLines(await readFile(join(artifactDir, 'events.jsonl'), 'utf8'));
        const final = [...events].reverse().find(event => event.type === 'message_end' && event.message?.role === 'assistant');
        if (!final) throw new Error('No final assistant event in saved run ' + artifactDir);
        const originalStatus = result.status, originalError = result.error;
        result = { ...result, status: 'done', grade, usage };
        delete result.error;
        if (grade.passed) { delete result.classification; delete result.classificationBasis; }
        else { result.classification = 'omp-om-orche behavior'; result.classificationBasis = 'Saved final workspace fails enabled grading checks after parser recovery'; }
        const record: RecomputedRun = { label: 'recomputed after parser fix (no model rerun)', result, originalStatus, originalError, accountingRevision: await hashTree(join(root, 'src/eval')) };
        await writeFile(join(destination, 'grade.json'), JSON.stringify(grade, null, 2));
        await writeFile(join(destination, 'usage.json'), JSON.stringify(usage, null, 2));
        await writeFile(join(destination, 'sessions.json'), JSON.stringify(sessions, null, 2));
        await writeFile(join(destination, 'meta.json'), JSON.stringify(record, null, 2));
      } else {
        try {
          const record: unknown = JSON.parse(await readFile(join(artifactDir, 'recomputed/meta.json'), 'utf8'));
          if (!record || typeof record !== 'object' || !('result' in record) || !Value.Check(runSchema, record.result)) throw new Error('Malformed recomputed metadata: ' + artifactDir);
          result = record.result;
          recomputed = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const fixtureDestination = join(artifactDir, 'fixture-regraded');
      if (fixtureRegrade.includes(`${entry.name}:${system}`)) {
        if (task.grading.rubric || task.grading.mustNotModify) throw new Error('Fixture snapshot regrade requires code checks without rubric or git history: ' + task.id);
        const originalGrade = result.grade;
        const grade = await gradeTask(task, join(artifactDir, 'workspace-final'), '', { judge: async () => { throw new Error('Model calls forbidden during fixture regrading'); }, timeoutMs: 120_000 });
        result = { ...result, grade, fixtureRegraded: true };
        if (grade.passed) { delete result.classification; delete result.classificationBasis; }
        await mkdir(fixtureDestination, { recursive: true });
        await writeFile(join(fixtureDestination, 'grade.json'), JSON.stringify(grade, null, 2));
        await writeFile(join(fixtureDestination, 'original-grade.json'), JSON.stringify(originalGrade, null, 2));
        await writeFile(join(fixtureDestination, 'meta.json'), JSON.stringify({ label: 'regraded after fixture fix (post-hoc, disclosed)', result, originalGrade, originalAsRunGrade: raw.result.grade, fixtureRevision: await hashTree(task.dir), accountingRevision: await hashTree(join(root, 'src/eval')) }, null, 2));
      } else {
        try {
          const record: unknown = JSON.parse(await readFile(join(fixtureDestination, 'meta.json'), 'utf8'));
          if (!record || typeof record !== 'object' || !('result' in record) || !Value.Check(runSchema, record.result)) throw new Error('Malformed fixture regrade metadata: ' + artifactDir);
          result = record.result;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const report = system === 'pi' ? JSON.parse(await readFile(join(artifactDir, 'report.json'), 'utf8')) as { taskClass?: string } : null;
      // Saved artifactDir is the as-run absolute path; point at the directory actually read so relocated studies stay analysable.
      runs.push({ ...result, artifactDir, category: task.category, language: task.language, taskClass: report?.taskClass ?? null, recomputed: recomputed || regrade.includes(`${entry.name}:${system}`) });
      }
    }
  }
  return runs;
}

/** Replay saved accounting; optionally grade parser-affected omp snapshots without model calls. Originals remain untouched. */
export async function recomputeComparison(outDir: string, regrade: readonly string[] = [], fixtureRegrade: readonly string[] = []) {
  return writeSummary(resolve(outDir), await readSavedRuns(resolve(outDir), true, regrade, fixtureRegrade), false);
}

export async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listFiles(dir)) { hash.update(relative(dir,file)); hash.update('\0'); hash.update(await readFile(file)); }
  return hash.digest('hex');
}
export function aggregateComparison(runs: readonly CompareRun[]) {
  return Object.fromEntries((['omp','pi'] as const).map(system => {
    const selected = runs.filter(run => run.system === system);
    const metricNames = ['requests','input','output','cacheRead','cacheWrite','sessionCount'] as const;
    const metricValues: [string, number[]][] = [['wallClockMs', selected.map(r=>r.wallClockMs)], ...metricNames.map(key=>[key, selected.map(r=>r.usage[key])] as [string, number[]])];
    return [system, { runs: selected.length, completed: selected.filter(r=>r.status==='done').length,
      gradePassed: selected.filter(r=>r.grade?.passed).length,
      succeeded: selected.filter(r=>r.status==='done'&&r.grade?.passed&&r.usage.validModelEffort).length,
      passRate: selected.length ? selected.filter(r=>r.status==='done'&&r.grade?.passed&&r.usage.validModelEffort).length / selected.length : 0,
      validModelEffortRuns: selected.filter(r=>r.usage.validModelEffort).length, completeUsageRuns: selected.filter(r=>r.usage.complete).length,
      unknownUsageRequests: selected.reduce((sum,r)=>sum+r.usage.unknownUsageRequests.count,0),
      blockedRequests: selected.reduce((sum,r)=>sum+r.usage.blockedRequests.count,0),
      enforcedRequests: selected.reduce((sum,r)=>sum+r.usage.enforcedRequests.count,0),
      metrics: Object.fromEntries(metricValues.map(([name, values]) => {
        const sorted = [...values].sort((a,b)=>a-b), middle = Math.floor(sorted.length / 2);
        return [name, { ...statistics(sorted), total: sorted.reduce((sum,value)=>sum+value,0), median: sorted.length ? (sorted.length % 2 ? sorted[middle]! : (sorted[middle-1]! + sorted[middle]!) / 2) : null }];
      })),
      errors: selected.filter(r=>r.error).map(r=>({taskId:r.taskId,error:r.error})),
    }];
  }));
}
async function writeSummary(outDir: string, runs: CompareRun[], writeTriage = true) {
  const systems = aggregateComparison(runs), first = selectAttempts(runs, 'first'), latest = selectAttempts(runs, 'latest');
  const firstAttemptSystems = aggregateComparison(first), latestAttemptSystems = aggregateComparison(latest);
  const byCategory = Object.fromEntries([...new Set(latest.map(run=>run.category ?? 'unknown'))].sort().map(category=>[category, aggregateComparison(latest.filter(run=>run.category === category))]));
  const byLanguage = Object.fromEntries([...new Set(latest.map(run=>run.language ?? 'unknown'))].sort().map(language=>[language, aggregateComparison(latest.filter(run=>run.language === language))]));
  const triage = runs.filter(run => run.classification).map(run => ({ task: run.taskId, system: run.system, attempt: run.attempt ?? 1, revision: run.sourceRevision ?? null, classification: run.classification, basis: run.classificationBasis, evidence: run.artifactDir, error: run.error ?? null, failedChecks: Object.entries(run.grade?.checks ?? {}).filter(([,check]) => !check.passed).map(([name]) => name) }));
  await writeFile(join(outDir, 'summary.json'), JSON.stringify({ runs, latestRuns: latest, systems, firstAttemptSystems, latestAttemptSystems, byCategory, byLanguage }, null, 2));
  if (writeTriage) await writeFile(join(outDir, 'triage.json'), JSON.stringify(triage, null, 2));
  const lines = ['# omp + om-orche vs pi + pi-orche', '', 'All attempts retained. Revisions are per attempt. Recomputed parser failures use saved workspaces, not model reruns; original errors remain in triage.json and original meta.json. Tokens are KNOWN LOWER BOUNDS when unknown requests remain; judge usage is separate.'];
  lines.push('', 'Pi task classes and recomputation provenance:', '', '| Task | System | Attempt | Task class | Provenance |', '|---|---|---:|---|---|');
  for (const run of runs) lines.push(`| ${run.taskId} | ${run.system} | ${run.attempt ?? 1} | ${run.taskClass ?? 'n/a'} | ${[run.recomputed ? 'recomputed after parser fix (no model rerun)' : '', run.fixtureRegraded ? 'regraded after fixture fix (post-hoc, disclosed)' : ''].filter(Boolean).join('; ') || 'as-run'} |`);
  lines.push('', '| Task | System | Attempt | Revision | Status | Grade | Checks | Wall ms | Sent | Unknown | Enforced | Blocked | Input known | Output known | Cache read known | Cache write known | Sessions | Valid model | Error |', '|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
  for (const run of [...runs].sort((a,b)=>a.taskId.localeCompare(b.taskId)||a.system.localeCompare(b.system)||(a.attempt??1)-(b.attempt??1))) {
    lines.push(`| ${run.taskId} | ${run.system} | ${run.attempt ?? 1} | ${(run.sourceRevision ?? 'unknown').slice(0,12)} | ${run.status} | ${run.grade?.passed ?? 'null'} | ${Object.entries(run.grade?.checks ?? {}).map(([name,check])=>name+':'+check.passed).join(', ')} | ${run.wallClockMs} | ${run.usage.requests} | ${run.usage.unknownUsageRequests.count} | ${run.usage.enforcedRequests.count} | ${run.usage.blockedRequests.count} | ${run.usage.input} | ${run.usage.output} | ${run.usage.cacheRead} | ${run.usage.cacheWrite} | ${run.usage.sessionCount} | ${run.usage.validModelEffort} | ${(run.error ?? '').replaceAll('|','/').replaceAll('\n',' ')} |`);
  }
  lines.push('', '## First vs latest attempts', '', '| Task | System | First attempt / revision / status / grade | Latest attempt / revision / status / grade |', '|---|---|---|---|');
  for (const run of first) {
    const final = latest.find(item => item.taskId === run.taskId && item.system === run.system)!;
    lines.push(`| ${run.taskId} | ${run.system} | ${run.attempt ?? 1} / ${(run.sourceRevision ?? 'unknown').slice(0,12)} / ${run.status} / ${run.grade?.passed ?? 'null'} | ${final.attempt ?? 1} / ${(final.sourceRevision ?? 'unknown').slice(0,12)} / ${final.status} / ${final.grade?.passed ?? 'null'} |`);
  }
  for (const [label, aggregate] of [['All attempts', systems], ['First attempts', firstAttemptSystems], ['Latest attempts', latestAttemptSystems]] as const) for (const [system, data] of Object.entries(aggregate)) {
    lines.push('', `## ${label}: ${system}`, '', `Recorded ${data.runs}; completed ${data.completed}; grade passed ${data.gradePassed}; model-valid completed+graded ${data.succeeded}. Known usage + ${data.unknownUsageRequests} unknown-token requests.`, '', '| Metric | n | Mean | Min | Max | Stddev |', '|---|---:|---:|---:|---:|---:|');
    for (const [name, value] of Object.entries(data.metrics)) lines.push(`| ${name} | ${value.count} | ${value.mean} | ${value.min} | ${value.max} | ${value.stddev} |`);
  }
  await writeFile(join(outDir, 'summary.md'), lines.join('\n') + '\n');
  return { runs, systems, firstAttemptSystems, latestAttemptSystems };
}
/** Main's operational gate; no unbounded wait and no cancellation of in-flight work. */
export async function waitForHold(outDir: string, maxWaitMs = 3_600_000, pollMs = 10_000): Promise<HoldWait> {
  const startedAt = Date.now();
  while (true) {
    try { await stat(join(outDir, 'HOLD')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { waitedMs: Date.now() - startedAt, expired: false };
      throw error;
    }
    const remaining = maxWaitMs - (Date.now() - startedAt);
    if (remaining <= 0) return { waitedMs: Date.now() - startedAt, expired: true };
    const { promise, resolve: wake } = Promise.withResolvers<void>();
    setTimeout(wake, Math.min(pollMs, remaining));
    await promise;
  }
}

async function classifyFailure(result: CompareRun): Promise<{ classification: FailureClass; basis: string }> {
  try {
    const rows = (await readFile(join(result.artifactDir, 'provider-requests.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { status?: number });
    if (rows.some(row => row.status === 429 || (typeof row.status === 'number' && row.status >= 500))) return { classification: 'infrastructure', basis: 'Recorded provider HTTP 429/5xx response' };
  } catch { /* Use the recorded terminal error/checks when no trace is available. */ }
  if (/capture|Malformed|rewrite|constraint violation|Invalid Pi child/i.test(result.error ?? '')) return { classification: 'harness defect', basis: 'Recorded runner capture/configuration/serialization failure' };
  if (/Invalid .*task|Unknown suite task|Missing .*fixture/i.test(result.error ?? '')) return { classification: 'fixture problem', basis: 'Recorded suite input/fixture validation failure' };
  return { classification: result.system === 'pi' ? 'pi-orche defect' : 'omp-om-orche behavior', basis: '[INFERENCE] Behavioral failure; owner must diagnose from report, grade and traces' };
}

/** One fresh process per pair means post-HOLD jobs load the revised sources, not a stale module cache. */
async function executePair(input: PairInput): Promise<CompareRun> {
  if (input.promptVariant !== undefined && input.system !== 'pi') throw new Error('Prompt variants apply to pi only');
  const task = (await loadSuite()).find(item => item.id === input.taskId);
  if (!task) throw new Error('Unknown suite task ' + input.taskId);
  const artifactDir = input.artifactDir, metaPath = join(artifactDir, 'meta.json');
  await mkdir(artifactDir, { recursive: true });
  const sourceRevision = createHash('sha256').update(await hashTree(join(root, 'src'))).update(await readFile(join(root, 'orche.config.json'))).digest('hex');
  const ompVersion = await runProcess('/home/arthur/.bun/bin/omp', ['--version'], { cwd: root, timeoutMs: 30_000 });
  const piVersionRaw: unknown = JSON.parse(await readFile(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
  const piVersion = piVersionRaw && typeof piVersionRaw === 'object' && 'version' in piVersionRaw ? piVersionRaw.version : null;
  const startedAt = Date.now(), taskHash = await hashTree(task.dir);
  const arm = buildStudyArm(input.promptVariant ?? 'C0', input.baseModel);
  const metadata = { system: input.system, taskId: task.id, attempt: input.attempt, holdWait: input.holdWait, baseModel: arm.baseModel, arm: studyArmMetadata(arm), ...(input.promptVariant === undefined ? {} : { promptVariant: input.promptVariant }), sourceRevision, suiteTaskHash: taskHash, versions: { omp: ompVersion.stdout.trim(), pi: piVersion }, instruction: task.instruction, timeoutSec: task.timeoutSec, completed: false, startedAt };
  await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  let workspace: { dir: string; cleanup(): Promise<void> } | undefined, outcome: RunnerResult | undefined, grade: TaskGrade | null = null, error: string | undefined;
  try {
    workspace = await prepareTaskWorkspace(task);
    const manifest = [];
    for (const file of await listFiles(workspace.dir)) {
      const name = relative(workspace.dir, file);
      if (!name.startsWith('.git/')) manifest.push({ path: name, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
    }
    await writeFile(join(artifactDir, 'workspace-before.json'), JSON.stringify({ source: 'task.repo only', files: manifest }, null, 2));
    outcome = await (input.system === 'omp' ? runOmp : runPi)({ cwd: workspace.dir, instruction: task.instruction, outDir: artifactDir, timeoutSec: task.timeoutSec, baseModel: arm.baseModel, ...(input.promptVariant === undefined ? {} : { promptVariant: input.promptVariant }) });
    await writeFile(join(artifactDir, 'final.txt'), outcome.answer);
    const judgeArm = studyArmMetadata(buildStudyArm('C0', arm.baseModel));
    const judgeCapture = await observedPiRuntime(join(artifactDir, 'judge-requests.jsonl'), undefined, judgeArm);
    const judgeHost = judgeArm.providerExtensions.length ? await loadProviderExtensions(judgeCapture.runtime, judgeArm.providerExtensions, { cwd: workspace.dir }) : undefined;
    try {
      grade = await gradeTask(task, workspace.dir, outcome.answer, { judge: createPiJudge({ modelRuntime: judgeCapture.runtime, model: arm.baseModel, thinking: 'high' }), timeoutMs: 120_000 });
      await judgeCapture.drain();
      await writeFile(join(artifactDir, 'judge-usage.json'), JSON.stringify(extractPiRequestUsage(await readFile(join(artifactDir, 'judge-requests.jsonl'), 'utf8'), judgeArm), null, 2));
    } finally { judgeHost?.dispose(); }
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  const usage: RunnerUsage = outcome?.usage ?? { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: [], sessionCount: 0, models: [], thinking: [], complete: false, limitations: ['Runner did not return usage'], validModelEffort: false, knownUsageRequests: 0, unknownUsageRequests: { count: 0, requests: [] }, blockedRequests: { count: 0, requests: [] }, enforcedRequests: { count: 0, requests: [] } };
  const result: CompareRun = { taskId: task.id, system: input.system, attempt: input.attempt, sourceRevision, status: error ? 'failed' : outcome?.status ?? 'failed', wallClockMs: outcome ? outcome.finishedAt - outcome.startedAt : Date.now() - startedAt, usage, grade, artifactDir, ...(input.promptVariant === undefined ? {} : { promptVariant: input.promptVariant }), ...((error ?? outcome?.error) ? { error: error ?? outcome?.error } : {}) };
  if (result.status !== 'done' || !grade?.passed || !usage.validModelEffort) {
    const classified = await classifyFailure(result);
    result.classification = classified.classification; result.classificationBasis = classified.basis;
  }
  try {
    if (workspace) await cp(workspace.dir, join(artifactDir, 'workspace-final'), { recursive: true, filter: file => file !== join(workspace!.dir, '.git') });
    await Promise.all([
      writeFile(join(artifactDir, 'usage.json'), JSON.stringify(usage, null, 2)),
      writeFile(join(artifactDir, 'grade.json'), JSON.stringify(grade, null, 2)),
      writeFile(join(artifactDir, 'final.txt'), outcome?.answer ?? ''),
      writeFile(metaPath, JSON.stringify({ ...metadata, completed: true, finishedAt: Date.now(), command: outcome?.command ?? null, overlay: outcome?.overlay ?? null, exitCode: outcome?.exitCode ?? null, runnerStatus: outcome?.status ?? null, result }, null, 2)),
    ]);
  } finally { await workspace?.cleanup(); }
  return result;
}

export function selectAttempts(runs: readonly CompareRun[], which: 'first' | 'latest'): CompareRun[] {
  const selected = new Map<string, CompareRun>();
  for (const run of runs) {
    const key = `${run.taskId}/${run.system}`, existing = selected.get(key);
    if (!existing || (which === 'first' ? (run.attempt ?? 1) < (existing.attempt ?? 1) : (run.attempt ?? 1) > (existing.attempt ?? 1))) selected.set(key, run);
  }
  return [...selected.values()];
}

type PairInput = { taskId: string; system: CompareSystem; artifactDir: string; attempt: number; holdWait: HoldWait; promptVariant?: string; baseModel?: string };
/** One fresh child process per pair; a synthesised harness-defect record replaces a missing terminal record. */
async function runPairProcess(input: PairInput): Promise<CompareRun> {
  const { artifactDir } = input;
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'pair-input.json'), JSON.stringify(input));
  const task = (await loadSuite()).find(item => item.id === input.taskId)!;
  const args = ['tsx', fileURLToPath(import.meta.url), '--pair-child', join(artifactDir, 'pair-input.json')];
  const startedAt = Date.now();
  const child = await runProcess('npx', args, { cwd: root, timeoutMs: (task.timeoutSec + 30 + 120 * Object.values(task.grading).filter(value => value === true).length + 120) * 1000, stdoutFile: join(artifactDir, 'pair-stdout.txt'), stderrFile: join(artifactDir, 'pair-stderr.txt') });
  try {
    const raw: unknown = JSON.parse(await readFile(join(artifactDir, 'pair-result.json'), 'utf8'));
    if (!Value.Check(runSchema, raw)) throw new Error('Malformed pair child result');
    return raw;
  } catch (error) {
    let usage: RunnerUsage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: [], sessionCount: 0, models: [], thinking: [], complete: false, limitations: ['Pair process did not return complete usage'], validModelEffort: false, knownUsageRequests: 0, unknownUsageRequests: { count: 0, requests: [] }, blockedRequests: { count: 0, requests: [] }, enforcedRequests: { count: 0, requests: [] } };
    try { const trace = await readFile(join(artifactDir, 'provider-requests.jsonl'), 'utf8'); usage = input.system === 'omp' ? extractOmpProviderUsage(parseJsonLines(trace)) : extractPiRequestUsage(trace, studyArmMetadata(buildStudyArm(input.promptVariant ?? 'C0', input.baseModel))); } catch { /* Explicit partial accounting. */ }
    const result: CompareRun = { taskId: input.taskId, system: input.system, artifactDir, attempt: input.attempt, status: child.timedOut ? 'timeout' : 'failed', wallClockMs: Date.now() - startedAt, usage, grade: null, error: child.stderr || (error instanceof Error ? error.message : String(error)), classification: 'harness defect', classificationBasis: 'Pair process failed before producing its terminal record', ...(input.promptVariant === undefined ? {} : { promptVariant: input.promptVariant }) };
    await writeFile(join(artifactDir, 'meta.json'), JSON.stringify({ ...input, completed: true, sourceRevision: await hashTree(join(root, 'src')), result }, null, 2));
    await writeFile(join(artifactDir, 'usage.json'), JSON.stringify(usage, null, 2));
    await writeFile(join(artifactDir, 'grade.json'), 'null');
    return result;
  }
}

export async function runComparison(options: { tasks: readonly string[] | 'all'; systems?: readonly CompareSystem[]; concurrency?: number; outDir: string; resume?: boolean; rerun?: readonly string[]; promptVariant?: string; baseModel?: string }) {
  const baseModel = validateBaseModel(options.baseModel ?? piModel);
  const initialConcurrency = options.concurrency ?? 2;
  if (!Number.isInteger(initialConcurrency) || initialConcurrency < 1) throw new Error('concurrency must be a positive integer');
  const systems = options.systems ?? ['omp', 'pi'];
  if (!systems.length || systems.some(system => system !== 'omp' && system !== 'pi')) throw new Error('systems must be omp and/or pi');
  const suite = await loadSuite(), outDir = resolve(options.outDir);
  const tasks = options.tasks === 'all' ? suite : options.tasks.map(id => {
    const task = suite.find(item => item.id === id); if (!task) throw new Error('Unknown suite task ' + id); return task;
  });
  await mkdir(outDir, { recursive: true });
  const runs = await readSavedRuns(outDir), jobs: { taskId: string; system: CompareSystem; force: boolean }[] = [];
  const force = new Set(options.rerun ?? []);
  for (const [index, task] of tasks.entries()) for (const system of index % 2 === 0 ? systems : [...systems].reverse()) {
    const exists = runs.some(run => run.taskId === task.id && run.system === system);
    if (exists && !options.resume && !force.has(`${task.id}:${system}`)) throw new Error(`Existing run ${task.id}/${system}; use --resume or --rerun`);
    if (!exists || force.has(`${task.id}:${system}`)) jobs.push({ taskId: task.id, system, force: exists });
  }
  let next = 0, concurrency = initialConcurrency, stop = false, infrastructureFailures = 0;
  const active = new Set<Promise<void>>(), reservedAttempts = new Map<string, number>();
  const stopScheduling = () => { stop = true; console.log('COMPARE_STOPPING: draining in-flight runs'); };
  process.once('SIGTERM', stopScheduling); process.once('SIGINT', stopScheduling);
  async function collectRequests() {
    const requestPath = join(outDir, 'RERUN.json');
    let text: string;
    try { text = await readFile(requestPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const raw: unknown = JSON.parse(text);
    const schema = Type.Array(Type.Object({ taskId: Type.String(), system: Type.Union([Type.Literal('omp'), Type.Literal('pi')]) }));
    if (!Value.Check(schema, raw)) throw new Error('Invalid RERUN.json');
    for (const request of raw) {
      if (!suite.some(task => task.id === request.taskId)) throw new Error('Unknown rerun task ' + request.taskId);
      jobs.push({ ...request, force: true });
    }
    await rename(requestPath, join(outDir, `RERUN-consumed-${Date.now()}.json`));
  }
  async function launch(job: { taskId: string; system: CompareSystem; force: boolean }, holdWait: HoldWait) {
    const existing = runs.filter(run => run.taskId === job.taskId && run.system === job.system);
    const pairKey = `${job.taskId}/${job.system}`;
    const attempt = Math.max(reservedAttempts.get(pairKey) ?? 0, ...existing.map(run => run.attempt ?? 1)) + 1;
    reservedAttempts.set(pairKey, attempt);
    const base = join(outDir, job.taskId, job.system);
    const artifactDir = attempt === 1 ? base : join(base, `attempt-${attempt}`);
    try { await stat(join(artifactDir, 'meta.json')); throw new Error('Attempt already exists: ' + artifactDir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const result = await runPairProcess({ taskId: job.taskId, system: job.system, artifactDir, attempt, holdWait, baseModel, ...(options.promptVariant === undefined ? {} : { promptVariant: options.promptVariant }) });
    runs.push(result);
    await appendFile(join(outDir, 'completion-events.jsonl'), JSON.stringify(result) + '\n');
    if (result.classification) {
      console.log('COMPARE_ERROR ' + JSON.stringify({ task: result.taskId, system: result.system, attempt, classification: result.classification, basis: result.classificationBasis, evidence: artifactDir, revision: result.sourceRevision ?? null }));
      if (result.classification === 'infrastructure') {
        infrastructureFailures++; concurrency = Math.min(concurrency, 2);
        if (infrastructureFailures >= 3) { stop = true; console.log('COMPARE_STOPPING: repeated infrastructure failures'); }
      }
    }
    console.log(`${job.taskId}/${job.system}/attempt-${attempt}: ${result.status}; grade=${result.grade?.passed ?? 'null'}; sent=${result.usage.requests}; unknown=${result.usage.unknownUsageRequests.count}; revision=${result.sourceRevision ?? 'unknown'}`);
    await writeSummary(outDir, runs);
  }
  console.log(`COMPARE_STARTED out=${outDir} pairs=${jobs.length} concurrency=${concurrency}`);
  try {
    while ((!stop && next < jobs.length) || active.size) {
      if (!stop) {
        const holdWait = await waitForHold(outDir);
        if (holdWait.waitedMs >= 1000 || holdWait.expired) await appendFile(join(outDir, 'hold-events.jsonl'), JSON.stringify({ timestamp: Date.now(), ...holdWait }) + '\n');
        await collectRequests();
        while (next < jobs.length && active.size < concurrency && !stop) {
          const job = jobs[next++]!;
          const promise = launch(job, holdWait);
          active.add(promise); void promise.then(() => active.delete(promise), () => active.delete(promise));
        }
      }
      if (active.size) await Promise.race(active);
    }
  } finally { process.off('SIGTERM', stopScheduling); process.off('SIGINT', stopScheduling); }
  return writeSummary(outDir, runs);
}

/** Study arms (--variants C0,C1,C2,A0,A1): each (task, arm, repeat) is one fresh pi run at outDir/<arm>/<task>/pi[/attempt-<repeat>]. Arms are interleaved per task and rotated so no arm always runs first. */
export async function runPromptStudy(options: { tasks: readonly string[]; variants: readonly string[]; repeats: number; concurrency: number; outDir: string; resume?: boolean; baseModel?: string }) {
  const baseModel = validateBaseModel(options.baseModel ?? piModel);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('concurrency must be a positive integer');
  if (!Number.isInteger(options.repeats) || options.repeats < 1) throw new Error('repeats must be a positive integer');
  const arms = options.variants.map(name => buildStudyArm(name, baseModel));
  const variants = await Promise.all(arms.map(async arm => ({ ...await loadPromptVariant(arm.promptVariant), name: arm.name, promptVariant: arm.promptVariant })));
  if (!variants.length || new Set(options.variants).size !== variants.length) throw new Error('variants must be nonempty and unique');
  const suite = await loadSuite(), outDir = resolve(options.outDir);
  const tasks = options.tasks.map(id => {
    const task = suite.find(item => item.id === id); if (!task) throw new Error('Unknown suite task ' + id); return task;
  });
  const jobs: { taskId: string; variant: string; repeat: number; artifactDir: string }[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat++) for (const [index, task] of tasks.entries()) for (let offset = 0; offset < variants.length; offset++) {
    const variant = variants[(index + repeat - 1 + offset) % variants.length]!.name, base = join(outDir, variant, task.id, 'pi');
    const artifactDir = repeat === 1 ? base : join(base, `attempt-${repeat}`);
    let completed = false;
    try {
      const saved: unknown = JSON.parse(await readFile(join(artifactDir, 'meta.json'), 'utf8'));
      completed = Value.Check(Type.Object({ completed: Type.Literal(true) }), saved);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (completed && !options.resume) throw new Error(`Existing run ${artifactDir}; use --resume`);
    if (!completed) jobs.push({ taskId: task.id, variant, repeat, artifactDir });
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'study-manifest.json'), JSON.stringify({ startedAt: Date.now(), baseModel, tasks: tasks.map(task => task.id), repeats: options.repeats, concurrency: options.concurrency, variants: variants.map(({ name, promptVariant, file, sha256, chars }) => ({ name, promptVariant, file, sha256, chars })), arms: arms.map(studyArmMetadata), jobOrder: jobs.map(job => `${job.variant}/${job.taskId}/r${job.repeat}`) }, null, 2));
  let next = 0;
  const worker = async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      const holdWait = { waitedMs: 0, expired: false };
      const result = await runPairProcess({ taskId: job.taskId, system: 'pi', artifactDir: job.artifactDir, attempt: job.repeat, holdWait, promptVariant: job.variant, baseModel });
      await appendFile(join(outDir, 'completion-events.jsonl'), JSON.stringify(result) + '\n');
      console.log(`${job.variant}/${job.taskId}/r${job.repeat}: ${result.status}; grade=${result.grade?.passed ?? 'null'}; sent=${result.usage.requests}; wall=${result.wallClockMs}`);
    }
  };
  console.log(`STUDY_STARTED out=${outDir} runs=${jobs.length} concurrency=${options.concurrency}`);
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));
  for (const { name } of variants) { await mkdir(join(outDir, name), { recursive: true }); await writeSummary(join(outDir, name), await readSavedRuns(join(outDir, name))); }
}
export async function runProbes(outDir: string) {
  const task=(await loadSuite()).find(t=>t.id==='a6-typo-message');if(!task)throw new Error('Probe visible workspace task missing');
  const results=[];
  for(const system of ['omp','pi']as const){const workspace=await prepareTaskWorkspace(task);const dir=join(outDir,'probes',system);try{const options={cwd:workspace.dir,instruction:'Reply exactly COMPARISON_PROBE_OK.',outDir:dir,timeoutSec:120};const result=system==='omp'?await runOmp(options):await probePi(options);await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2));results.push(result);console.log(`Probe ${system}: ${result.status}, models=${result.usage.models}, thinking=${result.usage.thinking}, complete=${result.usage.complete}`);}finally{await workspace.cleanup();}}
  return results;
}
/** Shared by study and single-comparison CLI modes; reject missing flag values early. */
export function parseBaseModel(argv: readonly string[]): string {
  const index = argv.indexOf('--base-model');
  return validateBaseModel(index < 0 ? piModel : argv[index + 1] ?? '');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const argv=process.argv.slice(2);const value=(flag:string,fallback:string)=>{const index=argv.indexOf(flag);return index<0?fallback:argv[index+1]??'';};const outDir=value('--out',join('results','compare',new Date().toISOString().replaceAll(':','-')));
  if(argv.includes('--pair-child')){
    const raw:unknown=JSON.parse(await readFile(value('--pair-child',''),'utf8'));
    if(!Value.Check(pairSchema,raw))throw new Error('Invalid pair child invocation');
    await writeFile(join(raw.artifactDir,'pair-result.json'),JSON.stringify(await executePair(raw),null,2));
  }
  else if(argv.includes('--probe'))await runProbes(outDir);
  else if(argv.includes('--recompute'))await recomputeComparison(value('--recompute',''), argv.includes('--regrade') ? value('--regrade','').split(',') : [], argv.includes('--fixture-regrade') ? value('--fixture-regrade','').split(',') : []);
  else {
    if(!argv.includes('--tasks'))throw new Error('Required: --tasks <ids|all>; use --probe for the minimal probes');
    const baseModel = parseBaseModel(argv);
    if(argv.includes('--study'))await runPromptStudy({tasks:value('--tasks','').split(',').filter(Boolean),variants:value('--variants','C0,C1,C2').split(','),repeats:Number(value('--repeats','2')),concurrency:Number(value('--concurrency','4')),outDir,resume:argv.includes('--resume'),baseModel});
    else await runComparison({tasks:value('--tasks','all')==='all'?'all':value('--tasks','all').split(','),systems:value('--systems','omp,pi').split(',')as CompareSystem[],concurrency:Number(value('--concurrency','2')),outDir,resume:argv.includes('--resume'),baseModel,rerun:argv.includes('--rerun')?value('--rerun','').split(','):undefined,...(argv.includes('--prompt-variant')?{promptVariant:value('--prompt-variant','')}:{})});
  }
}
