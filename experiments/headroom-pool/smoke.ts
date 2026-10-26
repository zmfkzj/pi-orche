/**
 * Harness validation of the headroom-pool baseline unit and scoring (never counted; protocol.ts MAX_SMOKE_SESSIONS):
 *   smoke: a SYNTHETIC case outside every pool (a tiny package with an off-by-one mean, its issue, a public witness, a visible test and
 *          a hidden test) is built (uv venv, package installed non-editable, sealed); ONE baseline attempt runs with the real route and
 *          is scored model-free. Results under results/headroom-pool/smoke/.
 *   probe: model-free; the unit's exact sandbox (staging, binds, environment, unit proxy) runs a shell probe instead of Pi and reports
 *          what a session could see: repository, grader data, other cases, credentials, git history, network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLACEHOLDER_KEY, dirDigest, writeJson } from "../witness-replay/env.js";
import { fileSha256, treeDigest } from "../witness-replay/witness-run.js";
import type { StudyPaths } from "./cases.js";
import { pythonInstallDir, runTests, UV } from "./envbuild.js";
import { freezeCase, freezeRuntime } from "./freeze.js";
import { baselinePrompt, MAX_SMOKE_SESSIONS, type PoolName } from "./protocol.js";
import { scoreAttempt } from "./score.js";
import { runAttempt, type FrozenCase, type FrozenRuntime } from "./unit.js";

export const SMOKE_ISSUE = [
  "`mean()` returns the wrong value",
  "",
  "```python",
  "from smokepkg import mean",
  "print(mean([2, 4]))",
  "```",
  "",
  "This prints `6.0`. Expected `3.0` (the arithmetic mean).",
].join("\n");

const FILES: Record<string, string> = {
  "pyproject.toml": "[build-system]\nrequires = [\"setuptools>=61\"]\nbuild-backend = \"setuptools.build_meta\"\n\n[project]\nname = \"smokepkg\"\nversion = \"0.1.0\"\n\n[tool.setuptools]\npackages = [\"smokepkg\"]\n",
  "smokepkg/__init__.py": "def mean(values):\n    \"\"\"Arithmetic mean of a non-empty sequence of numbers.\"\"\"\n    values = list(values)\n    return sum(values) / (len(values) - 1)\n",
  "tests/test_mean.py": "from smokepkg import mean\n\n\ndef test_single_value_is_rejected_or_returned():\n    assert callable(mean)\n",
  "README.md": "smokepkg: a synthetic package for harness validation.\n",
};
const HIDDEN = "diff --git a/tests/test_mean.py b/tests/test_mean.py\n--- a/tests/test_mean.py\n+++ b/tests/test_mean.py\n@@ -3,3 +3,7 @@ from smokepkg import mean\n \n def test_single_value_is_rejected_or_returned():\n     assert callable(mean)\n+\n+\n+def test_mean_of_two():\n+    assert mean([2, 4]) == 3.0\n";
const WITNESS = `#!/usr/bin/env python3
"""Synthetic smoke witness (harness validation only): mean([2, 4]) must be 3.0 (the issue's expectation)."""
import json, os, sys
def main():
    problems, cases = [], []
    try:
        import smokepkg
        root = os.environ.get("WITNESS_CANDIDATE_ROOT")
        if root and not os.path.realpath(smokepkg.__file__).startswith(os.path.realpath(root) + os.sep):
            problems.append("smokepkg not imported from the candidate")
        observed = smokepkg.mean([2, 4])
        cases.append({"id": "mean-2-4", "passed": observed == 3.0, "observed": observed, "expected": 3.0})
    except Exception as exc:
        cases.append({"id": "mean-2-4", "passed": False, "error": f"{type(exc).__name__}: {exc}"})
    trusted = not problems
    ok = trusted and all(case["passed"] for case in cases)
    print("WITNESS_RESULT " + json.dumps({"witness": "smoke", "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "cases": cases}))
    return 0 if ok else (1 if trusted else 2)
sys.exit(main())
`;
const TEST_CMD = "pytest --no-header -rA --tb=line --color=no -p no:cacheprovider tests/test_mean.py";

/** Build the synthetic case under <out>/case (once). */
export async function buildSmokeCase(paths: StudyPaths, out: string): Promise<FrozenCase> {
  const dir = join(out, "case"), src = join(dir, "src"), venv = join(dir, "venv"), grader = join(dir, "grader");
  if (!existsSync(join(dir, "case.json"))) {
    for (const [path, text] of Object.entries(FILES)) { await mkdir(join(src, path, ".."), { recursive: true }); await writeFile(join(src, path), text); }
    const uvEnv = { ...process.env, UV_CACHE_DIR: join(paths.roots.cache, "_uv-cache"), UV_PYTHON_INSTALL_DIR: pythonInstallDir(paths.roots), UV_PYTHON_PREFERENCE: "only-managed", UV_NO_CONFIG: "1" };
    const executable = realpathSync(execFileSync(UV, ["python", "find", "3.12"], { env: uvEnv }).toString().trim());
    execFileSync(UV, ["venv", "--python", executable, venv], { env: uvEnv, stdio: "ignore" });
    execFileSync(UV, ["pip", "install", "--python", join(venv, "bin/python"), "--exclude-newer", "2026-01-01T00:00:00Z", src, "pytest"], { env: uvEnv, stdio: "ignore" });
    execFileSync("chmod", ["-R", "a-w", venv]);
    await mkdir(grader, { recursive: true });
    await writeFile(join(grader, "test.patch"), HIDDEN);
    await writeJson(join(grader, "record.json"), { id: "smoke", failToPass: ["tests/test_mean.py::test_mean_of_two"], passToPass: ["tests/test_mean.py::test_single_value_is_rejected_or_returned"], testCmd: TEST_CMD });
    await writeFile(join(dir, "witness.py"), WITNESS);
    await writeFile(join(dir, "prompt.txt"), baselinePrompt({ problemStatement: SMOKE_ISSUE }));
    const c: FrozenCase = {
      id: "smoke", repo: "synthetic/smokepkg", pool: "smoke", src, srcDigest: treeDigest(src), venv, venvDigest: dirDigest(venv), pythonPath: ".", pythonInstallDir: pythonInstallDir(paths.roots),
      pythonSha256: fileSha256(executable), pythonExecutable: executable, prompt: { path: join(dir, "prompt.txt"), sha256: fileSha256(join(dir, "prompt.txt")) },
      witness: { path: join(dir, "witness.py"), sha256: fileSha256(join(dir, "witness.py")) }, testCmd: TEST_CMD,
    };
    const visible = await runTests({ venv, pythonDir: c.pythonInstallDir, tree: src, layout: ".", testCmd: c.testCmd, scratch: paths.roots.scratch });
    await writeJson(join(grader, "validation.json"), { visible: { statuses: visible.statuses }, excludedP2P: [] });
    await writeJson(join(dir, "case.json"), c);
  }
  return JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
}

/** The runtime of smoke and probe sessions (frozen once under <out>). */
export async function smokeRuntime(out: string): Promise<FrozenRuntime> {
  const runtimeFile = join(out, "runtime.json");
  if (!existsSync(runtimeFile)) { await mkdir(out, { recursive: true }); await writeJson(runtimeFile, await freezeRuntime(out)); }
  return JSON.parse(readFileSync(runtimeFile, "utf8"));
}

/** The shell probe a unit sandbox runs instead of Pi. */
export function probeScript(paths: StudyPaths, c: FrozenCase): string {
  const home = process.env.HOME ?? "/home";
  const targets = [paths.repo, join(paths.repo, ".git"), join(paths.repo, "experiments"), join(paths.out, "grader"), join(paths.out, "frozen"), join(paths.out, "packets"), join(paths.out, "qualification"), join(paths.out, "calibration"), join(paths.out, "raw"), join(paths.repo, "results/iso-token"), join(home, ".pi"), join(home, "Code"), join(paths.roots.scratch, "units"), "/tmp", "/var/tmp", "/root"];
  return [
    `check() { if [ -e "$1" ]; then printf 'VISIBLE %s -> %s\\n' "$1" "$(ls -A "$1" 2>/dev/null | head -8 | tr '\\n' ' ')"; else printf 'hidden %s\\n' "$1"; fi; }`,
    ...targets.map(target => `check '${target}'`),
    `printf 'cache entries -> %s\\n' "$(ls -A '${paths.roots.cache}' 2>/dev/null | tr '\\n' ' ')"`,
    `printf 'case cache entries -> %s\\n' "$(ls -A '${join(paths.roots.cache, c.id)}' 2>/dev/null | tr '\\n' ' ')"`,
    `printf 'env names with key/token/secret -> %s\\n' "$(env | grep -i -E 'key|token|secret|passw' | sed 's/=.*//' | tr '\\n' ' ')"`,
    `if grep -q '${PLACEHOLDER_KEY}' "$PI_CODING_AGENT_DIR/cliproxyapi.json"; then echo 'agent key: placeholder'; else echo 'agent key: NOT the placeholder'; fi`,
    `printf 'git objects -> %s\\n' "$(git count-objects -v 2>&1 | tr '\\n' ' ')"`,
    `printf 'git log -> %s\\n' "$(git log --oneline -1 2>&1 | head -1)"`,
    `printf 'workspace -> %s\\n' "$(pwd) $(ls -A | head -12 | tr '\\n' ' ')"`,
    `python -c "import sys; print('python', sys.version.split()[0])"`,
    `(python -c "import urllib.request; urllib.request.urlopen('https://pypi.org', timeout=5)" >/dev/null 2>&1 && echo 'NETWORK yes') || echo 'network no'`,
  ].join("\n");
}

/** Model-free sandbox probe for the smoke case or a pool case (`pool`, `id`). */
export async function runProbe(paths: StudyPaths, out: string, pool?: PoolName, id?: string): Promise<{ text: string; meta: any }> {
  const runtime = await smokeRuntime(out);
  const c = pool && id ? (await freezeCase(paths, pool, id, join(out, "probe-freeze"))).c : await buildSmokeCase(paths, out);
  const name = `probe-${c.id}`, outDir = join(out, name);
  const meta = await runAttempt({ runtime, c, unit: name, attempt: 1, outDir, scratch: join(paths.roots.scratch, "probe", c.id), commandOverride: ["/bin/sh", "-c", probeScript(paths, c)] });
  const text = existsSync(join(outDir, "events.jsonl")) ? readFileSync(join(outDir, "events.jsonl"), "utf8") : "";
  await writeFile(join(outDir, "probe.txt"), text);
  return { text, meta };
}

/** One smoke attempt (counted against MAX_SMOKE_SESSIONS by the attempt directories under <out>/attempts). */
export async function runSmoke(paths: StudyPaths, out: string): Promise<{ meta: any; score?: any }> {
  const c = await buildSmokeCase(paths, out);
  const runtime = await smokeRuntime(out);
  await mkdir(join(out, "attempts"), { recursive: true });
  const done = execFileSync("ls", [join(out, "attempts")]).toString().split("\n").filter(Boolean).length;
  if (done >= MAX_SMOKE_SESSIONS) throw new Error(`the smoke budget of ${MAX_SMOKE_SESSIONS} sessions is spent`);
  const attemptDir = join(out, "attempts", `attempt-${done + 1}`);
  const meta = await runAttempt({ runtime, c, unit: "smoke", attempt: done + 1, outDir: attemptDir, scratch: join(paths.roots.scratch, "smoke", `a${done + 1}`) });
  if (!meta.valid) return { meta };
  const score = await scoreAttempt({ c, attemptDir, graderDir: join(out, "case", "grader"), scratch: join(paths.roots.scratch, "smoke-score") });
  return { meta, score };
}
