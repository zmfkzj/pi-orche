/**
 * Freeze a pool's calibration before any baseline outcome (experiments/headroom-pool/README.md "Freeze"): the qualified cases in pool
 * order (at most MAX_CALIBRATED), each with its model-facing packet prompt, frozen witness copy, snapshot and venv digests, interpreter
 * digest, grader-validation hash (the visible baseline, run before any solving) and qualification reference; the runtime (Pi bundle,
 * Node, global modules, provider copy, catalog prices, bubblewrap); the harness file hashes; the protocol hashes; the screening
 * schedule. Written once to results/headroom-pool/frozen/<pool>/calibration.json (never overwritten).
 * Hidden-overlap guard (E6, amendment A3): a case whose prompt or witness shares a line with its hidden tests or reference fix that is
 * not already in the public issue text or the pre-fix snapshot (or names a hidden test function absent from both) is excluded with the
 * overlap recorded; the next qualified case in pool order takes its place.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { freezeProvider } from "../ultra-ho/env.js";
import { AGENT, NODE, PI_CLI, PI_MODULES, UPSTREAM, dirDigest, writeJson } from "../witness-replay/env.js";
import { addedLines, hiddenOverlap } from "../witness-replay/freeze.js";
import { fileSha256, sha256, treeDigest } from "../witness-replay/witness-run.js";
import { envManifestPath, graderDir, packetDir, readJsonFile, type StudyPaths } from "./cases.js";
import { caseDir, pythonInstallDir, type EnvManifest } from "./envbuild.js";
import { CAL_BUDGET, EFFORT, MAX_CALIBRATED, MODEL, unitsOf, type PoolName } from "./protocol.js";
import { screeningTable } from "./eligibility.js";
import { currentVerdict, witnessPath } from "./qualify.js";
import type { FrozenCase, FrozenRuntime } from "./unit.js";

export interface CaseProvenance { hiddenOverlap: string[]; hiddenTestIdHits: string[]; hiddenValidation?: { valid: boolean; f2pFailBase: boolean; f2pPassReference: boolean; excludedP2P: number } }
export type FrozenPlanCase = FrozenCase & { order: number; qualification: string; validationSha256: string; issueSha256: string; graderSha256: { record: string; testPatch: string; fixPatch: string } };
export interface FrozenCalibration {
  pool: PoolName; createdAt: string; planDigest?: string; runtime: FrozenRuntime; cases: FrozenPlanCase[];
  excluded: { id: string; rule: string; reason: string }[]; skippedQualified: string[];
  schedule: { name: string; case: string; phase: string; slot: number }[]; harness: Record<string, string>;
  protocol: { doc: string; docSha256: string; module: string; moduleSha256: string; poolFile: string; poolSha256: string };
  provenance: Record<string, CaseProvenance>;
}

export const frozenDir = (paths: StudyPaths, pool: PoolName) => join(paths.out, "frozen", pool);
const version = (command: string, args: string[]): string => { try { return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString().trim(); } catch (error) { return `unknown (${String(error).slice(0, 120)})`; } };
export const digestOf = (value: unknown): string => sha256(JSON.stringify(value));

function sourceText(root: string, limitBytes = 64 * 1024 * 1024): string {
  const parts: string[] = [];
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!/^(\.git|node_modules|__pycache__)$/.test(entry.name)) walk(path); continue; }
      if (!entry.isFile() || !/\.(py|md|rst|txt|toml|ini|cfg|json|yaml|yml)$/.test(entry.name)) continue;
      const size = statSync(path).size;
      if (size > 2 * 1024 * 1024 || total + size > limitBytes) continue;
      total += size; parts.push(readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return parts.join("\n");
}

/** The runtime every unit of a frozen pool uses (provider copied into the frozen dir). */
export async function freezeRuntime(dir: string): Promise<FrozenRuntime> {
  const provider = await freezeProvider(dir);
  const catalogRaw = readFileSync(join(AGENT, "cliproxyapi-models.json"));
  const parsed = JSON.parse(catalogRaw.toString());
  const entries: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : Object.values(parsed ?? {});
  const entry = entries.find(item => item?.id === MODEL.id);
  if (!entry?.cost) throw new Error(`no catalog price for ${MODEL.id}`);
  return {
    upstream: UPSTREAM, route: { model: MODEL.id, effort: EFFORT }, budget: { ...CAL_BUDGET },
    piCli: { path: PI_CLI, sha256: fileSha256(PI_CLI), version: version(NODE, [PI_CLI, "--version"]) }, node: { path: NODE, version: process.version, sha256: fileSha256(NODE) },
    piModules: { path: PI_MODULES, digest: dirDigest(PI_MODULES) }, provider: { dir: provider.dir, digest: provider.digest, ...(provider.version ? { version: provider.version } : {}) },
    catalog: { sha256: sha256(catalogRaw), prices: { [MODEL.id]: entry.cost } }, bwrap: version("/usr/bin/bwrap", ["--version"]),
  };
}

/** One case's frozen inputs (verifies digests against its environment manifest; copies the witness; computes the overlap guard). */
export async function freezeCase(paths: StudyPaths, pool: PoolName, id: string, dir: string): Promise<{ c: FrozenCase; provenance: CaseProvenance; overlapDetail?: string }> {
  const env = readJsonFile<EnvManifest>(envManifestPath(paths, id));
  const src = join(caseDir(paths.roots, id), "src"), venv = join(caseDir(paths.roots, id), "venv");
  const srcDigest = treeDigest(src), venvDigest = dirDigest(venv);
  if (srcDigest !== env.srcDigest) throw new Error(`${id}: snapshot digest ${srcDigest} != manifest ${env.srcDigest}`);
  if (venvDigest !== env.venvDigest) throw new Error(`${id}: venv digest ${venvDigest} != manifest ${env.venvDigest}`);
  const promptPath = join(packetDir(paths, id), "prompt.txt");
  const prompt = readFileSync(promptPath, "utf8");
  await mkdir(join(dir, "witnesses"), { recursive: true });
  const witnessCopy = join(dir, "witnesses", `${id}.py`);
  await copyFile(witnessPath(paths, id), witnessCopy);
  const witnessText = readFileSync(witnessCopy, "utf8");
  const grader = graderDir(paths, id);
  const record = readJsonFile(join(grader, "record.json"));
  const hiddenAdded = [...addedLines(readFileSync(join(grader, "test.patch"), "utf8")), ...addedLines(readFileSync(join(grader, "fix.patch"), "utf8"))];
  const publicText = `${readFileSync(join(packetDir(paths, id), "issue.md"), "utf8")}\n${sourceText(src)}`;
  // A5: every candidate is confirmed against the WHOLE snapshot (the public text above is size-capped) before it counts.
  const inSnapshot = (needle: string): boolean => { if (!needle.trim()) return true; try { execFileSync("grep", ["-rqF", "--", needle.trim(), src], { stdio: "ignore" }); return true; } catch { return false; } };
  const overlap = [...hiddenOverlap(prompt, hiddenAdded, publicText), ...hiddenOverlap(witnessText, hiddenAdded, publicText)].filter(line => !inSnapshot(line));
  const testIds = [...record.failToPass, ...record.passToPass].map((test: string) => test.split("::").at(-1)!.replace(/\[.*$/, "")).filter((name: string) => name.length >= 8);
  const idHits = [...new Set(testIds.filter((name: string) => (prompt.includes(name) || witnessText.includes(name)) && !publicText.includes(name) && !inSnapshot(name)))] as string[];
  const validationPath = join(grader, "validation.json");
  const validation = existsSync(validationPath) ? readJsonFile(validationPath) : undefined;
  const c: FrozenCase = {
    id, repo: env.repo, pool, src, srcDigest, venv, venvDigest, pythonPath: env.pythonPath ?? ".", pythonInstallDir: pythonInstallDir(paths.roots),
    pythonSha256: env.python!.sha256, pythonExecutable: env.python!.executable, prompt: { path: promptPath, sha256: sha256(prompt) },
    witness: { path: witnessCopy, sha256: fileSha256(witnessCopy) }, testCmd: env.testCmd ?? record.testCmd,
  };
  const provenance: CaseProvenance = { hiddenOverlap: overlap, hiddenTestIdHits: idHits, ...(validation ? { hiddenValidation: { valid: validation.valid === true, f2pFailBase: validation.f2pFailBase === true, f2pPassReference: validation.f2pPassReference === true, excludedP2P: (validation.excludedP2P ?? []).length } } : {}) };
  return { c, provenance, ...(overlap.length || idHits.length ? { overlapDetail: JSON.stringify({ overlap, idHits }).slice(0, 1500) } : {}) };
}

/** Freeze the calibration of a pool (once). `order`: the pool's case ids in pool order. */
export async function freezeCalibration(paths: StudyPaths, pool: PoolName, order: readonly string[]): Promise<FrozenCalibration> {
  const dir = frozenDir(paths, pool);
  if (existsSync(join(dir, "calibration.json"))) throw new Error(`${dir}/calibration.json exists: a frozen calibration is never overwritten`);
  // Every pool case must be decided (E1..E7) before freezing; the calibrated cases are the qualified rows in seeded pool order.
  const table = screeningTable(paths, order);
  const pending = table.filter(row => row.status === "pending");
  if (pending.length) throw new Error(`undecided pool case(s): ${pending.map(row => `${row.id} (${row.reason})`).join(", ")}`);
  const qualified = table.filter(row => row.status === "qualified").map(row => row.id);
  await mkdir(dir, { recursive: true });
  const runtime = await freezeRuntime(dir);
  const cases: FrozenPlanCase[] = [];
  const excluded: FrozenCalibration["excluded"] = [];
  const provenance: FrozenCalibration["provenance"] = {};
  const skippedQualified: string[] = [];
  for (const id of qualified) {
    if (cases.length >= MAX_CALIBRATED) { skippedQualified.push(id); continue; }
    const verdict = currentVerdict(paths, id);
    const frozenCase = await freezeCase(paths, pool, id, dir);
    provenance[id] = frozenCase.provenance;
    if (frozenCase.c.witness.sha256 !== verdict.witnessSha256) throw new Error(`${id}: witness copy ${frozenCase.c.witness.sha256} != qualified ${verdict.witnessSha256}`);
    if (frozenCase.overlapDetail) { excluded.push({ id, rule: "E6", reason: `model-facing text overlaps hidden tests/reference: ${frozenCase.overlapDetail}` }); continue; }
    const grader = graderDir(paths, id);
    // A6: the grader validation (visible baseline, run before any solving) is required for every case that is calibrated.
    if (!existsSync(join(grader, "validation.json"))) throw new Error(`grader validation (visible baseline) missing for ${id}, which would be calibrated`);
    cases.push({ ...frozenCase.c, order: order.indexOf(id), qualification: relative(paths.out, join(paths.out, "qualification", `${id}.json`)), validationSha256: fileSha256(join(grader, "validation.json")), issueSha256: fileSha256(join(packetDir(paths, id), "issue.md")), graderSha256: { record: fileSha256(join(grader, "record.json")), testPatch: fileSha256(join(grader, "test.patch")), fixPatch: fileSha256(join(grader, "fix.patch")) } });
  }
  const harness: Record<string, string> = {};
  const walk = (root: string) => { for (const entry of readdirSync(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile() && /\.(ts|mjs|py|txt|md)$/.test(entry.name)) harness[relative(paths.repo, path)] = fileSha256(path); } };
  walk(join(paths.repo, "experiments/headroom-pool"));
  for (const file of ["proxy.mjs", "bridge.mjs", "sandbox.ts", "witness-run.ts", "env.ts"]) harness[`experiments/witness-replay/${file}`] = fileSha256(join(paths.repo, "experiments/witness-replay", file));
  const doc = join(paths.out, "PROTOCOL.md"), module = join(paths.repo, "experiments/headroom-pool/protocol.ts"), poolFile = join(paths.out, `pool-${pool}.json`);
  const plan: FrozenCalibration = {
    pool, createdAt: new Date().toISOString(), runtime, cases, excluded, skippedQualified,
    schedule: cases.flatMap(c => unitsOf(c.id, "screen")), harness,
    protocol: { doc: relative(paths.repo, doc), docSha256: fileSha256(doc), module: relative(paths.repo, module), moduleSha256: fileSha256(module), poolFile: relative(paths.repo, poolFile), poolSha256: fileSha256(poolFile) },
    provenance,
  };
  plan.planDigest = digestOf({ ...plan, createdAt: undefined });
  await writeJson(join(dir, "calibration.json"), plan);
  return plan;
}
