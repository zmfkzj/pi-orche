/**
 * Gate smoke (NOT a counted revision session; README.md "Smoke"): a synthetic task built in scratch (no real fixture, no seed of
 * the pilot) whose issue text asks the model to change nothing in its first turn, so that BOTH arm paths run end to end with a
 * real model: C accepts at the first turn end; T's harness run of the reproducer fails, the model receives the gate message in
 * the same session (a second Pi invocation with the same --session-id), repairs, and the second gate run accepts.
 *   node --import tsx experiments/witness-replay/cli.ts smoke-gate <out> <scratch>   → <out>/smoke/gate-<stamp>/summary.json
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "./env.js";
import { freeze } from "./freeze.js";
import type { Seed } from "./protocol.js";
import { runUnit } from "./unit.js";

const TASK = "smoke__calc-1";
const WITNESS = `#!/usr/bin/env python3
"""Smoke reproducer: add(2, 3) must be 5."""
import json, os, sys
import calc
root = os.environ.get("WITNESS_CANDIDATE_ROOT")
trusted = root is None or os.path.realpath(calc.__file__).startswith(os.path.realpath(root) + os.sep)
value = calc.add(2, 3)
ok = trusted and value == 5
print(f"[{'PASS' if value == 5 else 'FAIL'}] add(2, 3): expected 5; observed {value}")
print("WITNESS_RESULT " + json.dumps({"witness": "smoke", "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": [] if trusted else ["calc not from the candidate"], "cases": [{"id": "add", "passed": value == 5}]}))
sys.exit(0 if ok else (1 if trusted else 2))
`;

export async function smokeGate(out: string, scratch: string): Promise<any> {
  const base = join(scratch, "smoke-gate");
  await rm(base, { recursive: true, force: true });
  const fixtures = join(base, "fixtures"), cache = join(base, "cache"), artifact = join(base, "artifact");
  const src = join(cache, TASK, "src");
  await mkdir(join(src, "tests"), { recursive: true });
  await writeFile(join(src, "pyproject.toml"), "[project]\nname = \"calc\"\nversion = \"0\"\n");
  await writeFile(join(src, "calc.py"), "def add(a, b):\n    return a - b\n");
  await writeFile(join(src, "tests/test_calc.py"), "import calc\n\n\ndef test_zero():\n    assert calc.add(0, 0) == 0\n");
  execFileSync("python3", ["-m", "venv", "--without-pip", join(cache, TASK, "venv")]);
  await mkdir(join(fixtures, TASK, "hidden"), { recursive: true });
  await mkdir(join(fixtures, TASK, "reference"), { recursive: true });
  await writeFile(join(fixtures, TASK, "hidden/test.patch"), "--- a/tests/test_calc.py\n+++ b/tests/test_calc.py\n@@ -3,0 +4,3 @@\n+def test_hidden_add_two_and_three():\n+    assert calc.add(2, 3) == 5\n+\n");
  await writeFile(join(fixtures, TASK, "reference/fix.patch"), "--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b  # reference\n");
  await writeJson(join(fixtures, TASK, "task.json"), {
    id: TASK, problemStatement: "add() subtracts\n\n`calc.add(2, 3)` returns -1 instead of 5.\n\nHARNESS SMOKE TEST INSTRUCTION: in your first turn change NO file and reply only with the word ready. Only if you later receive an acceptance-check message, fix `add` and end your turn.",
    testCmd: "pytest -q tests", pythonPath: ".", failToPass: [], passToPass: [],
  });
  // The "archived candidate": an earlier attempt that only added a comment.
  const candidate = join(artifact, "workspace-final");
  await cp(src, candidate, { recursive: true });
  await writeFile(join(candidate, "calc.py"), "def add(a, b):\n    # earlier attempt: looked fine\n    return a - b\n");
  const diff = (() => { try { return execFileSync("git", ["diff", "--no-index", "--", join(src, "calc.py"), join(candidate, "calc.py")]).toString(); } catch (error: any) { return String(error.stdout ?? ""); } })();
  await writeFile(join(artifact, "final.diff"), diff.replaceAll(`a${join(src, "calc.py")}`, "a/calc.py").replaceAll(`b${join(candidate, "calc.py")}`, "b/calc.py"));
  await writeFile(join(base, "witness.py"), WITNESS);
  const seed: Seed = {
    id: "smoke", role: "failure", family: "smoke", task: TASK, fixtures, cache, artifact, witness: join(base, "witness.py"),
    diagnostic: { source: "synthetic", text: "calc.add(2, 3) returned -1 on the unmodified code." },
  };
  const resultsDir = join(base, "results");
  const plan = await freeze(resultsDir, base, [seed], { harnessValidation: true });
  const summary: any = { at: new Date().toISOString(), plan: plan.planDigest, units: {} };
  await Promise.all(plan.schedule.map(async unit => {
    const meta = await runUnit({ plan, frozenDir: join(resultsDir, "frozen"), unit: unit.name, attempt: 1, outDir: join(resultsDir, "units", unit.name, "attempt-1"), scratch: join(base, "u", unit.name), envRoot: join(base, "envs") });
    const invocations = await readJson(join(resultsDir, "units", unit.name, "attempt-1", "invocations.json")).catch(() => []);
    summary.units[unit.name] = { terminal: meta.terminal, valid: meta.valid, invalid: meta.invalid, invocations: invocations.map((item: any) => ({ stop: item.stop, message: item.message, gate: item.gate?.status, next: item.next })), gateRuns: meta.gateRuns, acceptanceIntact: meta.acceptanceIntact, requests: meta.wire?.forwarded, costUSD: meta.wire?.costUSD, refused: meta.wire?.refused, offRouteResponses: meta.wire?.offRouteResponses, finalCalc: execFileSync("cat", [join(resultsDir, "units", unit.name, "attempt-1", "workspace-final", "calc.py")]).toString() };
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeJson(join(out, "smoke", `gate-${stamp}`, "summary.json"), summary);
  await cp(join(resultsDir, "units"), join(out, "smoke", `gate-${stamp}`, "units"), { recursive: true });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}
