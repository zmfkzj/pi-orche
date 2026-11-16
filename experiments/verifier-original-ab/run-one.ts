/**
 * One run (case × arm × replicate) of the verifier original-evidence A/B, in its own process started by driver.ts with a private
 * PI_CODING_AGENT_DIR, HOME, TMPDIR and XDG dirs below the run's temp dir. Runs from the study's frozen copy.
 *
 *   node --import tsx <study>/frozen/experiments/verifier-original-ab/run-one.ts <input.json>
 *
 * The verifier is orche's real sub-worker runner (createSubWorkerRunner: role verify, reason verification, worker tool set, write
 * guard, report_result with the verify contract) on the user's verifier route. The only difference between the arms is the
 * `original` argument of the production subWorkerPrompt (protocol.ts promptFor). Writes <out>/meta.json and <out>/session.jsonl.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createSubWorkerRunner } from "../../src/orchestrator/sub-worker.js";
import { CASES, PILOT_CASES } from "./cases.js";
import { CASES_2 } from "./cases-2.js";
import { materialize } from "./fixture.js";
import { LIMITS, MODEL, classify, plannedVerifier, promptFor, type Arm } from "./protocol.js";
import { scanTranscript } from "./scan.js";

export interface RunInput { out: string; caseId: string; arm: Arm; replicate: number; temp: string; providerDir: string }

const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function main(input: RunInput) {
  const { out, temp } = input;
  await mkdir(out, { recursive: true });
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  if (!agentDir?.startsWith(temp) || !process.env.HOME?.startsWith(temp)) throw new Error("PI_CODING_AGENT_DIR and HOME must be the run's private overlay");
  const item = [...CASES, ...PILOT_CASES, ...CASES_2].find(candidate => candidate.id === input.caseId);
  if (!item) throw new Error(`unknown case ${input.caseId}`);
  // A neutral workspace path: nothing in it names the case, its stratum or its label.
  const workspace = join(temp, "work", "repo");
  materialize(item, workspace);
  const prompt = promptFor(item, input.arm);
  const meta: any = {
    ...input, startedAt: Date.now(), status: "running", model: MODEL, limits: LIMITS,
    prompt: { sha256: sha(prompt), chars: prompt.length, offSha256: sha(promptFor(item, "off")), onSha256: sha(promptFor(item, "on")) },
    revision: (await readFile(join(import.meta.dirname, "../../REVISION"), "utf8").catch(() => "unknown")).trim(),
  };
  const save = () => write(join(out, "meta.json"), meta);
  await save();

  let providerSession: { dispose(): void } | undefined;
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  {
    // The CLIProxyAPI provider bundle loaded as Pi would load it (the same set-up as experiments/decision-memory-ab).
    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [input.providerDir], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const { errors } = loader.getExtensions();
    if (errors.length) throw new Error(`provider extension failed: ${errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
    const { session } = await createAgentSession({ cwd: workspace, agentDir, modelRuntime: runtime, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(workspace), tools: [] });
    providerSession = session;
  }
  const model = runtime.getModel(MODEL.provider, MODEL.id) as { cost?: unknown } | undefined;
  meta.modelCheck = { found: !!model, cost: model?.cost };
  if (!model) { meta.status = "completed"; meta.class = "infra"; meta.infraError = `model ${MODEL.provider}/${MODEL.id} not found`; await save(); providerSession?.dispose(); return; }

  const route = { role: "worker", model: `${MODEL.provider}/${MODEL.id}`, thinking: MODEL.thinking };
  const sessionFile = join(out, "session.jsonl");
  const runner = createSubWorkerRunner({
    orchestrator: "W1", cwd: workspace, runtime, route, routeSource: "orchestrator", thinkingSource: "orchestrator",
    specialistRoute: () => route, prompt: () => prompt, timeoutMs: LIMITS.verifierMs, sessionFile: () => sessionFile,
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`harness limit ${LIMITS.harnessMs}ms`)), LIMITS.harnessMs);
  const planned = plannedVerifier(item);
  const tools: Record<string, number> = {};
  try {
    const outcome = await runner(planned, [planned], abort.signal, name => { tools[name] = (tools[name] ?? 0) + 1; });
    meta.outcome = { ...outcome, summary: String(outcome.summary ?? "").slice(0, 8000) };
  } catch (error) {
    meta.harnessError = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 4000);
  } finally {
    clearTimeout(timer);
    providerSession?.dispose();
  }
  meta.tools = tools;
  meta.class = classify(meta.outcome);
  const passed = (meta.outcome?.data as { passed?: unknown } | undefined)?.passed;
  meta.verdict = meta.class === "verdict" ? (passed ? "pass" : "fail") : null;
  meta.truth = item.truth;
  meta.correct = meta.class === "verdict" ? meta.verdict === item.truth : meta.class === "no-verdict" ? false : null;
  const reportText = `${meta.outcome?.summary ?? ""}\n${JSON.stringify((meta.outcome?.data as Record<string, unknown> | undefined)?.issues ?? "")}`;
  meta.namesReason = item.reason.test(reportText);
  meta.contamination = existsSync(sessionFile) ? await scanTranscript(sessionFile, workspace) : { scanned: false };
  meta.status = "completed";
  meta.finishedAt = Date.now();
  await save();
}

const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as RunInput;
main(input).then(() => process.exit(0), async error => {
  await write(join(input.out, "harness-error.json"), { error: String(error instanceof Error ? error.stack : error) }).catch(() => undefined);
  process.exit(1);
});
