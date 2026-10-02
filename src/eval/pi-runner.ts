import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Context } from '@earendil-works/pi-ai';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { runOrchestrated } from '../orchestration/coordinator.js';
import { createSession } from '../pi/session-factory.js';
import { directorySessionRecords } from '../agent/records.js';
import { runProcess, runnerResultSchema, type RunnerOptions, type RunnerResult, type RunnerUsage, type SessionUsage, type UsageTotals, type UnknownUsageRequest } from './omp-runner.js';
import { buildStudyArm, matchArmRequest, studyArmMetadata, piModel, promptVariants, type StudyArmMetadata } from './arms.js';
export { piModel, piRoutes, promptVariants } from './arms.js';

export interface PiRunnerOptions extends RunnerOptions {
  promptVariant?: string; arm?: string; baseModel?: string;
  /** Opt-in: keep the transcripts of the run's sessions (coordinator, workers, advisors) as pi session JSONL files in this directory. Default: none, every session stays in memory. */
  recordsDir?: string;
}
export interface LoadedPromptVariant { name: string; file: string | null; text: string | undefined; sha256: string | null; chars: number }
export async function loadPromptVariant(name: string): Promise<LoadedPromptVariant> {
  if (!Object.hasOwn(promptVariants, name)) throw new Error(`Unknown prompt variant ${name}; expected ${Object.keys(promptVariants).join(', ')}`);
  const file = promptVariants[name]!;
  if (file === null) return { name, file: null, text: undefined, sha256: null, chars: 0 };
  const text = await readFile(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
  return { name, file, text, sha256: sha(text), chars: text.length };
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const itemText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('') : '';
/** What actually went over the wire: leading system/developer text, all system/developer text anywhere in the input, and tool definitions (top-level `tools` plus `additional_tools` input items). */
export function summarizePayloadSystem(payload: unknown): { system: string; systemSha256: string; systemChars: number; allSystem: string; allSystemSha256: string; inputShape: string[]; toolNames: string[]; toolsSha256: string } {
  const body = payload && typeof payload === 'object' ? payload as { instructions?: unknown; input?: unknown; messages?: unknown; tools?: unknown } : {};
  const parts: string[] = typeof body.instructions === 'string' ? [body.instructions] : [];
  const everywhere = [...parts], shape: string[] = [], declared: unknown[] = Array.isArray(body.tools) ? [...body.tools] : [];
  let leading = true;
  const input = body.input ?? body.messages;
  if (Array.isArray(input)) for (const [index, item] of input.entries()) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (index < 6) shape.push(`${String(record.type ?? '')}:${String(record.role ?? '')}`);
    if (record.type === 'additional_tools' && Array.isArray(record.tools)) declared.push(...record.tools);
    const isSystem = (record.role === 'system' || record.role === 'developer') && record.type !== 'additional_tools';
    if (isSystem) everywhere.push(itemText(record.content));
    if (leading && isSystem) parts.push(itemText(record.content)); else leading = false;
  }
  const system = parts.join('\n'), allSystem = everywhere.join('\n');
  const tools = declared.map(tool => {
    const record = tool as { name?: unknown; function?: { name?: unknown } };
    return { name: String(record.name ?? record.function?.name ?? ''), definition: JSON.stringify(tool) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { system, systemSha256: sha(system), systemChars: system.length, allSystem, allSystemSha256: sha(allSystem), inputShape: shape, toolNames: tools.map(tool => tool.name), toolsSha256: sha(tools.map(tool => tool.definition).join('\n')) };
}
const payloadSchema = Type.Object({ model: Type.String(), reasoning: Type.Optional(Type.Object({ effort: Type.Optional(Type.String()) })), reasoning_effort: Type.Optional(Type.String()), output_config: Type.Optional(Type.Object({ effort: Type.Optional(Type.String()) })) });
/** Keep wire evidence; normalize only a catalog-declared mapping for an attributed advisor. */
export function captureArmPayload(payload: unknown, physicalModel: { provider: string; id: string; thinkingLevelMap?: Readonly<Record<string, string | number | null | undefined>> }, arm: StudyArmMetadata, actor = 'non-advisor') {
  if (!Value.Check(payloadSchema, payload)) throw new Error('Pi payload capture cannot identify model/effort');
  const model = `${physicalModel.provider}/${payload.model}`;
  const wireEffort = payload.reasoning?.effort ?? payload.reasoning_effort ?? (actor.startsWith('advisor:') ? payload.output_config?.effort : undefined) ?? null;
  const effortSource = payload.reasoning?.effort !== undefined ? 'reasoning.effort' : payload.reasoning_effort !== undefined ? 'reasoning_effort' : payload.output_config?.effort !== undefined ? 'output_config.effort' : 'absent';
  const configured = arm.allowedModelEffortPairs.find(pair => pair.actor === actor && pair.model === model);
  const mapped = configured && actor.startsWith('advisor:') ? physicalModel.thinkingLevelMap?.[configured.effort] : undefined;
  const effort = typeof mapped === 'string' && mapped === wireEffort ? configured!.effort : wireEffort;
  return { model, effort, wireEffort, effortSource, actor, matchedPair: matchArmRequest(arm, model, effort, actor) ?? null };
}
const recordSchema = Type.Object({ type: Type.String(), id: Type.Number(), model: Type.String(), effort: Type.Union([Type.String(), Type.Null()]), actor: Type.Optional(Type.String()), usage: Type.Optional(Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() })), sessionId: Type.String(), stopReason: Type.Optional(Type.String()) });
type PiRequestRecord = Static<typeof recordSchema>;

/** Attribute from trusted system instructions and active tools, never user text or model names. */
export function requestActor(context: Context): string {
  const instructions = [context.systemPrompt ?? ''];
  const sections = new Map<string, string>();
  const tools = new Set(context.tools?.map(tool => tool.name));
  for (const message of context.messages) {
    if (message.role !== 'system') continue;
    instructions.push(itemText(message.content));
    for (const [name, text] of Object.entries(message.sections ?? {})) {
      if (text === null) sections.delete(name); else sections.set(name, text);
    }
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  const name = /You are advisor "([A-Za-z0-9_.-]+)" inside a multi-agent coding run\./.exec([...instructions, ...sections.values()].join('\n'))?.[1];
  return name && tools.has('advisor_verdict') ? `advisor:${name}` : 'non-advisor';
}

/** Observe the existing public runtime; leave authentication, provider execution and payloads untouched. */
export async function observedPiRuntime(traceFile: string, capture?: { systemDir: string }, arm: StudyArmMetadata = studyArmMetadata(buildStudyArm('C0'))) {
  const runtime = await ModelRuntime.create();
  const streamSimple = runtime.streamSimple.bind(runtime);
  let serial = 0;
  const pending = new Set<Promise<void>>(), seenCalls = new Set<string>();
  await writeFile(traceFile, '');
  if (capture) await mkdir(capture.systemDir, { recursive: true });
  runtime.streamSimple = (model, context, options) => {
    const id = ++serial;
    let actualModel = `${model.provider}/${model.id}`, effort: string | null = null;
    const actor = requestActor(context);
    let identity: ReturnType<typeof captureArmPayload> | undefined;
    const onPayload = options?.onPayload;
    const nativeFetch = options?.fetch ?? globalThis.fetch;
    const onResponse = options?.onResponse;
    const stream = streamSimple(model, context, {
      ...options,
      transport: 'sse',
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        appendFileSync(traceFile, JSON.stringify({ type: 'provider_endpoint', id, ...identity, actor, model: actualModel, effort, sessionId: options?.sessionId ?? `pi-request-${id}`, host: url.host, path: url.pathname }) + '\n');
        return nativeFetch(input, init);
      },
      onResponse: async (response, physicalModel) => {
        appendFileSync(traceFile, JSON.stringify({ type: 'provider_http', id, ...identity, actor, model: `${physicalModel.provider}/${physicalModel.id}`, effort, sessionId: options?.sessionId ?? `pi-request-${id}`, status: response.status }) + '\n');
        await onResponse?.(response, physicalModel);
      },
      onPayload: async (payload, physicalModel) => {
        const replacement = await onPayload?.(payload, physicalModel);
        const actual = replacement ?? payload;
        if (!Value.Check(payloadSchema, actual)) throw new Error('Pi payload capture cannot identify model/effort');
        identity = captureArmPayload(actual, physicalModel, arm, actor);
        actualModel = identity.model; effort = identity.effort;
        const wire = capture ? summarizePayloadSystem(actual) : null;
        if (capture && wire) { writeFileSync(join(capture.systemDir, `${wire.systemSha256}.txt`), wire.system); writeFileSync(join(capture.systemDir, `${wire.allSystemSha256}.txt`), wire.allSystem); }
        if (capture) for (const item of 'input' in actual && Array.isArray(actual.input) ? actual.input : []) {
          if (!item || typeof item !== 'object' || !('type' in item) || !('call_id' in item) || typeof item.call_id !== 'string' || seenCalls.has(`${item.type}:${item.call_id}`)) continue;
          if (item.type === 'function_call' && 'name' in item) { seenCalls.add(`${item.type}:${item.call_id}`); appendFileSync(join(capture.systemDir, '..', 'tool-calls.jsonl'), JSON.stringify({ kind: 'call', callId: item.call_id, name: item.name, arguments: 'arguments' in item ? String(item.arguments).slice(0, 2000) : '' }) + '\n'); }
          if (item.type === 'function_call_output') { seenCalls.add(`${item.type}:${item.call_id}`); appendFileSync(join(capture.systemDir, '..', 'tool-calls.jsonl'), JSON.stringify({ kind: 'output', callId: item.call_id, output: 'output' in item ? JSON.stringify(item.output).slice(0, 1500) : '' }) + '\n'); }
        }
        appendFileSync(traceFile, JSON.stringify({ type: 'provider_request', id, ...identity, sessionId: options?.sessionId ?? `pi-request-${id}`, ...(wire ? { system: { sha256: wire.systemSha256, chars: wire.systemChars, allSha256: wire.allSystemSha256, inputShape: wire.inputShape, toolNames: wire.toolNames, toolsSha256: wire.toolsSha256 } } : {}) }) + '\n');
        if (!identity.matchedPair) throw new Error(`Study arm ${arm.name} rejects ${actor} request ${actualModel}:${effort}`);
        return replacement;
      },
    });
    const observation = stream.result().then(message => {
      const toolCalls = capture ? message.content.flatMap(part => part.type === 'toolCall' ? [part.name] : []) : null;
      appendFileSync(traceFile, JSON.stringify({ type: 'provider_response', id, ...identity, actor, model: `${message.provider}/${message.model}`, effort, ...(message.stopReason === 'aborted' || message.stopReason === 'error' ? {} : { usage: message.usage }), stopReason: message.stopReason, sessionId: options?.sessionId ?? `pi-request-${id}`, ...(toolCalls ? { toolCalls } : {}) }) + '\n');
    }, error => { appendFileSync(traceFile, JSON.stringify({ type: 'provider_error', id, ...identity, actor, model: actualModel, effort, sessionId: options?.sessionId ?? `pi-request-${id}`, error: error instanceof Error ? error.name : 'Error' }) + '\n'); });
    pending.add(observation); void observation.finally(() => pending.delete(observation));
    return stream;
  };
  return { runtime, async drain() {
    const { promise, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error('Pi observation drain timeout')), 5000);
    try { await Promise.race([Promise.all([...pending]), promise]); } finally { clearTimeout(timer); }
  } };
}
export function extractPiRequestUsage(text: string, arm: StudyArmMetadata = studyArmMetadata(buildStudyArm('C0'))): RunnerUsage {
  const rows: PiRequestRecord[] = text.trim().split('\n').filter(Boolean).map(line => {
    const raw: unknown = JSON.parse(line);
    if (!Value.Check(recordSchema, raw)) throw new Error('Invalid Pi request capture record');
    return raw;
  });
  const sessions = new Map<string, SessionUsage>(), requestIds = new Map<number, PiRequestRecord>();
  const limitations: string[] = [], unknown: UnknownUsageRequest[] = [];
  let validModelEffort = true, knownUsageRequests = 0;
  for (const row of rows) {
    if (!matchArmRequest(arm, row.model, row.effort, row.actor)) validModelEffort = false;
    if (row.type === 'provider_request') {
      requestIds.set(row.id, row);
      const session: SessionUsage = sessions.get(row.sessionId) ?? { id: row.sessionId, source: 'Pi-public-runtime', requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: [], thinking: [] };
      session.requests++;
      if (!session.models.includes(row.model)) session.models.push(row.model);
      if (!session.thinking.includes(row.effort)) session.thinking.push(row.effort);
      sessions.set(row.sessionId, session);
    }
    if (row.type !== 'provider_response' && row.type !== 'provider_error') continue;
    requestIds.delete(row.id);
    if (!row.usage) {
      const reason = `Pi response usage unavailable (${row.stopReason ?? row.type})`;
      unknown.push({ requestId: String(row.id), sessionId: row.sessionId, purpose: 'Pi runtime request', reason });
      limitations.push(reason); continue;
    }
    const session = sessions.get(row.sessionId);
    if (!session) { limitations.push(`Pi response ${row.id} lacks request identity`); continue; }
    knownUsageRequests++; session.input += row.usage.input; session.output += row.usage.output; session.cacheRead += row.usage.cacheRead; session.cacheWrite += row.usage.cacheWrite;
  }
  for (const [id, row] of requestIds) {
    unknown.push({ requestId: String(id), sessionId: row.sessionId, purpose: 'Pi runtime request', reason: 'Response capture absent' });
    limitations.push(`Request ${id}: response capture absent`);
  }
  const values = [...sessions.values()], total: UsageTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const session of values) for (const key of Object.keys(total) as (keyof UsageTotals)[]) total[key] += session[key];
  return { ...total, sessions: values, sessionCount: values.length, models: [...new Set(values.flatMap(s => s.models))], thinking: [...new Set(values.flatMap(s => s.thinking))], complete: limitations.length === 0, limitations, validModelEffort, knownUsageRequests, unknownUsageRequests: { count: unknown.length, requests: unknown }, blockedRequests: { count: 0, requests: [] }, enforcedRequests: { count: 0, requests: [] } };
}

export async function runPiChild(options: PiRunnerOptions): Promise<RunnerResult> {
  await mkdir(options.outDir, { recursive: true });
  const traceFile = join(options.outDir, 'provider-requests.jsonl'), eventsFile = join(options.outDir, 'events.jsonl');
  const arm = buildStudyArm(options.arm ?? options.promptVariant ?? 'C0', options.baseModel), armMetadata = studyArmMetadata(arm);
  const variant = options.promptVariant === undefined && options.arm === undefined ? undefined : await loadPromptVariant(arm.promptVariant);
  if (variant) await writeFile(join(options.outDir, 'prompt-variant.json'), JSON.stringify({ name: variant.name, file: variant.file, sha256: variant.sha256, chars: variant.chars }, null, 2));
  const observed = await observedPiRuntime(traceFile, variant ? { systemDir: join(options.outDir, 'system-prompts') } : undefined, armMetadata);
  await writeFile(eventsFile, '');
  const startedAt = Date.now();
  const report = await runOrchestrated({ cwd: options.cwd, problem: options.instruction, routes: arm.routes, modelRuntime: observed.runtime, limits: { overallMs: options.timeoutSec * 1000 }, baseSystemPrompt: variant?.text, sink: event => appendFileSync(eventsFile, JSON.stringify(event) + '\n'), ...(options.recordsDir ? { records: directorySessionRecords(resolve(options.recordsDir)) } : {}) });
  await observed.drain();
  const finishedAt = Date.now();
  const usage = extractPiRequestUsage(await readFile(traceFile, 'utf8'), armMetadata);
  await writeFile(join(options.outDir, 'report.json'), JSON.stringify(report, null, 2));
  const status = report.status === 'done' && usage.validModelEffort ? 'done' : 'failed';
  return { status, answer: report.answer ?? report.summary, startedAt, finishedAt, exitCode: status === 'done' ? 0 : 1,
    ...(status === 'failed' ? { error: report.summary } : {}), usage, command: ['runOrchestrated', JSON.stringify({ routes: arm.routes, arm: armMetadata, limits: { overallMs: options.timeoutSec * 1000 }, ...(variant ? { promptVariant: variant.name, promptSha256: variant.sha256 } : {}) })], overlay: { ...arm.routes, arm: armMetadata } };
}

/** The outer process-group timeout also bounds uncooperative tools/disposal. */
export async function runPi(options: PiRunnerOptions): Promise<RunnerResult> {
  const outDir = resolve(options.outDir);
  const arm = buildStudyArm(options.arm ?? options.promptVariant ?? 'C0', options.baseModel), armMetadata = studyArmMetadata(arm);
  await mkdir(outDir, { recursive: true });
  const input = join(outDir, 'runner-input.json'), output = join(outDir, 'runner-result.json');
  await writeFile(input, JSON.stringify({ ...options, outDir }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const args = ['tsx', fileURLToPath(import.meta.url), '--child', input, '--result', output];
  const startedAt = Date.now();
  const processResult = await runProcess('npx', args, { cwd: root, timeoutMs: (options.timeoutSec + 30) * 1000, stdoutFile: join(outDir, 'stdout.txt'), stderrFile: join(outDir, 'stderr.txt') });
  try {
    const raw: unknown = JSON.parse(await readFile(output, 'utf8'));
    if (!Value.Check(runnerResultSchema, raw)) throw new Error('Malformed Pi child result');
    return { ...raw, startedAt, finishedAt: Date.now(), command: ['npx', ...args, JSON.stringify({ arm: armMetadata })] };
  } catch (error) {
    let usage: RunnerUsage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: [], sessionCount: 0, models: [], thinking: [], complete: false, limitations: ['Pi child did not return a final result'], validModelEffort: false, knownUsageRequests: 0, unknownUsageRequests: { count: 0, requests: [] }, blockedRequests: { count: 0, requests: [] }, enforcedRequests: { count: 0, requests: [] } };
    try { usage = extractPiRequestUsage(await readFile(join(outDir, 'provider-requests.jsonl'), 'utf8'), armMetadata); } catch { /* Explicit partial usage remains. */ }
    return { status: processResult.timedOut ? 'timeout' : 'failed', answer: '', startedAt, finishedAt: Date.now(), exitCode: processResult.exitCode, error: processResult.stderr || (error instanceof Error ? error.message : String(error)), usage, command: ['npx', ...args, JSON.stringify({ arm: armMetadata })], overlay: { ...arm.routes, arm: armMetadata } };
  }
}

export async function probePi(options: RunnerOptions): Promise<RunnerResult> {
  await mkdir(options.outDir, { recursive: true });
  const traceFile = join(options.outDir, 'provider-requests.jsonl');
  const observed = await observedPiRuntime(traceFile);
  const startedAt = Date.now();
  const session = await createSession({ cwd: options.cwd, route: { role: 'probe', model: piModel, thinking: 'high' }, modelRuntime: observed.runtime, tools: [], instructions: 'Reply to the user directly.' });
  const timer = setTimeout(() => { void session.abort(); }, options.timeoutSec * 1000);
  try {
    await session.prompt(options.instruction);
    await observed.drain();
    await writeFile(join(options.outDir, 'transcript.json'), JSON.stringify(session.messages, null, 2));
    const last = [...session.messages].reverse().find(message => message.role === 'assistant');
    const answer = last?.role === 'assistant' ? last.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
    const usage = extractPiRequestUsage(await readFile(traceFile, 'utf8'));
    return { status: usage.complete && usage.validModelEffort && answer ? 'done' : 'failed', answer, startedAt, finishedAt: Date.now(), exitCode: 0, usage, command: ['createSession', 'openai/gpt-6.1-sol:high', 'prompt'] };
  } finally { clearTimeout(timer); await session.abort(); session.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const inputPath = args[args.indexOf('--child') + 1], resultPath = args[args.indexOf('--result') + 1];
  const schema = Type.Object({ cwd: Type.String(), instruction: Type.String(), outDir: Type.String(), timeoutSec: Type.Number({ exclusiveMinimum: 0 }), promptVariant: Type.Optional(Type.String()), arm: Type.Optional(Type.String()), baseModel: Type.Optional(Type.String()), recordsDir: Type.Optional(Type.String()) });
  const raw: unknown = JSON.parse(await readFile(inputPath!, 'utf8'));
  if (!Value.Check(schema, raw) || !resultPath) throw new Error('Invalid Pi child invocation');
  await writeFile(resultPath, JSON.stringify(await runPiChild(raw), null, 2));
}
