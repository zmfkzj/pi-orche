import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ompTracePreload, runProcess, parseJsonLines, extractOmpProviderUsage, assistantCompleted, type RunnerOptions, type RunnerResult } from './omp-runner.js';
import { preparePiOverlay } from './pi-overlay.js';
import { writeParityArtifact } from './parity.js';
import { benchmarkModel } from './systems.js';

/** Full Pi product main session, native prompt/default tools. Only -e distinguishes the two arms. */
export async function runPiMain(options: RunnerOptions & { orchestration: boolean; baseModel?: string }): Promise<RunnerResult> {
  if ((options.baseModel ?? benchmarkModel) !== benchmarkModel) throw new Error('Pi main benchmark requires openai-codex/gpt-6.1-sol, no fallbacks');
  const out = resolve(options.outDir);
  await mkdir(out, { recursive: true });
  const overlay = await preparePiOverlay(options.timeoutSec);
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const preload = join(out, 'provider-observer.mjs'), trace = join(out, 'provider-requests.jsonl');
    const runtimeUrl = new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js', import.meta.url).href;
    // Import the HTTP dispatcher before capture: later CLI setup must preserve our deliberate fetch override. The public runtime fetch option is the provider boundary.
    const dispatcherUrl = new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js', import.meta.url).href;
    const piTransportCapture = `\nimport ${JSON.stringify(dispatcherUrl)};\nimport { zstdDecompressSync, zstdCompressSync } from 'node:zlib';\nimport { ModelRuntime } from ${JSON.stringify(runtimeUrl)};\nfor(const method of ['streamSimple','stream']){const original=ModelRuntime.prototype[method];ModelRuntime.prototype[method]=function(model,context,options){return original.call(this,model,context,{...options,transport:'sse',fetch:globalThis.fetch});};}\n`; 
    await writeFile(preload, ompTracePreload.replaceAll('Bun.zstdDecompressSync', 'zstdDecompressSync').replaceAll('Bun.zstdCompressSync', 'zstdCompressSync') + piTransportCapture);
    await writeFile(trace, '');
    const args = ['--import', preload, join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--print', '--mode', 'json', '--provider', 'openai-codex', '--model', 'gpt-6.1-sol', '--thinking', 'high', '--session-dir', join(out, 'sessions'), '--offline', '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', ...(options.orchestration ? ['--extension', join(root, 'src/extension/index.ts')] : []), '--', options.instruction];
    const publicOverlay = { settings: overlay.settings, orche: options.orchestration ? overlay.config : null, credentialSource: overlay.credentialSource, invocation: 'Pi CLI main session; default system prompt; default tools; discovered resources disabled for isolation' };
    await writeFile(join(out, 'overlay.json'), JSON.stringify(publicOverlay, null, 2));
    const startedAt = Date.now();
    const child = await runProcess('node', args, { cwd: options.cwd, timeoutMs: options.timeoutSec * 1000, stdoutFile: join(out, 'events.jsonl'), stderrFile: join(out, 'stderr.txt'), env: { ...process.env, PI_CODING_AGENT_DIR: overlay.dir, PI_CODEX_WEBSOCKET: '0', PI_OFFLINE: '1', COMPARE_TRACE_FILE: trace } });
    const finishedAt = Date.now();
    const usage = extractOmpProviderUsage(parseJsonLines(await readFile(trace, 'utf8')));
    const parity = await writeParityArtifact(out, !options.orchestration);
    usage.validModelEffort &&= parity.passed;
    const events = parseJsonLines(await readFile(join(out, 'events.jsonl'), 'utf8'));
    const final = [...events].reverse().find(event => event.type === 'message_end' && event.message?.role === 'assistant');
    const content = final?.message?.content;
    const answer = typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
    const failedAssistant = !assistantCompleted(final?.message);
    const status = child.timedOut ? 'timeout' : child.exitCode === 0 && !failedAssistant && usage.validModelEffort ? 'done' : 'failed';
    const error = status === 'done' ? undefined : child.timedOut ? 'Pi main fixed task deadline expired' : !parity.passed ? 'Provider parity constraint violation: ' + parity.violations.join('; ') : failedAssistant ? final?.message?.errorMessage ?? 'Pi main has no completed assistant response' : child.stderr;
    return { status, answer, startedAt, finishedAt, exitCode: child.exitCode, ...(error ? { error } : {}), usage, command: ['node', ...args], overlay: publicOverlay, evidence: parity };
  } finally { await overlay.cleanup(); }
}
