/**
 * headroom-pool command line (experiments/headroom-pool/README.md). Run from the repository root with
 * `node --import tsx experiments/headroom-pool/cli.ts <command>`:
 *   pool <A|B>                                   frozen candidate pool (model-free; never overwritten)
 *   envs <A|B> [--concurrency N] [id...]         E1 environments + packets (model-free)
 *   validate <A|B> [--concurrency N] [id...]     grader validation + visible baseline (model-free, sandboxed)
 *   reject <id> <E2..E7> <reason...>             record a witness author's rejection
 *   try <id>                                     authoring aid: the witness once on the pre-fix snapshot
 *   qualify <id>                                 E4/E5/E7 qualification runs (pre-fix x2, reference x2)
 *   table <A|B>                                  screening table (one status per pool case)
 *   probe [<A|B> <id>]                           model-free sandbox visibility probe (smoke case or a pool case)
 *   smoke                                        one harness-validation session on the synthetic case (Sol/high; never counted)
 *   freeze <A|B>                                 freeze the pool's calibration (once, before any baseline outcome)
 *   drive <A|B> [--concurrency N]                run the frozen calibration (Sol/high baseline sessions)
 *   status <A|B>                                 calibration progress (model-free)
 *   summary <A|B>                                calibration summary + ledger (model-free; writes calibration/<P>/summary.json)
 * Environment caches go to results/headroom-pool/cache (ignored by git); scratch to $HEADROOM_SCRATCH.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMechanisms, readPlan, summarize } from "./analyze.js";
import { envManifestPath, recordOf, setupCase, validateCase, writePacket, type StudyPaths } from "./cases.js";
import { calibrationState, drive } from "./driver.js";
import { recordDecision, screeningTable } from "./eligibility.js";
import { freezeCalibration } from "./freeze.js";
import { writePool, type PoolFile } from "./pool.js";
import { CONCURRENCY, stopDecision, type EligibilityRule, type PoolName } from "./protocol.js";
import { qualifyCase, tryWitness } from "./qualify.js";
import { runProbe, runSmoke } from "./smoke.js";

export const REPO = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const OUT = resolve(REPO, "results/headroom-pool");
export const SCRATCH = process.env.HEADROOM_SCRATCH ?? "/var/tmp/pi-arthur/pi-orche/01a152d6-1832-7291-b05c-3e9a404e5ca3/W9/scratch";
// Unit proxies listen on short socket paths next to the scratch directory (Unix socket paths are limited to 107 bytes).
process.env.HEADROOM_SOCKET_DIR ??= join(dirname(SCRATCH), "k");
export const PATHS: StudyPaths = { repo: REPO, out: OUT, roots: { cache: join(OUT, "cache"), scratch: SCRATCH } };
const AUTHOR = process.env.HEADROOM_AUTHOR ?? "W9 (claude-opus-5-5, task manager)";

export const poolFile = (name: PoolName): PoolFile => JSON.parse(readFileSync(join(OUT, `pool-${name}.json`), "utf8"));
export const poolOrder = (name: PoolName): string[] => poolFile(name).pool.map(entry => entry.id);
/** The pool a case id belongs to. */
export function poolOf(id: string): PoolName {
  for (const name of ["A", "B"] as const) if (existsSync(join(OUT, `pool-${name}.json`)) && poolOrder(name).includes(id)) return name;
  throw new Error(`${id} is in no frozen pool`);
}

async function forEachConcurrent<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const item = items[next++]!; await work(item); } }));
}

function parse(rest: string[], defaultConcurrency = 4): { pool: PoolName; ids: string[]; concurrency: number } {
  const pool = rest[0] as PoolName;
  if (pool !== "A" && pool !== "B") throw new Error("pool must be A or B");
  const index = rest.indexOf("--concurrency");
  const concurrency = index >= 0 ? Number(rest[index + 1]) : defaultConcurrency;
  const ids = rest.slice(1).filter((value, i, all) => value !== "--concurrency" && all[i - 1] !== "--concurrency");
  const order = poolOrder(pool);
  for (const id of ids) if (!order.includes(id)) throw new Error(`${id} is not in pool ${pool}`);
  return { pool, ids: ids.length ? order.filter(id => ids.includes(id)) : order, concurrency };
}

const manifestOf = (id: string) => existsSync(envManifestPath(PATHS, id)) ? JSON.parse(readFileSync(envManifestPath(PATHS, id), "utf8")) : undefined;
const brief = (meta: any) => ({ valid: meta.valid, invalid: meta.invalid, invalidDetail: meta.invalidDetail, stop: meta.stop, stopDetail: meta.stopDetail, terminal: meta.terminal, exit: meta.exit, wallMs: meta.wallMs, changedFiles: meta.changedFiles, startedCompleted: meta.startedCompleted, inFlight: meta.inFlight, wire: meta.wire && { forwarded: meta.wire.forwarded, completed: meta.wire.completed, refused: meta.wire.refused, providerErrors: meta.wire.providerErrors, offRouteResponses: meta.wire.offRouteResponses, unknownUsage: meta.wire.unknownUsage, byModel: meta.wire.byModel, byEffort: meta.wire.byEffort, input: meta.wire.input, output: meta.wire.output, reasoning: meta.wire.reasoning, costUSD: meta.wire.costUSD } });

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  await mkdir(SCRATCH, { recursive: true });
  switch (command) {
    case "pool": {
      const name = rest[0] as PoolName;
      if (name !== "A" && name !== "B") throw new Error("usage: pool <A|B>");
      const file = await writePool(REPO, OUT, name);
      console.log(JSON.stringify(file.counts));
      for (const entry of file.pool) console.log(`${entry.order.slice(0, 8)} ${entry.id} ${entry.split} blocks=${entry.prescreen.codeBlocks}${entry.exposure.setupOnly.length ? ` setupOnly=${entry.exposure.setupOnly.join(",")}` : ""}`);
      return;
    }
    case "envs": {
      const { pool, ids, concurrency } = parse(rest);
      await forEachConcurrent(ids, concurrency, async id => {
        const previous = manifestOf(id);
        if (previous?.status === "built") {
          if (!existsSync(join(OUT, "packets", id, "prompt.txt"))) await writePacket(PATHS, recordOf(REPO, pool, id), previous);
          console.log(`${id}: built (kept)`);
          return;
        }
        const manifest = await setupCase(PATHS, pool, id);
        console.log(`${id}: ${manifest.status}${manifest.reason ? ` — ${manifest.reason.split("\n")[0]!.slice(0, 200)}` : ""} (${Math.round(manifest.ms / 1000)} s)`);
      });
      return;
    }
    case "validate": {
      const { ids, concurrency } = parse(rest, 3);
      await forEachConcurrent(ids, concurrency, async id => {
        if (manifestOf(id)?.status !== "built") return;
        if (existsSync(join(OUT, "grader", id, "validation.json"))) { console.log(`${id}: validated (kept)`); return; }
        try {
          const result = await validateCase(PATHS, id);
          console.log(`${id}: valid=${result.valid} f2pFailBase=${result.f2pFailBase} f2pPassReference=${result.f2pPassReference} excludedP2P=${result.excludedP2P.length} visible=${JSON.stringify(result.visible.counts)}`);
        } catch (error) { console.log(`${id}: validation error ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`); }
      });
      return;
    }
    case "reject": {
      const [id, rule, ...words] = rest;
      if (!id || !rule || !/^E[1-7]$/.test(rule) || !words.length) throw new Error("usage: reject <id> <E2..E7> <reason...>");
      poolOf(id);
      const list = await recordDecision(PATHS, { id, decision: "rejected", rule: rule as EligibilityRule, reason: words.join(" "), author: AUTHOR });
      console.log(JSON.stringify(list.at(-1)));
      return;
    }
    case "try": {
      const id = rest[0]!;
      poolOf(id);
      const summary = await tryWitness(PATHS, id);
      console.log(summary.outputTail);
      console.log(`STATUS ${summary.status}${summary.reason ? ` (${summary.reason})` : ""} exit ${summary.exit} in ${summary.ms} ms`);
      return;
    }
    case "qualify": {
      const id = rest[0]!;
      poolOf(id);
      await recordDecision(PATHS, { id, decision: "witness", reason: "witness written from the issue text and the pre-fix snapshot", author: AUTHOR });
      const entry = await qualifyCase(PATHS, id);
      for (const run of entry.runs) console.log(`${run.tree}: ${run.status}${run.reason ? ` (${run.reason})` : ""} exit ${run.exit}`);
      console.log(`VERDICT ${JSON.stringify(entry.verdict)}`);
      return;
    }
    case "table": {
      const pool = rest[0] as PoolName;
      const rows = screeningTable(PATHS, poolOrder(pool));
      const counts = rows.reduce<Record<string, number>>((acc, row) => { const key = row.status === "rejected" ? `rejected ${row.rule}` : row.status; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
      for (const row of rows) console.log(`${String(row.order).padStart(2)} ${row.id.padEnd(48)} ${row.status.padEnd(9)} ${row.rule ?? ""} ${row.reason.slice(0, 140)}`);
      console.log(JSON.stringify(counts));
      await writeFile(join(OUT, `screening-${pool}.json`), `${JSON.stringify({ at: new Date().toISOString(), counts, rows }, null, 2)}\n`);
      return;
    }
    case "probe": {
      const pool = rest[0] as PoolName | undefined, id = rest[1];
      const result = await runProbe(PATHS, join(OUT, "smoke"), pool, id);
      console.log(result.text);
      console.log(JSON.stringify({ stop: result.meta.stop, requests: result.meta.wire?.forwarded ?? 0 }));
      return;
    }
    case "smoke": {
      const result = await runSmoke(PATHS, join(OUT, "smoke"));
      console.log(JSON.stringify(brief(result.meta), null, 1));
      if (result.score) console.log(JSON.stringify({ outcome: result.score.outcome, witness: result.score.witness.status, witnessReason: result.score.witness.reason, hidden: { f2pPassed: result.score.hidden.f2pPassed, f2pTotal: result.score.hidden.f2pTotal, resolved: result.score.hidden.resolved, error: result.score.hidden.error }, regressions: result.score.regressions, integrity: result.score.integrity }, null, 1));
      return;
    }
    case "freeze": {
      const pool = rest[0] as PoolName;
      const plan = await freezeCalibration(PATHS, pool, poolOrder(pool));
      console.log(`frozen ${plan.cases.length} case(s): ${plan.cases.map(c => c.id).join(", ")}; excluded: ${JSON.stringify(plan.excluded)}; skipped qualified beyond the cap: ${plan.skippedQualified.length}; plan ${plan.planDigest}`);
      return;
    }
    case "drive": {
      const { pool, concurrency } = parse([rest[0]!, ...rest.slice(1)], CONCURRENCY);
      await drive(PATHS, pool, concurrency);
      return;
    }
    case "status": {
      const pool = rest[0] as PoolName;
      const state = calibrationState(PATHS, readPlan(PATHS, pool));
      for (const slot of [...state.screen, ...state.confirm]) console.log(`${slot.unit.padEnd(56)} ${slot.outcome.padEnd(8)} attempts ${slot.attempts.map(a => `${a.n}:${a.outcome ?? (a.completed ? "?" : "running")}`).join(" ")}`);
      console.log(`confirmation cases: ${state.confirmCases.join(", ") || "none (yet)"}`);
      return;
    }
    case "summary": {
      const pool = rest[0] as PoolName;
      const summary = summarize(PATHS, readPlan(PATHS, pool), readMechanisms(PATHS, pool));
      const pendingSlots = summary.screening.pending + summary.confirmation.pending;
      const stop = pendingSlots ? "calibration not finished" : stopDecision(pool, summary.families.length);
      Object.assign(summary, { stopDecision: { promotedFamilies: summary.families.length, decision: stop, rule: "PROTOCOL.md section 4" } });
      await mkdir(join(OUT, "calibration", pool), { recursive: true });
      await writeFile(join(OUT, "calibration", pool, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
      for (const c of summary.cases) console.log(`${String(c.order).padStart(2)} ${c.case.padEnd(46)} screen ${c.screen.join(",").padEnd(26)} confirm ${c.confirm.join(",").padEnd(24)} ${c.promoted ? "PROMOTED" : ""} conf witness-fail ${c.confirmation.witnessFailed}/${c.confirmation.scored} hidden ${c.hidden.join(" ")}`);
      console.log(JSON.stringify({ screening: summary.screening, confirmation: summary.confirmation, promoted: summary.promoted, families: summary.families, stopDecision: (summary as any).stopDecision, ledger: summary.ledger }, null, 1));
      return;
    }
    default:
      throw new Error(`unknown command ${command ?? "(none)"}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(1); });
}
