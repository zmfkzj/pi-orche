/**
 * Driver of the decision-audit rescue pilot (pilot/PREREGISTRATION.md). Freezes the protocol (texts, hashes, schedule, budget,
 * clusters, environment) into <pilot>/frozen/manifest.json at its first launch and refuses to run against a changed protocol, then
 *
 *   --dry   replays the DRY units offline up to the reflection point (zero cost; fidelity + delivery check), into <pilot>/dry;
 *   --live  runs the pre-declared JOBS in priority order, CONCURRENCY at a time; a job's arms run one after another at the unit's
 *           recorded live path. A job starts only when its reserved cost fits (protocol.ts admits); jobs never start out of order,
 *           and when the next one cannot fit while nothing runs, the run stops (reported as truncation).
 *
 *   node --import tsx experiments/strong-reflection/bench/pilot/driver.ts <pilot dir> --dry|--live [--amend "<reason>"]
 *
 * Resumable: an arm with meta.json is done; an arm with gate-failed.json is invalid and never re-run; an arm that ended without
 * meta.json is re-run once only when its wire shows no successful upstream response (infra rule), else it stays incomplete.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AGENT } from "../../../ultra-ab/env.js";
import { MODEL_REF, THINKING } from "../protocol.js";
import { Ledger } from "./budget.js";
import { AUDIT, BUDGET, CLUSTERS, DRY, FOUR_LINES, JOBS, PATH_MAP, PILOT_ID, REACHABLE, admits, armReservationUsd, pilotLivePath, pilotText, sha256, type Job, type PilotArm } from "./protocol.js";

const REPO = resolve(import.meta.dirname, "../../../..");
export const SOURCE_BENCH = join(REPO, "results/strong-reflection/bench-2026-10-19");
const CONCURRENCY = 8;
const HARD_KILL_MS = 120 * 60_000;
const FILES = ["experiments/strong-reflection/bench/pilot/protocol.ts", "experiments/strong-reflection/bench/pilot/PREREGISTRATION.md", "experiments/strong-reflection/bench/pilot/fidelity.ts", "experiments/strong-reflection/bench/pilot/budget.ts", "experiments/strong-reflection/bench/pilot/driver.ts", "experiments/strong-reflection/bench/run-arm.ts", "experiments/strong-reflection/bench/wire.ts"];

const args = process.argv.slice(2);
const pilotDir = resolve(args[0] ?? "");
const mode = args.includes("--live") ? "live" : args.includes("--dry") ? "dry" : undefined;
const amend = args.includes("--amend") ? args[args.indexOf("--amend") + 1] : undefined;
const log = (line: string) => { console.log(line); return appendFile(join(pilotDir, "driver.log"), `${new Date().toISOString()} ${mode ?? "-"} ${line}\n`); };
const readJson = (file: string): any => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
const version = (dir: string): string | undefined => readJson(join(dir, "package.json"))?.version;

/** Everything frozen: protocol content (compared strictly on resume) and file hashes / environment (recorded). */
function protocolContent() {
  return {
    pilot: PILOT_ID,
    model: { ref: MODEL_REF, thinking: THINKING, wire: "gpt-6-astra/high" },
    texts: { A: pilotText("A", "verify"), B: pilotText("B", "verify"), C0: pilotText("C0", "verify") },
    sha256: { A: sha256(pilotText("A", "verify")), B: sha256(pilotText("B", "verify")), audit: sha256(AUDIT), fourLines: sha256(FOUR_LINES) },
    schedule: JOBS, dry: DRY, budget: BUDGET, clusters: CLUSTERS, reachable: REACHABLE, sourceBench: SOURCE_BENCH,
  };
}
async function environment() {
  const nm = join(SOURCE_BENCH, "rt/node_modules");
  const provider = join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
  const catalog = readJson(join(AGENT, "cliproxyapi-models.json"));
  let served: string | undefined;
  try {
    const connection = readJson(join(AGENT, "cliproxyapi.json"));
    const response = await fetch("http://127.0.0.1:8317/v1/models", { headers: { authorization: `Bearer ${connection?.apiKey ?? ""}` } });
    const body: any = await response.json();
    served = (body?.data ?? []).some((model: any) => model?.id === "gpt-6-astra") ? "gpt-6-astra listed by the proxy" : "gpt-6-astra NOT listed by the proxy";
  } catch (error) { served = `proxy model list unavailable: ${String(error).slice(0, 120)}`; }
  return {
    node: process.version,
    runtimeDigest: readJson(join(SOURCE_BENCH, "rt/REVISION.json"))?.digest,
    packages: Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core"].map(name => [name, version(join(nm, name))])),
    provider: version(provider),
    catalog: { fetchedAt: catalog?.fetchedAt, model: (catalog?.models ?? []).find((model: any) => model?.id === "gpt-6-astra") },
    served,
  };
}
async function freeze(): Promise<void> {
  const file = join(pilotDir, "frozen/manifest.json");
  const content = protocolContent();
  const files = Object.fromEntries(FILES.map(path => [path, existsSync(join(REPO, path)) ? sha256(readFileSync(join(REPO, path), "utf8")) : "missing"]));
  if (!existsSync(file)) {
    await mkdir(join(pilotDir, "frozen"), { recursive: true });
    for (const arm of ["A", "B"] as const) await writeFile(join(pilotDir, `frozen/prompt-${arm}.txt`), `${pilotText(arm, "verify")}\n`);
    await writeFile(file, `${JSON.stringify({ frozenAt: new Date().toISOString(), ...content, files, environment: await environment(), amendments: [] }, null, 2)}\n`);
    await log(`frozen ${file}: A ${content.sha256.A.slice(0, 12)}, B ${content.sha256.B.slice(0, 12)}`);
    return;
  }
  const frozen = JSON.parse(await readFile(file, "utf8"));
  for (const key of Object.keys(content) as (keyof typeof content)[]) {
    if (JSON.stringify(frozen[key]) !== JSON.stringify(content[key])) throw new Error(`protocol changed after freezing (${key}); the frozen manifest ${file} stays authoritative`);
  }
  const changed = FILES.filter(path => frozen.files?.[path] !== files[path] && !(frozen.amendments ?? []).some((item: any) => item.files?.[path] === files[path]));
  if (changed.length) {
    if (!amend) throw new Error(`harness files changed since freezing (${changed.join(", ")}): pass --amend "<reason>" (harness fixes only)`);
    frozen.amendments = [...(frozen.amendments ?? []), { at: new Date().toISOString(), reason: amend, mode, files: Object.fromEntries(changed.map(path => [path, files[path]])) }];
    await writeFile(file, `${JSON.stringify(frozen, null, 2)}\n`);
    await log(`amendment recorded (${changed.join(", ")}): ${amend}`);
  }
}

/** Historical live cost of the unit's R0/R1 continuations (the reservation basis). */
const historicalMax = (unit: string): number => Math.max(...["R0", "R1"].map(arm => readJson(join(SOURCE_BENCH, "units", unit, arm, "meta.json"))?.wire?.liveCostUsd ?? 0));
const jobReservation = (job: Job): number => job.arms.reduce((sum, arm) => sum + armReservationUsd(arm, historicalMax(job.unit)), 0);

function runArm(out: string, unit: string, task: string, arm: PilotArm, dry: boolean): Promise<number | null> {
  const live = pilotLivePath(readJson(join(SOURCE_BENCH, "units", unit, "O/meta.json")).live as string);
  return new Promise(done => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(PI_|CLIPROXYAPI_|ORCHE_|SRB_)/.test(name)));
    mkdirSync(join(out, "units", unit), { recursive: true });
    const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "experiments/strong-reflection/bench/run-arm.ts"), out, unit, task, arm, live, SOURCE_BENCH], { cwd: REPO, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...(dry ? { SRB_DRY: "1", SRB_MODELS_SNAPSHOT: join(out, "models-snapshot.json") } : {}) } });
    const file = join(out, "units", unit, `${arm}.log`);
    child.stdout.on("data", chunk => void appendFile(file, chunk));
    child.stderr.on("data", chunk => void appendFile(file, chunk));
    const timer = setTimeout(() => { void log(`${unit}/${arm}: hard kill after ${HARD_KILL_MS / 60000} min`); try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, HARD_KILL_MS);
    child.once("close", code => {
      clearTimeout(timer);
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* none left */ }
      done(code);
    });
  });
}

const okWire = (file: string): boolean => existsSync(file) && readFileSync(file, "utf8").split("\n").filter(Boolean).some(line => { try { const entry = JSON.parse(line); return entry.mode === "live" && entry.status === 200 && entry.usage; } catch { return false; } });

async function dryRun(): Promise<void> {
  const out = join(pilotDir, "dry");
  // The provider lists the models at start-up (a GET, no model call); offline arms answer it from this one snapshot.
  const connection = readJson(join(AGENT, "cliproxyapi.json"));
  const listing = await fetch("http://127.0.0.1:8317/v1/models?client_version=pi", { headers: { authorization: `Bearer ${connection?.apiKey ?? ""}` } });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "models-snapshot.json"), JSON.stringify({ contentType: listing.headers.get("content-type") ?? "application/json", body: await listing.text() }));
  await Promise.all(DRY.map(async ([unit, arm]) => {
    const job = JOBS.find(item => item.unit === unit)!;
    await log(`dry ${unit}/${arm} start`);
    const code = await runArm(out, unit, job.task, arm, true);
    const result = readJson(join(out, "units", unit, arm, "dry.json"));
    await log(`dry ${unit}/${arm} exit ${code}: ${result ? `ok ${result.ok}, same state ${result.sameState}, tool outputs differing ${result.outputs?.raw}→${result.outputs?.normalized}→${result.outputs?.orderOnly}${result.problems?.length ? `, problems: ${result.problems.join("; ")}` : ""}` : "no dry.json"}`);
  }));
  const ledger = new Ledger(join(out, "budget"), BUDGET.capUsd, BUDGET.gateMarginUsd);
  const live = DRY.flatMap(([unit, arm]) => { const file = join(out, "units", unit, arm, "wire.jsonl"); return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(line => line.includes('"mode":"live"')) : []; });
  await log(`dry done: ${live.length} forwarded requests (must be 0); ledger ${JSON.stringify(ledger.state())}`);
}

async function liveRun(): Promise<void> {
  const out = pilotDir;
  const ledger = new Ledger(join(out, "budget"), BUDGET.capUsd, BUDGET.gateMarginUsd);
  const running = new Map<string, { job: Job; reservation: number }>();
  const spentOf = (job: Job) => job.arms.reduce((sum, arm) => sum + (ledger.state().byArm[`${job.unit}/${arm}`] ?? 0), 0);
  const remaining = () => [...running.values()].reduce((sum, item) => sum + Math.max(0, item.reservation - spentOf(item.job)), 0);
  const snapshot = async (event: string) => { const state = ledger.state(); await appendFile(join(out, "budget.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, ...state, running: [...running.keys()], remainingReservedUsd: Number(remaining().toFixed(4)) })}\n`); };
  const monitor = setInterval(() => void snapshot("tick"), 60_000);

  async function runJob(job: Job): Promise<void> {
    for (const arm of job.arms) {
      const dir = join(out, "units", job.unit, arm);
      if (existsSync(join(dir, "meta.json"))) continue;
      if (existsSync(join(dir, "gate-failed.json"))) { await log(`${job.unit}/${arm}: fidelity gate failed earlier; not re-run`); continue; }
      if (existsSync(join(dir, "attempt.json")) && okWire(join(dir, "wire.jsonl"))) { await log(`${job.unit}/${arm}: incomplete earlier after live responses; not re-run`); continue; }
      for (let attempt = 1; attempt <= 2; attempt++) {
        await mkdir(dir, { recursive: true });
        await log(`${job.unit}/${arm} start (attempt ${attempt})`);
        const code = await runArm(out, job.unit, job.task, arm, false);
        await writeFile(join(dir, "attempt.json"), `${JSON.stringify({ attempt, code, at: new Date().toISOString() })}\n`).catch(() => undefined);
        const meta = readJson(join(dir, "meta.json"));
        await log(`${job.unit}/${arm} exit ${code}: ${meta ? `terminal ${meta.terminal}, grade ${meta.grade?.passed}, pass ${meta.primaryPass}, live $${meta.wire?.liveCostUsd}, fidelity ${meta.fidelity?.ok}, halted ${meta.proxyHalted ?? "-"}` : existsSync(join(dir, "gate-failed.json")) ? "fidelity gate failed (nothing forwarded)" : "no meta.json"}`);
        await snapshot(`${job.unit}/${arm} exit ${code}`);
        // Infra rule: an arm that ended without meta.json and without any successful upstream response is retried once.
        if (meta || existsSync(join(dir, "gate-failed.json")) || okWire(join(dir, "wire.jsonl")) || attempt === 2) break;
        await log(`${job.unit}/${arm}: no successful upstream response; infra retry`);
        await rename(dir, `${dir}.infra-${attempt}`);
      }
    }
  }

  const queue = [...JOBS];
  const truncated: string[] = [];
  await snapshot("start");
  await new Promise<void>(finish => {
    const tick = () => {
      while (queue.length && running.size < CONCURRENCY) {
        const job = queue[0]!;
        const done = job.arms.every(arm => existsSync(join(out, "units", job.unit, arm, "meta.json")) || existsSync(join(out, "units", job.unit, arm, "gate-failed.json")));
        const reservation = done ? 0 : jobReservation(job);
        if (!done && !admits(ledger.state().committedUsd, remaining(), reservation)) {
          if (running.size) return; // wait for a running job to settle; never skip ahead
          truncated.push(...queue.splice(0).map(item => item.unit));
          void log(`budget truncation: committed ${ledger.state().committedUsd.toFixed(2)} USD; next job ${job.unit} reserves ${reservation.toFixed(2)} USD; not run: ${truncated.join(", ")}`);
          break;
        }
        queue.shift();
        running.set(job.unit, { job, reservation });
        void log(`job ${job.unit} (tier ${job.tier}, ${job.cluster}, arms ${job.arms.join(">")}, reserved ${reservation.toFixed(2)} USD) admitted; committed ${ledger.state().committedUsd.toFixed(2)} USD`);
        void runJob(job).catch(error => log(`${job.unit}: driver error ${String(error).slice(0, 300)}`)).finally(() => { running.delete(job.unit); tick(); });
      }
      if (!queue.length && !running.size) finish();
    };
    tick();
  });
  clearInterval(monitor);
  await snapshot("done");
  await writeFile(join(out, "truncation.json"), `${JSON.stringify({ truncated, at: new Date().toISOString() }, null, 2)}\n`);
  await log(`done; ledger ${JSON.stringify(ledger.state())}; truncated ${truncated.length ? truncated.join(", ") : "none"}`);
}

async function main(): Promise<void> {
  if (!args[0] || !mode) throw new Error("usage: driver.ts <pilot dir> --dry|--live [--amend \"<reason>\"]");
  if (pilotDir === SOURCE_BENCH || pilotDir.startsWith(`${SOURCE_BENCH}/`)) throw new Error("the pilot dir must be outside the source bench");
  await mkdir(pilotDir, { recursive: true });
  await freeze();
  if (mode === "dry") await dryRun(); else await liveRun();
}
if (process.argv[1]?.endsWith("pilot/driver.ts")) await main();
