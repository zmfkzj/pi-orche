import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { prepareOmpOverlay } from './omp-overlay.js';

const usageSchema = Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() });
// omp persists injected system notices and worker messages as plain text, not only content parts.
const messageSchema = Type.Object({
  role: Type.Optional(Type.String()), provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  stopReason: Type.Optional(Type.String()), errorMessage: Type.Optional(Type.String()),
  usage: Type.Optional(usageSchema), content: Type.Optional(Type.Union([Type.String(), Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) }))])),
});
const rowSchema = Type.Object({
  type: Type.String(), id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  thinkingLevel: Type.Optional(Type.Union([Type.String(), Type.Null()])), message: Type.Optional(messageSchema),
  usage: Type.Optional(Type.Union([usageSchema, Type.Null()])), provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  effort: Type.Optional(Type.Union([Type.String(), Type.Null()])), sessionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  reason: Type.Optional(Type.String()), status: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])), pending: Type.Optional(Type.Number()),
  purpose: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
  host: Type.Optional(Type.String()), path: Type.Optional(Type.String()),
  originalEffort: Type.Optional(Type.Union([Type.String(), Type.Null()])), enforced: Type.Optional(Type.Boolean()),
});
const wireRowSchema = Type.Composite([Type.Omit(rowSchema, ['message']), Type.Object({ message: Type.Optional(Type.Union([messageSchema, Type.String()])) })]);
export type OmpRecord = Static<typeof rowSchema>;

export interface UsageTotals { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface SessionUsage extends UsageTotals { id: string; source: string; models: string[]; thinking: (string | null)[] }
export interface UnknownUsageRequest { requestId: string; sessionId: string | null; purpose: string; reason: string }
export interface EnforcedRequest { requestId: string; sessionId: string | null; purpose: string; originalEffort: string | null; enforcedEffort: 'high' }
export interface RunnerUsage extends UsageTotals { sessions: SessionUsage[]; sessionCount: number; models: string[]; thinking: (string | null)[]; complete: boolean; limitations: string[]; validModelEffort: boolean; knownUsageRequests: number; unknownUsageRequests: { count: number; requests: UnknownUsageRequest[] }; blockedRequests: { count: number; requests: UnknownUsageRequest[] }; enforcedRequests: { count: number; requests: EnforcedRequest[] } }
export const runnerUsageSchema = Type.Object({
  requests: Type.Number(), input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(),
  sessionCount: Type.Number(), complete: Type.Boolean(), validModelEffort: Type.Boolean(),
  limitations: Type.Array(Type.String()), models: Type.Array(Type.String()), thinking: Type.Array(Type.Union([Type.String(), Type.Null()])),
  sessions: Type.Array(Type.Object({ id: Type.String(), source: Type.String(), requests: Type.Number(), input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), models: Type.Array(Type.String()), thinking: Type.Array(Type.Union([Type.String(), Type.Null()])) })),
  knownUsageRequests: Type.Number(), unknownUsageRequests: Type.Object({ count: Type.Number(), requests: Type.Array(Type.Object({ requestId: Type.String(), sessionId: Type.Union([Type.String(), Type.Null()]), purpose: Type.String(), reason: Type.String() })) }),
  blockedRequests: Type.Object({ count: Type.Number(), requests: Type.Array(Type.Object({ requestId: Type.String(), sessionId: Type.Union([Type.String(), Type.Null()]), purpose: Type.String(), reason: Type.String() })) }),
  enforcedRequests: Type.Object({ count: Type.Number(), requests: Type.Array(Type.Object({ requestId: Type.String(), sessionId: Type.Union([Type.String(), Type.Null()]), purpose: Type.String(), originalEffort: Type.Union([Type.String(), Type.Null()]), enforcedEffort: Type.Literal('high') })) }),
});
export const runnerResultSchema = Type.Object({ status: Type.Union([Type.Literal('done'), Type.Literal('failed'), Type.Literal('timeout')]), answer: Type.String(), startedAt: Type.Number(), finishedAt: Type.Number(), exitCode: Type.Union([Type.Number(), Type.Null()]), error: Type.Optional(Type.String()), usage: runnerUsageSchema, command: Type.Array(Type.String()), overlay: Type.Optional(Type.Unknown()), evidence: Type.Optional(Type.Unknown()) });
export interface RunnerOptions { cwd: string; instruction: string; outDir: string; timeoutSec: number }
export interface RunnerResult { status: 'done' | 'failed' | 'timeout'; answer: string; startedAt: number; finishedAt: number; exitCode: number | null; error?: string; usage: RunnerUsage; command: string[]; overlay?: unknown; evidence?: unknown }
export interface ProcessResult { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }
export const ompModel = 'openai-codex/gpt-6.1-sol';
const omp = '/home/arthur/.bun/bin/omp';
const roles = ['default','task','smol','slow','plan','advisor','orche-advisor','verification-auditor','vision','commit','tiny','memory','image','web','speech','dictation','judge'];
const empty = (): UsageTotals => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Bounded process group, streaming full artifacts while keeping only small diagnostic tails in memory. */
export async function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number; stdoutFile?: string; stderrFile?: string; env?: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ['ignore','pipe','pipe'] });
  let outputError: Error | undefined;
  const openOutput = (path?: string) => {
    if (!path) return undefined;
    const stream = createWriteStream(path);
    stream.on('error', error => { outputError ??= error; });
    return stream;
  };
  const stdoutFile = openOutput(options.stdoutFile), stderrFile = openOutput(options.stderrFile);
  let stdout = '', stderr = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, options.timeoutMs);
  child.stdout.on('data', chunk => { if (stdoutFile && !outputError && !stdoutFile.destroyed) stdoutFile.write(chunk); stdout = (stdout + String(chunk)).slice(-256_000); });
  child.stderr.on('data', chunk => { if (stderrFile && !outputError && !stderrFile.destroyed) stderrFile.write(chunk); stderr = (stderr + String(chunk)).slice(-256_000); });
  const { promise, resolve: finish } = Promise.withResolvers<ProcessResult>();
  child.once('error', error => finish({ exitCode: null, signal: null, timedOut, stdout, stderr: error.message }));
  child.once('close', (exitCode, signal) => finish({ exitCode, signal, timedOut, stdout, stderr }));
  const result = await promise;
  clearTimeout(timer);
  await Promise.all([stdoutFile, stderrFile].map(async stream => {
    if (!stream) return;
    stream.end();
    await finished(stream).catch(error => { outputError ??= error; });
  }));
  if (outputError) throw outputError;
  return result;
}
export async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path)); else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
export function parseJsonLines(text: string): OmpRecord[] {
  const records: OmpRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Malformed JSON event/session record: invalid JSON'); }
    if (!Value.Check(wireRowSchema, value)) throw new Error('Malformed JSON event/session record: ' + JSON.stringify([...Value.Errors(wireRowSchema, value)]));
    // Omp emits startup/auth diagnostic notices as top-level message strings. Preserve them, never count as assistant usage.
    if (typeof value.message === 'string') value = { ...value, message: { role: 'diagnostic', content: value.message } };
    if (!Value.Check(rowSchema, value)) throw new Error('Malformed normalized JSON event/session record');
    records.push(value);
  }
  return records;
}
/** Pi and omp share this environment key; a Pi private overlay must NEVER become omp's credential/catalog directory. */
export function ompEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...input };
  delete env.PI_CODING_AGENT_DIR; delete env.PI_CODING_AGENT_SESSION_DIR;
  return env;
}
export function assistantCompleted(message?: { role?: string; stopReason?: string }): boolean {
  return message?.role === 'assistant' && !['error','aborted'].includes(message.stopReason ?? '');
}
export async function globalOmpSnapshot(env = ompEnvironment()) {
  const files = [];
  for (const path of [join(homedir(), '.omp/agent/config.yml'), join(homedir(), '.omp/plugins/omp-plugins.lock.json'), join(homedir(), '.omp/plugins/package.json')]) {
    try { const info = await stat(path); files.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), mtimeMs: info.mtimeMs }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files.push({ path, absent: true }); }
  }
  const inventory = await runProcess(omp, ['plugin','list','--json'], { cwd: homedir(), timeoutMs: 30_000, env });
  if (inventory.exitCode !== 0) throw new Error('Cannot snapshot plugin inventory: ' + inventory.stderr);
  const code = `import sqlite3,hashlib,json,os\nc=sqlite3.connect('file:'+os.path.expanduser('~/.omp/agent/agent.db')+'?mode=ro',uri=True)\nrows=c.execute('SELECT id,provider,credential_type,data,disabled_cause FROM auth_credentials ORDER BY id').fetchall()\nprint(hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest())`;
  const credentials = await runProcess('python3', ['-c',code], { cwd: homedir(), timeoutMs: 10_000, env });
  if (credentials.exitCode !== 0) throw new Error('Cannot read-only snapshot global omp credential state');
  return { files, plugins: JSON.parse(inventory.stdout) as unknown, credentialSha256: credentials.stdout.trim() };
}

/** Persisted assistant messages and side-call model_usage entries; never count repeated event projections. */
export function extractOmpSessionUsage(id: string, rows: readonly OmpRecord[]): SessionUsage {
  const total: SessionUsage = { ...empty(), id, source: 'session-jsonl', models: [], thinking: [] };
  let thinking: string | null = null;
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.type === 'thinking_level_change') thinking = row.thinkingLevel ?? null;
    const message = row.type === 'message' ? row.message : row.type === 'model_usage' ? row : undefined;
    if (!message || (row.type === 'message' && row.message?.role !== 'assistant')) continue;
    const key = row.id;
    if (typeof key === 'string' && seen.has(key)) continue;
    if (typeof key === 'string') seen.add(key);
    const usage = message.usage;
    if (!usage) continue;
    total.requests++; total.input += usage.input ?? 0; total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0; total.cacheWrite += usage.cacheWrite ?? 0;
    const model = `${message.provider}/${message.model}`;
    if (!total.models.includes(model)) total.models.push(model);
    if (!total.thinking.includes(thinking)) total.thinking.push(thinking);
  }
  return total;
}

/** Provider-boundary capture also includes plugin calls that never create a saved AgentSession. */
export function extractOmpProviderUsage(rows: readonly OmpRecord[]): RunnerUsage {
  const sessions = new Map<string, SessionUsage>();
  const requests = new Map<number, OmpRecord>();
  const enforced: EnforcedRequest[] = [];
  const limitations: string[] = [], unknown: UnknownUsageRequest[] = [], blocked: UnknownUsageRequest[] = [];
  const blockedIds = new Set<number>();
  for (const row of rows) if (row.type === 'provider_blocked' && typeof row.id === 'number') blockedIds.add(row.id);
  let validModelEffort = true, knownUsageRequests = 0;
  for (const row of rows) {
    if (row.type === 'provider_request') {
      if (typeof row.id !== 'number') { limitations.push('Provider request lacks numeric identity'); continue; }
      if (row.model !== 'gpt-6.1-sol' || row.effort !== 'high') validModelEffort = false;
      if (blockedIds.has(row.id)) {
        blocked.push({ requestId: String(row.id), sessionId: row.sessionId ?? null, purpose: row.purpose ?? 'unidentified blocked attempt', reason: 'Model/effort guard rejected before network dispatch' });
        continue;
      }
      requests.set(row.id, row);
      if (row.enforced) enforced.push({ requestId: String(row.id), sessionId: row.sessionId ?? null, purpose: row.purpose ?? 'unidentified enforced call', originalEffort: row.originalEffort ?? null, enforcedEffort: 'high' });
      const id = row.sessionId ?? `unscoped-request-${row.id}`;
      if (!row.sessionId) limitations.push(`Request ${row.id}: missing transport session identity`);
      const session: SessionUsage = sessions.get(id) ?? { ...empty(), id, source: 'provider-boundary', models: [], thinking: [] };
      session.requests++;
      const model = `openai-codex/${row.model}`, effort = row.effort ?? null;
      if (!session.models.includes(model)) session.models.push(model);
      if (!session.thinking.includes(effort)) session.thinking.push(effort);
      sessions.set(id, session);
    }
    if (row.type === 'provider_blocked') validModelEffort = false;
    if (row.type === 'trace_failure') { limitations.push(row.reason ?? 'Provider capture failure'); validModelEffort = false; }
    if (row.type !== 'provider_response') continue;
    const responseId = typeof row.id === 'number' ? row.id : -1;
    if (blockedIds.has(responseId)) continue;
    const request = requests.get(responseId);
    if (!request) { limitations.push(`Response ${row.id} has no request record`); continue; }
    requests.delete(responseId);
    if (!row.usage) {
      const reason = `No final provider usage (HTTP ${row.status ?? 'error'}, ${row.error ?? 'no usage event'})`;
      unknown.push({ requestId: String(responseId), sessionId: request.sessionId ?? null, purpose: request.purpose ?? 'unidentified side call', reason });
      limitations.push(`Request ${responseId}: ${reason}`);
      continue;
    }
    const session = sessions.get(request.sessionId ?? `unscoped-request-${responseId}`)!;
    knownUsageRequests++; session.input += row.usage.input; session.output += row.usage.output;
    session.cacheRead += row.usage.cacheRead; session.cacheWrite += row.usage.cacheWrite;
  }
  for (const [id, request] of requests) {
    unknown.push({ requestId: String(id), sessionId: request.sessionId ?? null, purpose: request.purpose ?? 'unidentified side call', reason: 'Response capture did not settle' });
    limitations.push(`Request ${id}: response capture did not settle`);
  }
  if (!rows.some(row => row.type === 'trace_end' && row.pending === 0)) limitations.push('No fully drained provider capture shutdown marker');
  const values = [...sessions.values()], total = empty();
  for (const session of values) for (const key of Object.keys(total) as (keyof UsageTotals)[]) total[key] += session[key];
  return { ...total, sessions: values, sessionCount: values.length, models: [...new Set(values.flatMap(s => s.models))], thinking: [...new Set(values.flatMap(s => s.thinking))], complete: limitations.length === 0, limitations: [...new Set(limitations)], validModelEffort, knownUsageRequests, unknownUsageRequests: { count: unknown.length, requests: unknown }, blockedRequests: { count: blocked.length, requests: blocked }, enforcedRequests: { count: enforced.length, requests: enforced } };
}

// Process-local capture plus explicit all-high enforcement. No credentials or prompt/response text are logged.
// SSE is selected via the host's documented PI_CODEX_WEBSOCKET switch so every provider call uses fetch.
export const ompTracePreload = String.raw`
import { appendFileSync } from 'node:fs';
const target=process.env.COMPARE_TRACE_FILE;
const emit=value=>appendFileSync(target,JSON.stringify({...value,timestamp:Date.now()})+'\n');
const nativeFetch=globalThis.fetch,originalFetch=nativeFetch.bind(globalThis),pending=new Set();let serial=0;
async function decode(input,init){
  const headers=new Headers(init?.headers ?? (input instanceof Request?input.headers:undefined));
  let body=init?.body;
  if(body===undefined&&input instanceof Request)body=new Uint8Array(await input.clone().arrayBuffer());
  if(body instanceof Uint8Array||body instanceof ArrayBuffer){
    let bytes=body instanceof Uint8Array?body:new Uint8Array(body);
    if(headers.get('content-encoding')==='zstd')bytes=Bun.zstdDecompressSync(bytes);
    body=new TextDecoder().decode(bytes);
  }
  if(typeof body!=='string'||!body.trim())return null;
  return {body:JSON.parse(body),headers};
}
function purpose(body){
  const instructions=typeof body.instructions==='string'?body.instructions:'';
  if(instructions.includes('Act as Verification Auditor.'))return 'verification-auditor';
  if(instructions.includes('You are Orche-Advisor'))return 'orche-advisor';
  if(instructions.includes('Label the delegated work in the next user message:'))return 'task-label/title';
  return 'unidentified (transport session id retained)';
}
function usage(raw){const cached=raw.input_tokens_details?.cached_tokens ?? 0;return {input:Math.max(0,(raw.input_tokens ?? 0)-cached),output:raw.output_tokens ?? 0,cacheRead:cached,cacheWrite:raw.input_tokens_details?.cache_write_tokens ?? 0};}
async function observe(response,id){
  let captured=null;const toolCalls=new Set();
  try{
    const reader=response.body.getReader(),decoder=new TextDecoder();
    let buffer='',json='',sawEvents=false;
    function line(value){
      const text=value.trim();if(!text)return;
      const data=text.startsWith('data:')?text.slice(5).trim():text;
      if(text.startsWith('data:')||text.startsWith('event:'))sawEvents=true;
      if(text.startsWith('event:')||data==='[DONE]')return;
      try{const event=JSON.parse(data);const raw=event.response?.usage ?? event.usage;if(raw)captured=usage(raw);for(const item of [event.item,...(event.response?.output??[])])if(['function_call','custom_tool_call'].includes(item?.type)&&item.name)toolCalls.add(item.name);}
      catch{if(!sawEvents)json+=value+'\n';}
    }
    while(true){
      const {done,value}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      let end;while((end=buffer.indexOf('\n'))>=0){line(buffer.slice(0,end));buffer=buffer.slice(end+1);}
    }
    line(buffer);
    if(!captured&&!sawEvents&&json.trim()){const value=JSON.parse(json);if(value.usage)captured=usage(value.usage);}
    emit({type:'provider_response',id,status:response.status,contentType:response.headers.get('content-type'),usage:captured,toolCalls:[...toolCalls]});
  }catch(error){emit({type:'provider_response',id,status:response.status,usage:captured,error:error.name});}
}
globalThis.fetch=Object.assign(async(input,init)=>{
  const url=String(input instanceof Request?input.url:input);
  let decoded;
  try{decoded=await decode(input,init);}catch{
    if(/responses|chat\/completions|messages|generateContent/.test(url)){
      emit({type:'trace_failure',reason:'Cannot decode model request payload'});
      throw new Error('Comparison capture cannot decode model request');
    }
  }
  if(!decoded?.body?.model)return originalFetch(input,init);
  const body=decoded.body,id=++serial,originalEffort=body.reasoning?.effort ?? null;
  const endpoint=new URL(url);
  const declared=[...(body.tools??[]),...(body.input??[]).flatMap(item=>item.type==='additional_tools'?(item.tools??[]):[])];
  const record={type:'provider_request',id,model:body.model,effort:originalEffort,originalEffort,enforced:false,sessionId:decoded.headers.get('session_id') ?? decoded.headers.get('x-session-id') ?? body.prompt_cache_key ?? 'process-main',purpose:purpose(body),host:endpoint.host,path:endpoint.pathname,url:endpoint.origin+endpoint.pathname,toolNames:[...new Set(declared.map(tool=>tool.name??tool.function?.name).filter(Boolean))],toolCalls:(body.input??[]).filter(item=>['function_call','custom_tool_call'].includes(item.type)).map(item=>item.name)};
  if(endpoint.host!=='chatgpt.com'||endpoint.pathname!=='/backend-api/codex/responses'){emit(record);emit({type:'provider_blocked',id,reason:'Non Codex endpoint blocked'});throw new Error('Comparison requires Codex endpoint');}
  if(record.model!=='gpt-6.1-sol'){
    emit(record);emit({type:'provider_blocked',id,reason:'Non gpt-6.1-sol model blocked'});
    throw new Error('Comparison requires gpt-6.1-sol for every request');
  }
  let forwarded=init;
  if(originalEffort!=='high'){
    const signed=['content-md5','digest','content-digest','signature','signature-input','x-body-sha256','x-amz-content-sha256'].some(name=>decoded.headers.has(name));
    if(signed||(body.reasoning!=null&&(typeof body.reasoning!=='object'||Array.isArray(body.reasoning)))){
      emit(record);emit({type:'provider_blocked',id,reason:'Unsafe reasoning rewrite (signed payload or unknown reasoning shape)'});
      emit({type:'trace_failure',reason:'Unsafe request rewrite; comparison stopped'});
      process.exit(78);throw new Error('Unsafe comparison request rewrite');
    }
    try{
      body.reasoning={...(body.reasoning??{}),effort:'high'};
      const json=JSON.stringify(body),headers=new Headers(decoded.headers);
      headers.delete('content-length');
      const encoded=headers.get('content-encoding')==='zstd'?Bun.zstdCompressSync(new TextEncoder().encode(json)):json;
      forwarded={...init,headers,body:encoded};
      record.effort='high';record.enforced=true;
    }catch{
      emit(record);emit({type:'provider_blocked',id,reason:'Reasoning rewrite or recompression failed'});
      emit({type:'trace_failure',reason:'Request rewrite failed; comparison stopped'});
      process.exit(78);throw new Error('Comparison request rewrite failed');
    }
  }
  emit(record);
  try{
    const response=await originalFetch(input,forwarded),job=observe(response.clone(),id);
    pending.add(job);job.finally(()=>pending.delete(job));
    return response;
  }catch(error){emit({type:'provider_response',id,status:null,usage:null,error:error.name});throw error;}
},nativeFetch.preconnect?{preconnect:nativeFetch.preconnect}:{});
const originalExit=process.exit.bind(process);let exiting=false;process.exit=code=>{if(exiting)return;exiting=true;Promise.race([Promise.allSettled([...pending]),new Promise(resolve=>setTimeout(resolve,3000))]).finally(()=>{emit({type:'trace_end',pending:pending.size});originalExit(code);});};
process.on('beforeExit',()=>{if(!exiting){exiting=true;emit({type:'trace_end',pending:pending.size});}});
emit({type:'trace_started',transport:'sse',policy:'gpt-6.1-sol:high'});
`;

export async function runOmp(options: RunnerOptions): Promise<RunnerResult> {
  await mkdir(options.outDir, { recursive: true });
  const out = resolve(options.outDir), sessionDir = join(out, 'sessions');
  await mkdir(sessionDir, { recursive: true });
  const privateOverlay = await prepareOmpOverlay();
  const env = { ...ompEnvironment(), PI_CODING_AGENT_DIR: privateOverlay.dir };
  try {
  const before = await globalOmpSnapshot(env);
  const configured = await runProcess(omp, ['config','get','modelRoles','--json'], { cwd: options.cwd, timeoutMs: 30_000, env });
  if (configured.exitCode !== 0) throw new Error('Cannot read model role names');
  const configuredRoles: unknown = JSON.parse(configured.stdout);
  if (!configuredRoles || typeof configuredRoles !== 'object' || !('value' in configuredRoles) || !configuredRoles.value || typeof configuredRoles.value !== 'object') throw new Error('Malformed model role configuration');
  const names = [...new Set([...roles, ...Object.keys(configuredRoles.value)])];
  const overlay = { defaultThinkingLevel: 'high', modelRoles: Object.fromEntries(names.map(role => [role, `${ompModel}:high`])), retry: { modelFallback: false, fallbackChains: Object.fromEntries(names.map(role => [role, []])) } };
  const overlayPath = join(out, 'overlay.json'), preloadPath = join(out, 'provider-observer.mjs');
  const overrides = { disabled: ['omp-daybreak-delegate'], settings: { 'om-orche': { enabled: true, telemetryEnabled: false } } };
  await mkdir(join(options.cwd, '.omp'), { recursive: true });
  await writeFile(join(options.cwd, '.omp/plugin-overrides.json'), JSON.stringify(overrides, null, 2));
  await appendFile(join(options.cwd, '.git/info/exclude'), '\n/.omp/plugin-overrides.json\n');
  const inspectionCode = 'import {getEnabledPlugins,getPluginSettings} from \"/home/arthur/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/plugins/loader.ts\"; const settings=await getPluginSettings(\"om-orche\",process.cwd()); console.log(JSON.stringify({plugins:(await getEnabledPlugins(process.cwd())).map(p=>p.name),omOrcheEnabled:settings.enabled,telemetryEnabled:settings.telemetryEnabled}));';
  const inspection = await runProcess('bun', ['--eval', inspectionCode], { cwd: options.cwd, timeoutMs: 30_000, env });
  const activePlugins: unknown = JSON.parse(inspection.stdout);
  const inspectionSchema = Type.Object({ plugins: Type.Array(Type.String()), omOrcheEnabled: Type.Boolean(), telemetryEnabled: Type.Boolean() });
  if (inspection.exitCode !== 0 || !Value.Check(inspectionSchema, activePlugins) || activePlugins.plugins.includes('omp-daybreak-delegate') || !activePlugins.plugins.includes('om-orche') || !activePlugins.omOrcheEnabled || activePlugins.telemetryEnabled) throw new Error('Per-run plugin isolation inspection failed');
  await writeFile(join(out, 'active-plugins.json'), JSON.stringify(activePlugins, null, 2));
  await writeFile(overlayPath, JSON.stringify(overlay, null, 2)); await writeFile(preloadPath, ompTracePreload);
  const tracePath = join(out, 'provider-requests.jsonl');
  await writeFile(tracePath, '');
  const args = ['--preload', preloadPath, omp, '-p', options.instruction, '--cwd', options.cwd, '--model', ompModel, '--thinking', 'high', '--config', overlayPath, '--session-dir', sessionDir, '--no-title', '--approval-mode', 'yolo', '--mode', 'json', '--max-time', String(options.timeoutSec)];
  const startedAt = Date.now();
  const processResult = await runProcess('bun', args, { cwd: options.cwd, timeoutMs: (options.timeoutSec + 30) * 1000, stdoutFile: join(out, 'events.jsonl'), stderrFile: join(out, 'stderr.txt'), env: { ...env, PI_CODEX_WEBSOCKET: '0', COMPARE_TRACE_FILE: tracePath } });
  const finishedAt = Date.now();
  const after = await globalOmpSnapshot(env);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const rows = parseJsonLines(await readFile(tracePath, 'utf8'));
  const usage = extractOmpProviderUsage(rows);
  const sessions = [];
  for (const file of await listFiles(sessionDir)) if (file.endsWith('.jsonl')) {
    const entries = parseJsonLines(await readFile(file, 'utf8'));
    if (!entries.some(e => e.type === 'session')) continue;
    sessions.push({ file, header: entries.find(e => e.type === 'session'), usage: extractOmpSessionUsage(file, entries) });
  }
  const events = parseJsonLines(await readFile(join(out, 'events.jsonl'), 'utf8'));
  const final = [...events].reverse().find(event => event.type === 'message_end' && event.message?.role === 'assistant');
  const content = final?.message?.content ?? [];
  const answer = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
  const completedAssistant = assistantCompleted(final?.message);
  const status = processResult.timedOut ? 'timeout' : processResult.exitCode === 0 && unchanged && usage.validModelEffort && completedAssistant ? 'done' : 'failed';
  const error = !unchanged ? 'Global omp config/plugin/credential state changed' : !usage.validModelEffort ? 'Model/effort constraint violation' : processResult.exitCode !== 0 ? `omp exit ${processResult.exitCode}: ${processResult.stderr}` : !completedAssistant ? final?.message?.errorMessage ?? 'omp has no completed assistant response' : undefined;
  const evidence = { before, after, globalStateUnchanged: unchanged, credentialOverlay: privateOverlay.publicEvidence, projectOverrides: overrides, activePlugins, persistedSessions: sessions, providerCapture: 'Process-local fetch observer; SSE forced; model/effort violations blocked and invalidate run. Known tokens + explicitly counted unknown-usage requests.' };
  await writeFile(join(out, 'isolation.json'), JSON.stringify(evidence, null, 2));
  return { status, answer, startedAt, finishedAt, exitCode: processResult.exitCode, ...(error ? { error } : {}), usage, command: ['bun', ...args], overlay, evidence };
  } finally { await privateOverlay.cleanup(); }
}
