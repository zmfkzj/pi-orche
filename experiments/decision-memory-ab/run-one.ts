/**
 * One run (task × arm × repeat) of the decision-memory A/B, in its own process started by driver.ts, which sets a private
 * PI_CODING_AGENT_DIR, HOME, TMPDIR and XDG dirs below the run's temp dir (the user's settings, caches and orche config are never read
 * or written). The orche runtime is the study's frozen copy (this file runs from <study>/frozen/experiments/decision-memory-ab).
 *
 *   node --import tsx <study>/frozen/experiments/decision-memory-ab/run-one.ts <input.json>
 *
 * Writes <out>/meta.json (config, model check, timeline, status, grade, transcript analysis, compaction events), <out>/records/
 * (orche's records: worker transcript, run.json, events.jsonl) and <out>/workspace-final/src (the worker's final library code).
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { OrcheController } from "../../src/extension/controller.js";
import { TaskFailedError, WorkerPool } from "../../src/extension/workers.js";
import { analyzeTranscript } from "./analyze.js";
import { generate, grade, REQUESTS, sha, writeFiles, type TaskId } from "./project.js";
import { ARM_CONFIG, LIMITS, MODEL, WINDOW_TOKENS, type Arm, type Linkage } from "./protocol.js";

export interface RunInput { out: string; task: TaskId; arm: Arm; repeat: number; temp: string; providerDir: string; linkage?: Linkage }

const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

function filesBelow(dir: string, test: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(path, test) : test(path) ? [path] : [];
  });
}

async function main(input: RunInput) {
  const { out, task, arm, temp } = input;
  await mkdir(out, { recursive: true });
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  if (!agentDir?.startsWith(temp) || !process.env.HOME?.startsWith(temp)) throw new Error("PI_CODING_AGENT_DIR and HOME must be the run's private overlay");
  const records = join(out, "records");
  const config = { ...ARM_CONFIG(arm, input.linkage ?? "off"), records: { enabled: true, dir: records } };
  await writeFile(join(agentDir, "orche.config.json"), JSON.stringify(config, null, 2));

  const files = generate(task);
  const workspace = join(temp, "workspace");
  writeFiles(workspace, files);
  const meta: any = {
    ...input, startedAt: Date.now(), status: "running", config, model: MODEL, limits: LIMITS, request: REQUESTS[task],
    fixtureDigest: sha(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, text]) => `${path}\0${sha(text)}\n`).join("")),
    node: process.version, revision: (await readFile(join(import.meta.dirname, "../../REVISION"), "utf8").catch(() => "unknown")).trim(),
  };
  const save = () => write(join(out, "meta.json"), meta);
  await save();

  // The model runtime: Pi's file-backed runtime in the private agent dir plus the CLIProxyAPI provider bundle (loaded from the
  // development checkout of the umbrella's cliproxyapi package, as Pi would load it), with the window override of the private config.
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
  const model = runtime.getModel(MODEL.provider, MODEL.id) as { contextWindow?: number; cost?: unknown } | undefined;
  meta.modelCheck = { found: !!model, contextWindow: model?.contextWindow, cost: model?.cost };
  if (!model || model.contextWindow !== WINDOW_TOKENS) {
    meta.status = "completed"; meta.outcome = "infra"; meta.infraError = `model ${MODEL.provider}/${MODEL.id} window ${model?.contextWindow} (expected ${WINDOW_TOKENS})`;
    await save();
    providerSession?.dispose();
    return;
  }
  await save();

  const pool = new WorkerPool({ controller, agentDir, scratchBase: join(temp, "scratch") });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`harness limit ${LIMITS.harnessMs}ms`)), LIMITS.harnessMs);
  const assignment: any = { startedAt: Date.now() };
  meta.assignment = assignment;
  try {
    const result = await pool.execute({
      role: "implement", request: REQUESTS[task], cwd: workspace, projectTrusted: false, mainMode: "single",
      model: { provider: MODEL.provider, id: MODEL.id }, thinking: MODEL.thinking, signal: abort.signal, currentSession: { id: `dm-ab-${task}-${arm}-r${input.repeat}` },
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

  // Grade (hidden tests written now, outside the workspace), keep the final code, analyse the records.
  meta.grade = grade(task, workspace, join(temp, "hidden"), files);
  await cp(join(workspace, "src"), join(out, "workspace-final", "src"), { recursive: true }).catch(() => undefined);
  const transcripts = filesBelow(records, path => /\/workers\/W\d+-[^/]+\.jsonl$/.test(path));
  meta.transcripts = await Promise.all(transcripts.map(file => analyzeTranscript(file)));
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
