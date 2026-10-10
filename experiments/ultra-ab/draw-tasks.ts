/**
 * Pre-registered task draw of the ultra-vs-single study: eligible rows of experiments/advisor-reviewer/selection.json (independent
 * Opus single-worker calibration; suite and SWE only, environment ready, deterministic visible+hidden grading), stratified by
 * protocol.ts `stratumOf`, drawn with a fixed seed. Writes experiments/ultra-ab/tasks.json.
 *
 *   npx tsx experiments/ultra-ab/draw-tasks.ts
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTask } from "./env.js";
import { drawTasks, stratumOf, type CalibrationRow } from "./protocol.js";

export const SEED = "ultra-ab-2026-10-10";
export const PER_STRATUM = 4;
export const PILOT = { hard: 1, medium: 1, easy: 1 } as const;

const HERE = fileURLToPath(new URL(".", import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const selection = JSON.parse(readFileSync(join(HERE, "../advisor-reviewer/selection.json"), "utf8"));
  const rows: CalibrationRow[] = [];
  const ineligible: { task: string; reason: string }[] = [];
  for (const candidate of selection.candidates) {
    const row: CalibrationRow = { task: candidate.task, kind: candidate.kind, outcomes: candidate.calibration.map((item: any) => item.outcome), meanCostUsd: candidate.meanCostUsd, decision: candidate.decision };
    if (row.kind !== "suite" && row.kind !== "swe") { ineligible.push({ task: row.task, reason: `kind ${row.kind} (LiveCodeBench: public 2025 problems, all passed in calibration)` }); continue; }
    if (!stratumOf(row)) { ineligible.push({ task: row.task, reason: row.decision === "excluded" ? `excluded by the calibration study: ${candidate.reason}` : `calibration outcomes ${row.outcomes.join(",")}` }); continue; }
    try { await loadTask(row.task); rows.push(row); } catch (error) { ineligible.push({ task: row.task, reason: String(error instanceof Error ? error.message : error) }); }
  }
  const drawn = drawTasks(rows, SEED, PER_STRATUM, PILOT);
  const eligible = rows.map(row => ({ task: row.task, kind: row.kind, stratum: stratumOf(row), outcomes: row.outcomes, meanCostUsd: row.meanCostUsd }));
  await writeFile(join(HERE, "tasks.json"), `${JSON.stringify({ seed: SEED, perStratum: PER_STRATUM, pilotPerStratum: PILOT, drawnAt: new Date().toISOString(), main: drawn.main, pilot: drawn.pilot, eligible, ineligible }, null, 2)}\n`);
  console.log(JSON.stringify(drawn, null, 1));
}
