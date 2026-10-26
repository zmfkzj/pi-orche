/**
 * Objective, model-free evaluation of one unit's counted attempt (README.md "Measurement"), each measure separately:
 *   - witness: the retained reproducer on the final workspace (witness-run.ts, sandboxed, hash-checked) - for T also whether the
 *     final is the candidate the gate accepted;
 *   - heldout: the evaluation-only public check (never shown to a model);
 *   - grade, visible tests (new failures vs the seed), integrity original→final and seed→final: grade-child.ts in the sandbox
 *     (repository read-only, no network, no home);
 *   - leaks: tool calls of the session naming hidden-test/reference/result paths or network fetches (ultra-ab leakHits);
 *   - cost and requests: the unit proxy's totals (started, completed, refused, unknown usage, list-price USD).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sessionToolCalls } from "../ultra-ab/protocol.js";
import { NODE, NODE_DIR, REPO, readJson, writeJson } from "./env.js";
import type { Outcome } from "./protocol.js";
import { runSandboxed } from "./sandbox.js";
import type { FrozenPlan } from "./unit.js";
import { runWitness } from "./witness-run.js";

/**
 * Hidden-information leaks: tool calls naming where hidden tests, reference fixes or other runs' results live (ultra-ab's path
 * patterns plus this pilot's own results, harness and audit/smoke scratch). Network or install attempts (curl, wget, pip, GitHub,
 * PyPI) are reported separately: the sandbox has no network, so they cannot carry information in, but they are disclosed.
 */
export const HIDDEN_PATHS = [/fixtures\/(suite|advisor-bench)/, /\/hidden\b/, /results\/(ultra-ab|ultra-ho|advisor-reviewer|witness-replay)/, /oh-my-pi-extensions\/orche\/(fixtures|results|experiments|docs|test)\b/, /grade(-final)?\.json/,
  /experiments\/witness-replay/, /reference\/fix\.patch|hidden\/test\.patch/, /\/W8\/wr\/(audit|dry-results|smoke-gate)/];
export const NETWORK = /github\.com|pypi\.org|\bgit\s+(clone|fetch|pull)\b|\bpip\s+(install|download)\b|\bcurl\b|\bwget\b/;
export function leaksOf(sessionsDir: string): { leaks: string[]; network: string[] } {
  const leaks = new Set<string>(), network = new Set<string>();
  if (!existsSync(sessionsDir)) return { leaks: [], network: [] };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith(".jsonl")) continue;
      for (const call of sessionToolCalls(readFileSync(path, "utf8"))) {
        const text = JSON.stringify(call.arguments ?? {});
        if (HIDDEN_PATHS.some(pattern => pattern.test(text))) leaks.add(`${call.name}: ${text.slice(0, 300)}`);
        if (NETWORK.test(text)) network.add(`${call.name}: ${text.slice(0, 300)}`);
      }
    }
  };
  walk(sessionsDir);
  return { leaks: [...leaks], network: [...network] };
}

export async function evaluateAttempt(plan: FrozenPlan, frozenDir: string, attemptDir: string, scratch: string, envRoot: string): Promise<any> {
  const meta = await readJson(join(attemptDir, "meta.json"));
  const seed = plan.seeds.find(item => item.id === meta.seed)!;
  const final = join(attemptDir, "workspace-final");
  const seedTree = join(frozenDir, seed.seedTree);
  const venv = join(envRoot, seed.task, "venv");
  await mkdir(scratch, { recursive: true });
  const witness = await runWitness({ name: `${seed.id}-final`, file: join(frozenDir, seed.witness.path), expectedSha256: seed.witness.sha256, candidate: final, venv, pythonPath: seed.pythonPath, scratch });
  const heldout = seed.heldout ? await runWitness({ name: `${seed.id}-heldout`, file: join(frozenDir, seed.heldout.path), expectedSha256: seed.heldout.sha256, candidate: final, venv, pythonPath: seed.pythonPath, scratch }) : undefined;
  // Grade + visible tests + integrity in the sandbox: repository and inputs read-only, only the output directory writable.
  const gradeOut = join(attemptDir, "grade");
  await mkdir(gradeOut, { recursive: true });
  const tmp = join(scratch, "grade-tmp");
  await mkdir(tmp, { recursive: true });
  const run = await runSandboxed({
    binds: [{ from: REPO }, { from: NODE_DIR }, { from: final }, { from: seedTree }, { from: gradeOut, rw: true }, { from: tmp, rw: true }],
    env: { PATH: `${NODE_DIR}/bin:/usr/bin:/bin`, HOME: tmp, TMPDIR: tmp, LANG: "C.UTF-8", ADVISOR_BENCH_SWE_DIR: resolve(REPO, seed.fixtures), ADVISOR_BENCH_SWE_CACHE: resolve(REPO, seed.cache) },
    cwd: REPO, command: [NODE, "--import", "tsx", join(REPO, "experiments/witness-replay/grade-child.ts"), seed.task, final, seedTree, join(gradeOut, "grade.json")],
  }, { guardMs: 40 * 60_000, stdout: join(gradeOut, "grade-child.log") });
  const graded = existsSync(join(gradeOut, "grade.json")) ? JSON.parse(await readFile(join(gradeOut, "grade.json"), "utf8")) : { error: `grade child exit ${run.code}: ${run.text.slice(-1500)}` };
  const { leaks, network } = leaksOf(join(attemptDir, "sessions"));
  const evaluation = {
    unit: meta.unit, seed: seed.id, arm: meta.arm, role: seed.role, family: seed.family, attempt: meta.attempt, terminal: meta.terminal, valid: meta.valid,
    acceptance: { acceptedDigest: meta.acceptedDigest, finalDigest: meta.finalDigest, intact: meta.acceptanceIntact, witnessFinalDigest: witness.candidateDigest },
    witness: { status: witness.status, reason: witness.reason, cases: witness.result?.cases?.map(c => ({ id: c.id, passed: c.passed })), sha256: witness.witnessSha256, candidateDigest: witness.candidateDigest, protocolRefs: witness.protocolRefs ?? [] },
    heldout: heldout ? { status: heldout.status, reason: heldout.reason, cases: heldout.result?.cases?.map(c => ({ id: c.id, passed: c.passed })) } : undefined,
    grade: graded.grade, gradeError: graded.error, integrityOriginal: graded.integrityOriginal, integritySeed: graded.integritySeed, visible: graded.visible,
    leaks, networkAttempts: network, wire: meta.wire, wallMs: meta.wallMs, invocations: meta.invocations, gateRuns: meta.gateRuns,
    records: { witness, ...(heldout ? { heldout } : {}) },
  };
  await writeJson(join(attemptDir, "evaluation.json"), evaluation);
  return evaluation;
}

/** The decision input of one evaluated unit. */
export function outcomeOf(evaluation: any): Outcome {
  return {
    seed: evaluation.seed, arm: evaluation.arm, role: evaluation.role, family: evaluation.family, terminal: evaluation.terminal,
    witnessPass: evaluation.witness?.status === "pass", ...(evaluation.heldout ? { heldoutPass: evaluation.heldout.status === "pass" } : {}),
    newFailures: evaluation.visible?.newFailures ?? (evaluation.gradeError ? ["(grade error)"] : []), integrityViolations: evaluation.integrityOriginal?.violations ?? [],
    gradePass: evaluation.grade?.passed === true, leakHits: evaluation.leaks ?? [],
  };
}
