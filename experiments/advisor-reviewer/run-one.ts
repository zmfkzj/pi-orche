/**
 * One benchmark run (task × arm × repeat) in its own process (started by driver.ts): a fresh workspace, a private agent dir (the
 * driver sets PI_CODING_AGENT_DIR and TMPDIR), orche's real WorkerPool from a frozen runtime snapshot (git archive of a commit), the
 * arm's protocol (protocol.ts), deterministic grading, and every artifact under `out`:
 *   meta.json (timeline, assignments, statuses, models/effort, usage per role and model, leak audit, outcome), grade.json,
 *   final.diff, workspace-final/, records/ (every orche worker transcript: worker, advisor, reviewer).
 *
 *   node --import tsx experiments/advisor-reviewer/run-one.ts <input.json>
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIMITS, MODELS, addUsage, adviceMessage, advisorRequest, classify, emptyUsage, formatPlan, leakHits, reviewerRequest, revisionRequest,
  sessionToolCalls, usageByModel, workerRequest, type Arm, type UsageTotals,
} from "./protocol.js";
import { gradeLcb, gradeSuite, gradeSwe, loadCandidate, prepareWorkspace, pythonWrappers, readable, type Grade } from "./tasks.js";

export interface RunInput { out: string; runtime: string; task: string; arm: Arm; repeat: number; temp: string; phase: string }

interface Assignment {
  role: "worker" | "advisor" | "reviewer" | "revision";
  worker?: string;
  /** "<pool>:<worker id>" (key of the transcript). */
  session?: string;
  startedAt: number;
  finishedAt?: number;
  status?: string;
  error?: string;
  failureKind?: string;
  timedOut?: boolean;
  model?: string;
  thinking?: string;
  requests?: number;
  summary?: string;
  injected?: unknown;
}

const now = () => Date.now();
const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const TIMEOUT_TEXT = /deadline|timed out|time limit|timeout/i;

async function main(input: RunInput) {
  const { out, runtime, arm } = input;
  await mkdir(out, { recursive: true });
  const records = join(out, "records");
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  if (!agentDir?.startsWith(input.temp)) throw new Error("PI_CODING_AGENT_DIR must be the run's private overlay");
  const config = {
    mainMode: "single",
    providerExtensions: ["npm:@router-for-me/pi-cliproxyapi-provider"],
    default: { model: `${MODELS.worker.provider}/${MODELS.worker.id}`, thinking: MODELS.worker.thinking },
    routes: {},
    limits: { overallMs: LIMITS.assignmentMs, assignmentMs: LIMITS.assignmentMs, maxExtensions: 0, assignmentRequests: LIMITS.assignmentRequests },
    records: { enabled: true, dir: records },
    single: { ledger: false, spawn: false },
    thinkingPolicy: "fixed",
    concurrentSessions: { enabled: false },
  };
  await writeFile(join(agentDir, "orche.config.json"), JSON.stringify(config, null, 2));

  const task = await loadCandidate(input.task);
  const meta: any = {
    ...input, startedAt: now(), status: "running", config, models: MODELS, limits: LIMITS, assignments: [] as Assignment[],
    sourceRevision: readFileSync(join(runtime, "REVISION"), "utf8").trim(), node: process.version,
  };
  const save = () => write(join(out, "meta.json"), meta);
  await save();

  const { OrcheController } = await import(pathToFileURL(join(runtime, "src/extension/controller.ts")).href);
  const { WorkerPool, TaskFailedError } = await import(pathToFileURL(join(runtime, "src/extension/workers.ts")).href);
  const suite = await import(pathToFileURL(join(runtime, "src/eval/suite.ts")).href);

  const workspace = await prepareWorkspace(task, input.temp);
  meta.workspace = workspace;
  if (task.kind === "swe") {
    // python/pytest on PATH run this workspace's code with the task's prepared, read-only virtualenv (workers' bash inherits PATH).
    const manifest = JSON.parse(await readFile(join(task.dir, "task.json"), "utf8"));
    const bin = join(input.temp, "pybin");
    await pythonWrappers(manifest, workspace, bin);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }
  const controller = new OrcheController({ agentDir });
  const pool = new WorkerPool({ controller, agentDir, scratchBase: join(input.temp, "scratch") });
  // The advisor and the reviewer run in their own pool: one orche controller runs one task at a time, and the advisor runs while the
  // worker works. Pools number their workers independently, so transcripts are keyed "<pool>:<worker id>".
  const helperPool = new WorkerPool({ controller: new OrcheController({ agentDir }), agentDir, scratchBase: join(input.temp, "scratch-helper") });
  const poolOf = (role: Assignment["role"]) => role === "advisor" || role === "reviewer" ? "helper" : "worker";
  const model = (which: "worker" | "helper") => ({ provider: MODELS[which].provider, id: MODELS[which].id });
  const base = { cwd: workspace, projectTrusted: false, mainMode: "single" };
  const sessions: Record<string, string> = {};

  /** Run one assignment; never throws (failures are recorded). */
  const assign = async (role: Assignment["role"], args: Record<string, unknown>, options: { abortAfterMs?: number; onStarted?: (info: any) => void } = {}) => {
    const entry: Assignment = { role, startedAt: now() };
    meta.assignments.push(entry);
    await save();
    const controllerAbort = new AbortController();
    const timer = options.abortAfterMs ? setTimeout(() => controllerAbort.abort(new Error(`harness limit ${options.abortAfterMs}ms`)), options.abortAfterMs) : undefined;
    let text = "";
    let details: any;
    try {
      const result = await (poolOf(role) === "helper" ? helperPool : pool).execute({
        ...base, ...args, signal: controllerAbort.signal, currentSession: { id: `bench-${poolOf(role)}` },
        onStarted: (info: any) => { entry.worker = info.worker; entry.session = `${poolOf(role)}:${info.worker}`; if (info.sessionFile) sessions[entry.session] = info.sessionFile; options.onStarted?.(info); },
      });
      text = result.text; details = result.details;
      entry.status = details.status;
    } catch (error) {
      if (error instanceof TaskFailedError) {
        details = (error as any).details; const failure = (error as any).failure;
        entry.status = failure?.status ?? details?.status ?? "failed"; entry.failureKind = failure?.kind;
        entry.error = String((error as Error).message).slice(0, 2000);
        entry.timedOut = TIMEOUT_TEXT.test(`${failure?.reason ?? ""} ${entry.error}`) || controllerAbort.signal.aborted;
      } else { entry.status = "error"; entry.error = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 4000); }
    } finally { clearTimeout(timer); }
    entry.finishedAt = now();
    if (details) {
      entry.worker ??= details.worker; entry.session ??= `${poolOf(role)}:${details.worker}`; entry.model = details.model; entry.thinking = details.thinking; entry.requests = details.requests;
      if (details.injected) entry.injected = details.injected;
    }
    entry.summary = text.slice(0, 6000);
    await save();
    return { entry, text, details, ok: !entry.error };
  };

  try {
    // 1. The worker (all arms).
    let workerId: string | undefined;
    let workerDone = false;
    const workerRun = assign("worker", { role: "implement", request: workerRequest(task), model: model("worker"), thinking: MODELS.worker.thinking }, { onStarted: info => { workerId = info.worker; } })
      .finally(() => { workerDone = true; });

    // 2a. Advisor: triggered by the worker's first task_plan (or first edit/write), advice injected once or handed over after the report.
    let advisorFlow: Promise<void> = Promise.resolve();
    const advisor: any = arm === "advisor" ? { mode: "pending" } : undefined;
    if (advisor) {
      meta.advisor = advisor;
      advisorFlow = (async () => {
        let plan: string | undefined;
        while (!workerDone) {
          const file = workerId ? sessions[`worker:${workerId}`] : undefined;
          if (file && existsSync(file)) {
            const calls = sessionToolCalls(readFileSync(file, "utf8"));
            const planCall = calls.find(call => call.name === "task_plan");
            if (planCall || calls.some(call => call.name === "edit" || call.name === "write")) {
              plan = formatPlan(planCall?.arguments); advisor.trigger = planCall ? "task_plan" : "first_edit"; break;
            }
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (!advisor.trigger) {
          advisor.trigger = "worker_finished";
          const file = workerId ? sessions[`worker:${workerId}`] : undefined;
          const calls = file && existsSync(file) ? sessionToolCalls(readFileSync(file, "utf8")) : [];
          plan = formatPlan(calls.find(call => call.name === "task_plan")?.arguments);
        }
        advisor.triggeredAt = now(); advisor.plan = plan;
        const result = await assign("advisor", { role: "answer", request: advisorRequest(task, plan), model: model("helper"), thinking: MODELS.helper.thinking }, { abortAfterMs: LIMITS.helperMs });
        advisor.readyAt = now();
        if (!result.ok) { advisor.mode = "advisor_failed"; return; }
        advisor.advice = reportSummary(result.entry.session) ?? result.text;
        if (!workerDone && workerId) {
          const receipt = pool.inject(workerId, adviceMessage(advisor.advice));
          advisor.receipt = receipt;
          advisor.mode = receipt.status === "queued" ? "injected" : "late";
        } else advisor.mode = "late";
      })().catch(error => { advisor.mode = "advisor_failed"; advisor.error = String(error); });
    }

    const worker = await workerRun;
    await advisorFlow;
    await save();

    /** The summary of an assignment's report_result, from that worker's transcript. */
    function reportSummary(id: string | undefined): string | undefined {
      const file = id ? sessions[id] : undefined;
      if (!file || !existsSync(file)) return undefined;
      const report = sessionToolCalls(readFileSync(file, "utf8")).filter(call => call.name === "report_result").at(-1);
      return typeof report?.arguments?.summary === "string" ? report.arguments.summary : undefined;
    }
    function reportData(id: string | undefined): any {
      const file = id ? sessions[id] : undefined;
      if (!file || !existsSync(file)) return undefined;
      return sessionToolCalls(readFileSync(file, "utf8")).filter(call => call.name === "report_result").at(-1)?.arguments;
    }

    const workerReported = worker.ok && !!workerId;
    // 2b. Advisor advice that did not reach the running assignment: one follow-up assignment, only after a reported result.
    if (advisor) {
      const injected = (worker.entry.injected as { id: string; status: string }[] | undefined) ?? [];
      if (advisor.mode === "injected") {
        const status = injected.find(message => message.id === advisor.receipt?.id)?.status;
        advisor.delivery = status ?? "unknown";
        if (status !== "delivered") advisor.mode = "late";
      }
      if (advisor.mode === "late") {
        if (workerReported) {
          advisor.revision = true;
          await assign("revision", { role: "implement", worker: workerId, request: revisionRequest(task, "advisor", advisor.advice), model: model("worker"), thinking: MODELS.worker.thinking });
        } else advisor.revision = false;
      }
    }
    // 3. Reviewer: after a reported result; passed:false → one revision by the same worker.
    if (arm === "reviewer") {
      const reviewer: any = { ran: false };
      meta.reviewer = reviewer;
      if (workerReported) {
        reviewer.ran = true;
        const workerSummary = reportSummary(`worker:${workerId}`) ?? worker.text;
        const result = await assign("reviewer", { role: "verify", request: reviewerRequest(task, workerSummary), model: model("helper"), thinking: MODELS.helper.thinking }, { abortAfterMs: LIMITS.helperMs });
        const report = result.ok ? reportData(result.entry.session) : undefined;
        reviewer.passed = report?.data?.passed;
        reviewer.issues = report?.data?.issues;
        reviewer.summary = report?.summary;
        if (!result.ok) reviewer.failed = result.entry.error;
        if (result.ok && reviewer.passed === false) {
          reviewer.revision = true;
          const findings = `${reviewer.summary ?? ""}\nIssues: ${JSON.stringify(reviewer.issues ?? [], null, 1)}`;
          await assign("revision", { role: "implement", worker: workerId, request: revisionRequest(task, "reviewer", findings), model: model("worker"), thinking: MODELS.worker.thinking });
        } else reviewer.revision = false;
      }
    }
    meta.workerTimedOut = !!worker.entry.timedOut;
    meta.workerStatus = worker.entry.status;
  } catch (error) {
    meta.infraError = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 4000);
  } finally {
    meta.solverFinishedAt = now();
    meta.wallMs = meta.solverFinishedAt - meta.startedAt;
    await pool.dispose().catch(() => undefined);
    await helperPool.dispose().catch(() => undefined);
  }

  // Artifacts: final diff and workspace, then the grade (independent of every model).
  try {
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    await writeFile(join(out, "final.diff"), execFileSync("git", ["diff", "--cached", "HEAD", "--", ".", ":(exclude).orche"], { cwd: workspace, maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) { meta.diffError = String(error); }
  await cp(workspace, join(out, "workspace-final"), { recursive: true, filter: path => !/\/(\.git|node_modules|__pycache__)$/.test(path) && readable(path) }).catch(error => { meta.preservationError = String(error); });
  let grade: Grade | undefined;
  try {
    grade = task.kind === "lcb" ? await gradeLcb(task, workspace, { parallel: 2 }) : task.kind === "swe" ? await gradeSwe(task, workspace) : await gradeSuite(suite, task, workspace);
    await write(join(out, "grade.json"), grade);
  } catch (error) { meta.gradeError = String(error); }
  meta.grade = grade ? { passed: grade.passed, ...(grade.error ? { error: grade.error } : {}), detail: Object.fromEntries(Object.entries(grade.checks).map(([name, check]) => [name, check.passed])), ...(grade.tests ? { tests: `${grade.tests.passed}/${grade.tests.total}`, verdicts: grade.tests.verdicts } : {}) } : undefined;

  // Usage per role and per model, effort evidence and the leak audit, all from the transcripts.
  const roleOf: Record<string, string> = {};
  for (const assignment of meta.assignments as Assignment[]) if (assignment.session) roleOf[assignment.session] = assignment.role === "revision" ? "worker" : assignment.role;
  const usage: Record<string, Record<string, UsageTotals>> = {};
  const total = emptyUsage();
  const calls: Record<string, number> = {};
  const leaks: string[] = [];
  const thinkingLevels: Record<string, string[]> = {};
  for (const [id, file] of Object.entries(sessions)) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    const role = roleOf[id] ?? id;
    for (const [key, value] of Object.entries(usageByModel(text))) {
      addUsage((usage[role] ??= {})[key] ??= emptyUsage(), value);
      addUsage(total, value);
    }
    const toolCalls = sessionToolCalls(text);
    calls[role] = (calls[role] ?? 0) + toolCalls.length;
    leaks.push(...leakHits(toolCalls).map(hit => `${role}: ${hit}`));
    for (const line of text.split("\n")) {
      if (!line.includes("thinking_level_change")) continue;
      try { const entry = JSON.parse(line); if (entry.type === "thinking_level_change") (thinkingLevels[role] ??= []).push(entry.thinkingLevel); } catch { /* partial line */ }
    }
  }
  meta.usage = { byRole: usage, total, toolCalls: calls };
  meta.thinkingLevels = thinkingLevels;
  meta.leakAudit = { hits: leaks };
  meta.sessions = Object.fromEntries(Object.entries(sessions).map(([id, file]) => [roleOf[id] ?? id, file.replace(`${out}/`, "")]));
  meta.providerErrors = Object.values(usage).flatMap(byModel => Object.values(byModel)).reduce((sum, item) => sum + item.errors, 0);
  // Infrastructure failure: the harness threw, or the worker never got a model answer (no successful request at all).
  const workerUsage = Object.values(usage.worker ?? {}).reduce((sum, item) => sum + item.requests - item.errors, 0);
  if (!meta.infraError && workerUsage === 0) meta.infraError = `worker made no successful request (${(meta.assignments[0] as Assignment | undefined)?.error ?? "no error text"})`;
  meta.outcome = classify(meta);
  meta.finishedAt = now();
  meta.status = "completed";
  await save();
  console.log(`RUN ${input.task}/${arm}/r${input.repeat}: ${meta.outcome} (${Math.round(meta.wallMs / 1000)}s, ${total.requests} requests, $${total.cost.toFixed(2)})`);
}

const input: RunInput = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const guard = setTimeout(() => { console.error("run guard expired"); process.exit(3); }, LIMITS.runGuardMs);
try { await main(input); } finally { clearTimeout(guard); }
process.exit(0);

