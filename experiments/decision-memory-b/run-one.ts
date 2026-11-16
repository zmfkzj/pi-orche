/**
 * One run (instance × arm) of the combination-B re-evaluation, in its own process started by driver.ts with a private
 * PI_CODING_AGENT_DIR, HOME, TMPDIR and XDG dirs below the run's temp dir. Adapted from experiments/decision-memory-ab/run-one.ts:
 * the same real WorkerPool path (orche_task implement worker, single mode), the study's frozen orche runtime.
 *
 *   node --import tsx <study>/frozen/experiments/decision-memory-b/run-one.ts <input.json>
 *
 * Writes <out>/meta.json (config, model check, assignment, grade, final report claims, transcript and evidence analyses, compaction
 * events), <out>/records/ (orche's records) and <out>/workspace-final/src.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { OrcheController } from "../../src/extension/controller.js";
import { loadOrcheConfigFile } from "../../src/extension/config.js";
import { TaskFailedError, WorkerPool } from "../../src/extension/workers.js";
import { analyzeTranscript } from "../decision-memory-ab/analyze.js";
import { analyzeEvidence } from "./evidence.js";
import { startFeed } from "./feed.js";
import { finalReport, fixtureDigest, generate, grade, instance, request, writeFiles } from "./project.js";
import { ARM_CONFIG, LIMITS, MODELS, WINDOW_TOKENS, type Arm, type ModelKey } from "./protocol.js";

export interface RunInput { out: string; seed: number; arm: Arm; temp: string; providerDir: string; phase: string; model?: ModelKey }

const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
function filesBelow(dir: string, test: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(path, test) : test(path) ? [path] : [];
  });
}

async function main(input: RunInput) {
  const { out, arm, temp } = input;
  await mkdir(out, { recursive: true });
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  if (!agentDir?.startsWith(temp) || !process.env.HOME?.startsWith(temp)) throw new Error("PI_CODING_AGENT_DIR and HOME must be the run's private overlay");
  const records = join(out, "records");
  const MODEL = MODELS[input.model ?? "opus"];
  const config = { ...ARM_CONFIG(arm, input.model ?? "opus"), records: { enabled: true, dir: records } };
  await writeFile(join(agentDir, "orche.config.json"), JSON.stringify(config, null, 2));
  // The configuration as the frozen orche runtime resolves it (what the worker actually gets).
  const resolvedConfig = await loadOrcheConfigFile(join(agentDir, "orche.config.json"));

  const inst = instance(input.seed);
  const files = generate(inst);
  const workspace = join(temp, "workspace");
  writeFiles(workspace, files);
  const text = request(inst);
  const meta: any = {
    ...input, startedAt: Date.now(), status: "running", config, model: MODEL, limits: LIMITS, request: text, items: inst.items,
    fixtureDigest: fixtureDigest(files), node: process.version,
    resolvedConfig: { workerCompaction: resolvedConfig.workerCompaction, thinkingPolicy: resolvedConfig.thinkingPolicy, single: resolvedConfig.single, routes: resolvedConfig.routes, warnings: resolvedConfig.warnings },
    frozen: JSON.parse(await readFile(join(import.meta.dirname, "../../frozen.json"), "utf8").catch(() => "{}")).digest ?? "unknown",
  };
  const save = () => write(join(out, "meta.json"), meta);
  await save();

  let providerSession: { dispose(): void } | undefined;
  const createRuntime = async () => {
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [input.providerDir], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const { errors } = loader.getExtensions();
    if (errors.length) throw new Error(`provider extension failed: ${errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
    const { session } = await createAgentSession({ cwd: workspace, agentDir, modelRuntime: runtime, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(workspace), tools: [] });
    providerSession = session;
    return runtime;
  };
  const controller = new OrcheController({ agentDir, createRuntime });
  const runtime = await controller.modelRuntime();
  const model = runtime.getModel(MODEL.provider, MODEL.id) as { contextWindow?: number; cost?: unknown; api?: string } | undefined;
  meta.modelCheck = { found: !!model, contextWindow: model?.contextWindow, cost: model?.cost, api: model?.api };
  if (!model || model.contextWindow !== WINDOW_TOKENS) {
    meta.status = "completed"; meta.outcome = "infra"; meta.infraError = `model ${MODEL.provider}/${MODEL.id} window ${model?.contextWindow} (expected ${WINDOW_TOKENS})`;
    await save();
    providerSession?.dispose();
    return;
  }
  await save();

  // The decision feed (outside the workspace); the worker's bash inherits this process's environment.
  const feed = await startFeed(inst);
  process.env.PARCELKIT_FEED_URL = feed.url;
  meta.feed = { url: feed.url, requests: feed.requests };
  const pool = new WorkerPool({ controller, agentDir, scratchBase: join(temp, "scratch") });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`harness limit ${LIMITS.harnessMs}ms`)), LIMITS.harnessMs);
  const assignment: any = { startedAt: Date.now() };
  meta.assignment = assignment;
  try {
    const result = await pool.execute({
      role: "implement", request: text, cwd: workspace, projectTrusted: false, mainMode: "single",
      model: { provider: MODEL.provider, id: MODEL.id }, thinking: MODEL.thinking, signal: abort.signal, currentSession: { id: `dm-b-p${input.seed}-${arm}` },
      onStarted: (info: any) => { assignment.worker = info.worker; assignment.sessionFile = info.sessionFile; },
    } as any);
    assignment.status = result.details?.status;
    assignment.summary = String(result.text ?? "").slice(0, 8000);
    assignment.requests = result.details?.requests;
  } catch (error) {
    if (error instanceof TaskFailedError) {
      const failure = (error as any).failure, details = (error as any).details;
      assignment.status = failure?.status ?? details?.status ?? "failed"; assignment.failureKind = failure?.kind;
      assignment.requests = details?.requests;
    } else assignment.status = "error";
    assignment.error = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 4000);
  } finally {
    clearTimeout(timer);
    assignment.finishedAt = Date.now();
    assignment.wallMs = assignment.finishedAt - assignment.startedAt;
  }
  await pool.dispose();
  providerSession?.dispose();
  await feed.close();

  const transcripts = filesBelow(records, path => /\/workers\/W\d+-[^/]+\.jsonl$/.test(path));
  const texts = await Promise.all(transcripts.map(file => readFile(file, "utf8")));
  const report = texts.map(finalReport).filter(Boolean).at(-1);
  meta.report = report ?? null;
  meta.grade = grade(inst, workspace, join(temp, "hidden"), report?.checklist, files);
  await cp(join(workspace, "src"), join(out, "workspace-final", "src"), { recursive: true }).catch(() => undefined);
  meta.transcripts = await Promise.all(transcripts.map(file => analyzeTranscript(file)));
  const feedDeliveredAt = feed.requests.find(request => request.delivered)?.at;
  meta.evidence = texts.map(text => analyzeEvidence(text, inst, { feedDeliveredAt }));
  const events: any[] = [];
  for (const file of filesBelow(records, path => path.endsWith("events.jsonl"))) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line) continue;
      try { const event = JSON.parse(line); if (/compaction/.test(String(event.type))) events.push(event); } catch { /* partial line */ }
    }
  }
  meta.compactionEvents = events;
  const ok = (meta.transcripts as any[]).some(t => t.usage.requests > 0 && t.errorResponses < t.usage.requests);
  meta.outcome = !ok ? "infra" : meta.grade.success ? "success" : "fail";
  meta.status = "completed";
  meta.finishedAt = Date.now();
  await save();
}

const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as RunInput;
main(input).then(() => process.exit(0), async error => {
  await write(join(input.out, "harness-error.json"), { error: String(error instanceof Error ? error.stack : error) }).catch(() => undefined);
  process.exit(1);
});
