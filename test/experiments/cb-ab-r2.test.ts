import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha } from "../../experiments/mdsd-ab/run.js";
import { analyze, gateOf, runStatus, summarizeRows, verdictOf, type CaseInfo, type RunRow } from "../../experiments/cb-ab/analysis-r2.js";
import { runDriver } from "../../experiments/cb-ab/driver.js";
import { HOME, REPO, loadCase } from "../../experiments/cb-ab/env.js";
import { diagnosisPrompt } from "../../experiments/cb-ab/protocol.js";
import { packets } from "../../experiments/cb-ab/score.js";
import { finishRecord, readPool, selectCases } from "../../experiments/cb-ab/screen.js";
import { applyPatch, e3Check, e3Names, isNonTestSource, parsePatch, patchWithout } from "../../experiments/cb-ab/verify.js";

/**
 * The round-2 rules without a model: explicit run status (R2-A1 item 1), the analysis set with explicit saturation and
 * reproducibility (item 2), the gate and verdict with fewer cases, the deterministic screening verifier (fake probes, hunk-removal
 * patches), E3, selection with measured headroom (item 4), the pool reader, and the arm-A-only options of run.ts driver / score.ts.
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "cb-ab-r2-test-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const json = (file: string, value: unknown) => write(file, JSON.stringify(value));
const ISORT_VENV = join(REPO, "results/advisor-reviewer/cache/swe/pycqa__isort-2491/venv");
const hasBwrap = spawnSync("bwrap", ["--version"]).status === 0 && existsSync(join(ISORT_VENV, "bin/python"));
const ARMS = ["A", "B", "C"] as const;

type RunPlan = { report?: boolean; route?: boolean; guard?: boolean; infra?: boolean; status?: string; providerStop?: boolean };
const metaOf = (unit: string, plan: RunPlan = {}) => ({ unit, status: plan.status ?? "completed", infra: plan.infra ?? false, pi: { code: 0, guardFired: plan.guard ?? false }, final: { report: plan.report ?? true }, route: plan.route === false ? { ok: false, violations: 2, byKind: { model: 2 } } : { ok: true, violations: 0, byKind: {} } });
const entry = (found: Record<string, boolean>, counts = { V: 1, F: 0, U: 0 }) => ({
  k: Object.entries(found).map(([k, yes]) => ({ k, m: yes ? 1 : 0, l: 1, s: 1, quote: `M: "${k}" | L: "f.py:1" | S: "x"` })),
  findings: [...Array(counts.V).fill("V"), ...Array(counts.F).fill("F"), ...Array(counts.U).fill("U")].map((cls, index) => ({ id: `f${index + 1}`, claim: "c", class: cls, reason: "r", evidence: "cmd -> out" })), notes: "",
});

/** A study with runs, key, packets.json, cases (rubric) and one scorer's scores (per unit: the K found map, or "absent"/"missingK2"). */
async function study(plan: { cases: string[]; runs?: Record<string, RunPlan>; scores: Record<string, Record<string, boolean> | "absent" | "missingK2"> }) {
  const root = await temp();
  const s = join(root, "study"), casesDir = join(root, "cases"), scoresRoot = join(root, "scoring-sol");
  const key: Record<string, unknown> = {}, index: Record<string, unknown[]> = {}, byCase: Record<string, Record<string, unknown>> = {};
  for (const [n, caseId] of plan.cases.entries()) {
    json(join(casesDir, `${caseId}-t${n}`, "case.json"), { id: caseId, order: n + 1, task: `t${n}` });
    json(join(casesDir, `${caseId}-t${n}`, "rubric.json"), { knownDefects: [{ id: "K1" }, { id: "K2" }] });
    index[caseId] = []; byCase[caseId] = {};
    for (const arm of ARMS) for (const repeat of [1, 2]) {
      const unit = `${caseId}/${arm}/r${repeat}`, label = sha(unit).slice(0, 6);
      const runPlan = plan.runs?.[unit];
      json(join(s, "runs", unit, "meta.json"), metaOf(unit, runPlan));
      write(join(s, "runs", unit, "wire.jsonl"), runPlan?.providerStop ? `${JSON.stringify({ method: "POST", model: "gpt-6.1-sol", providerError: { type: "invalid_request", code: "cyber_policy" } })}\n` : "");
      key[label] = { unit, arm, repeat };
      index[caseId]!.push({ label, packetSha256: "x" });
      const score = plan.scores[unit] ?? { K1: true, K2: true };
      if (score === "absent") continue;
      byCase[caseId]![label] = score === "missingK2" ? { ...entry({ K1: true }) } : entry(score);
    }
    json(join(scoresRoot, "S1", caseId, "scores.json"), { case: caseId, scorer: { scorerId: "S1" }, packets: byCase[caseId] });
    json(join(scoresRoot, "S1", caseId, "validation.json"), { compliant: true, finalRun: 1 });
  }
  json(join(s, "scoring/key.json"), key);
  json(join(s, "scoring/packets.json"), { index });
  return { root, study: s, casesDir, scoresRoot, labelOf: (unit: string) => sha(unit).slice(0, 6) };
}

describe("run status (R2-A1 item 1)", () => {
  it("completed / missing (a provider stop like c2/A/r1, a guard kill, infrastructure, an unfinished unit) / non-compliant (route); every reason listed", () => {
    expect(runStatus(metaOf("u"))).toMatchObject({ status: "completed", reasons: [] });
    const stopped = runStatus(metaOf("c2/A/r1", { report: false }), [{ method: "GET" }, { method: "POST", model: "gpt-6.1-sol", providerError: { type: "invalid_request", code: "cyber_policy" } }]);
    expect(stopped).toEqual({ status: "missing", reasons: ["no final report (provider stop: invalid_request/cyber_policy)"], providerErrors: ["invalid_request/cyber_policy"] });
    expect(runStatus(metaOf("u", { guard: true }))).toMatchObject({ status: "missing", reasons: ["killed by the process guard"] });
    expect(runStatus(metaOf("u", { infra: true, report: false }))).toMatchObject({ status: "missing", reasons: ["no successful model request (infrastructure)", "no final report"] });
    expect(runStatus(metaOf("u", { status: "interrupted" }))).toMatchObject({ status: "missing", reasons: ["unit interrupted"] });
    expect(runStatus(undefined)).toMatchObject({ status: "missing", reasons: ["no unit evidence (meta.json)", "no route check"] });
    expect(runStatus(metaOf("u", { route: false }))).toMatchObject({ status: "non-compliant", reasons: ['route violations: 2 {"model":2}'] });
    expect(runStatus(metaOf("u", { route: false, report: false }))).toMatchObject({ status: "missing", reasons: ["no final report", 'route violations: 2 {"model":2}'] });
    expect(runStatus({ ...metaOf("u"), route: undefined })).toMatchObject({ status: "non-compliant", reasons: ["no route check"] });
  });
});

describe("analysis set, saturation, reproducibility, gate and verdict (R2-A1 item 2)", () => {
  it("a provider-stopped A repeat is missing (never zero): saturation unknown and not saturated for the gate, reproducibility n/a; an unscored packet is left out; the gate stops; the differences from score.ts are listed", async () => {
    const s = await study({
      cases: ["c1", "c2", "c3"],
      runs: { "c2/A/r1": { report: false, providerStop: true } },
      scores: { "c2/A/r1": "absent", "c1/C/r2": "missingK2", "c3/A/r1": { K1: true, K2: false } },
    });
    const a = analyze(s.study, s.casesDir, s.scoresRoot, "S1");
    const [c1, c2, c3] = a.cases;
    expect(c1).toMatchObject({ saturation: true, n: { A: 2, B: 2, C: 1 }, reproducibility: { A: ["K1", "K2"], B: ["K1", "K2"], C: "n/a" } });
    expect(c1!.leftOut).toEqual([{ unit: "c1/C/r2", why: "packet unscored: K2: no entry" }]);
    expect(c2).toMatchObject({ saturation: "unknown", n: { A: 1, B: 2, C: 2 }, foundBy: { A: ["K1", "K2"] }, reproducibility: { A: "n/a", B: ["K1", "K2"] }, bUniqueVsA: [] });
    expect(c2!.saturationNote).toBe("saturation unknown: 1 of 2 A repeats in the analysis set (flagged; not saturated for the gate)");
    expect(c2!.leftOut).toEqual([{ unit: "c2/A/r1", why: "run missing: no final report (provider stop: invalid_request/cyber_policy)" }]);
    const missing = a.runs.find(row => row.unit === "c2/A/r1")!;
    expect(missing).toMatchObject({ runStatus: "missing", packetStatus: "not scored (run missing)", inSet: false });
    expect(missing.k).toBeUndefined();
    expect(c3).toMatchObject({ saturation: false, foundBy: { A: ["K1", "K2"] }, reproducibility: { A: ["K1"] } });
    expect(c2!.meanV).toEqual({ A: 1, B: 1, C: 1 });
    // Gate on c1 and c2: B-unique empty in both, not both saturated (c2 unknown) -> stop; the verdict is not supported by rule.
    expect(a.gate).toMatchObject({ applicable: true, cases: ["c1", "c2"], stop: true, saturatedForGate: { c1: true, c2: false }, saturation: { c1: true, c2: "unknown" } });
    expect(a.result).toMatchObject({ verdict: "not-supported", stoppedByRule: true, details: { cases: 2 } });
    // score.ts semantics on the same scores: c2 saturated by its single A run -> both gate cases saturated -> no stop.
    const lines = a.differencesFromRound1.onTheseScores.join("\n");
    expect(lines).toContain("c2: saturation — score.ts semantics true (A runs present: 1), R2-A1 unknown");
    expect(lines).toContain("gate — score.ts semantics stop=false, R2-A1 stop=true");
    expect(lines).toContain("c1 c1/C/r2 (" + s.labelOf("c1/C/r2") + "): no K2 entry -> score.ts:82 would count m=l=s=0; here the packet is unscored");
    expect(lines).toContain("c2/A: reproducibility — score.ts every() gives [\"K1\",\"K2\"] over 1 run(s); here \"n/a\"");
    expect(a.differencesFromRound1.rules.join("\n")).toMatch(/score\.ts:82/);
  });

  it("a non-compliant run is left out; B-unique counts only analysis-set runs", async () => {
    const s = await study({ cases: ["c1"], runs: { "c1/A/r1": { route: false } }, scores: { "c1/A/r1": { K1: true, K2: true }, "c1/A/r2": { K1: false, K2: true } } });
    const [c1] = analyze(s.study, s.casesDir, s.scoresRoot, "S1").cases;
    expect(c1).toMatchObject({ n: { A: 1 }, foundBy: { A: ["K2"], B: ["K1", "K2"] }, bUniqueVsA: ["K1"], saturation: "unknown" });
    expect(c1!.leftOut[0]!.why).toMatch(/^run non-compliant: route violations/);
  });

  it("gate with fewer cases: one case -> no gate, a descriptive verdict that cannot be supported; no case -> unresolved", () => {
    const info: CaseInfo = { id: "c1", order: 1, dir: "/x", kItems: ["K1"] };
    const row = (arm: "A" | "B" | "C", repeat: number, found: boolean): RunRow => ({ unit: `c1/${arm}/r${repeat}`, caseId: "c1", arm, repeat, runStatus: "completed", runReasons: [], packetStatus: "scored", packetProblems: [], inSet: true, k: { K1: { m: found ? 1 : 0, l: 1, s: 1, found } }, counts: { V: 0, F: 0, U: 0 } });
    const one = summarizeRows(info, [row("A", 1, false), row("A", 2, false), row("B", 1, true), row("B", 2, false), row("C", 1, false), row("C", 2, false)]);
    expect(one).toMatchObject({ bUniqueVsA: ["K1"], bUniqueVsC: ["K1"], saturation: false, reproducibility: { B: [] } });
    const gate = gateOf([one]);
    expect(gate).toEqual({ applicable: false, reason: "fewer than two cases (1): no stop gate" });
    expect(verdictOf([one], gate)).toMatchObject({ verdict: "not-supported", stoppedByRule: false, note: expect.stringMatching(/one case/) });
    expect(verdictOf([], gateOf([]))).toMatchObject({ verdict: "unresolved" });
  });
});

describe("screening verifier", () => {
  it("patch parsing: hunks indexed over the whole patch with D2's non-test flag; a removed '--' line is not a file header; the patch minus hunks keeps the rest and drops emptied files", () => {
    const patch = [
      "diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,2 @@", "--- old comment", "+++ new comment", " select 1;",
      "diff --git a/pkg/a.py b/pkg/a.py", "index 1..2 100644", "--- a/pkg/a.py", "+++ b/pkg/a.py", "@@ -1,3 +1,3 @@", " x = 1", "-y = 2", "+y = 3", " z = 4", "@@ -10,2 +10,2 @@ def f():", "-    return 1", "+    return 2", "\\ No newline at end of file",
      "diff --git a/tests/test_a.py b/tests/test_a.py", "--- a/tests/test_a.py", "+++ b/tests/test_a.py", "@@ -1 +1 @@", "-a", "+b", "",
    ].join("\n");
    const parsed = parsePatch(patch);
    expect(parsed.files.map(file => file.file)).toEqual(["q.sql", "pkg/a.py", "tests/test_a.py"]);
    expect(parsed.hunks.map(hunk => [hunk.index, hunk.file, hunk.nonTestSource])).toEqual([[0, "q.sql", false], [1, "pkg/a.py", true], [2, "pkg/a.py", true], [3, "tests/test_a.py", false]]);
    expect(parsed.hunks[2]!.lines.at(-1)).toBe("\\ No newline at end of file\n");
    expect(patchWithout(patch, [])).toBe(patch);
    const minus = patchWithout(patch, [0, 2]);
    expect(minus).not.toContain("q.sql");
    expect(minus).toContain("-y = 2");
    expect(minus).not.toContain("return 2");
    expect(minus).toContain("diff --git a/tests/test_a.py");
    expect(["src/pkg/x.py", "pkg/test_x.py", "pkg/x_test.py", "conftest.py", "docs/conf.py", "examples/e.py", "testing/t.py", "pkg/x.txt"].map(isNonTestSource)).toEqual([true, false, false, false, false, false, false, false]);
  });

  it("E3: file basename and stem, function and class names; case-insensitive whole words only", () => {
    expect(e3Names({ file: "src/pkg/util.py", function: "Parser.parse_comment (override)" })).toEqual(["util.py", "util", "Parser", "parse_comment"]);
    expect(e3Check("Calling UTIL.PY fails", [{ file: "pkg/util.py" }])).toEqual({ met: false, named: ["util.py", "util"], checked: ["util.py", "util"] });
    expect(e3Check("utilities.py fails", [{ file: "pkg/util.py" }])).toEqual({ met: true, named: [], checked: ["util.py", "util"] });
    expect(e3Check("the utility module and HTMLParser behave", [{ file: "pkg/util.py", function: "Parser.run" }])).toEqual({ met: true, named: [], checked: ["util.py", "util", "Parser", "run"] });
    expect(e3Check("see parse_comment() for details", [{ file: "a/htmlparser.py", function: "HTMLExtractor.parse_comment" }]).named).toEqual(["parse_comment"]);
  });

  it.skipIf(!hasBwrap)("fake probes on fresh copies: pre-fix fails, the full fix passes, the fix minus the candidate's hunks fails -> verified; a probe passing before the fix and an invalid hunk are not; E2, E3; the eligible record becomes a case dir run.ts accepts", async () => {
    const root = await temp();
    const src = join(root, "src");
    const lines = ["def double(x):", "    return x + x + 1", "", "", ...Array.from({ length: 8 }, (_, i) => `# padding ${i + 1}`), "", "", "def name_upper(s):", "    return s.lower()", ""];
    write(join(src, "pkg/__init__.py"), ""); write(join(src, "pkg/mod.py"), lines.join("\n")); write(join(src, "pyproject.toml"), "[project]\nname = \"toy\"\n");
    const reference = [
      "diff --git a/pkg/mod.py b/pkg/mod.py", "--- a/pkg/mod.py", "+++ b/pkg/mod.py",
      "@@ -1,4 +1,4 @@", " def double(x):", "-    return x + x + 1", "+    return x + x", " ", " ",
      "@@ -13,4 +13,4 @@", " ", " ", " def name_upper(s):", "-    return s.lower()", "+    return s.upper()", "",
    ].join("\n");
    // The hunk-removal patch applies on its own (git apply, no repository).
    const check = join(root, "check"); mkdirSync(check); spawnSync("cp", ["-a", `${src}/.`, check]);
    expect(applyPatch(check, patchWithout(reference, [0]))).toBeUndefined();
    expect(readFileSync(join(check, "pkg/mod.py"), "utf8")).toContain("return x + x + 1\n");
    expect(readFileSync(join(check, "pkg/mod.py"), "utf8")).toContain("return s.upper()");
    const record = join(root, "out/records/toy");
    write(join(record, "output/probes/k1_double.py"), "import sys\nfrom pkg.mod import double\nprint('double(2) =', double(2))\nsys.exit(0 if double(2) == 4 else 1)\n");
    write(join(record, "output/probes/k2_upper.py"), "import sys\nfrom pkg.mod import name_upper\nsys.exit(0 if name_upper('ab') == 'AB' else 1)\n");
    write(join(record, "output/probes/k3_always.py"), "import sys\nsys.exit(0)\n");
    const output = {
      task: "toy", e1: { met: true, reason: "a wrong result of existing functionality" },
      candidates: [
        { id: "K1", title: "double adds one", mechanism: "double returns x + x + 1.", locations: [{ file: "pkg/mod.py", function: "double", lines: "1-2" }], scenario: "double(2) -> 5, expected 4", hunks: [0], recoverability: "the issue names double", probe: "k1_double.py" },
        { id: "K2", title: "name_upper lowers", mechanism: "name_upper calls lower().", locations: [{ file: "pkg/mod.py", function: "name_upper", lines: "15-16" }], scenario: "name_upper('ab') -> 'ab'", hunks: [1], recoverability: "same contract", probe: "k2_upper.py" },
        { id: "K3", title: "not specific", mechanism: "m", locations: [{ file: "pkg/mod.py", function: "double" }], scenario: "s", hunks: [0], recoverability: "r", probe: "k3_always.py" },
        { id: "K4", title: "bad hunk", mechanism: "m", locations: [{ file: "pkg/mod.py" }], scenario: "s", hunks: [7], recoverability: "r", probe: "k1_double.py" },
      ],
      scope: { inScope: "wrong arithmetic or case mapping in pkg.mod", outOfScope: "style", examples: [] },
    };
    write(join(record, "output/screening.json"), JSON.stringify(output));
    const task = { id: "toy", repo: "example/toy", baseCommit: "abc", problemStatement: "double() returns the wrong value", pythonPath: ".", pythonVersion: "Python 3" };
    write(join(root, "fixture/task.json"), JSON.stringify(task)); write(join(root, "fixture/fix.patch"), reference); write(join(root, "fixture/test.patch"), "");
    const paths = { id: "toy", taskJson: join(root, "fixture/task.json"), reference: join(root, "fixture/fix.patch"), hidden: join(root, "fixture/test.patch"), src, venv: ISORT_VENV };
    const result: any = await finishRecord({ id: "toy", n: 7, tranche: "T1", outDir: join(root, "out"), scratch: join(root, "scratch"), log: () => undefined }, record, paths, task, reference, "toy", { routeOk: true, requests: 1, costUSD: 0 });
    expect(result.verified).toEqual(["K1", "K2"]);
    expect(result).toMatchObject({ e2: true, eligible: true, caseDir: "c7-toy", reasons: [] });
    const byId = Object.fromEntries(result.candidates.map((item: any) => [item.id, item]));
    expect(byId.K1.runs).toMatchObject({ pre: { exit: 1, timedOut: false }, fix: { exit: 0 }, minus: { exit: 1 } });
    expect(byId.K3.reasons).toEqual(["the probe passes on the pre-fix snapshot (must fail)", "the probe passes with the reference fix minus this candidate's hunks (must fail)"]);
    expect(byId.K4.reasons).toEqual(["hunk 7 is not an index of the reference patch (0..1)"]);
    expect(result.e3).toEqual({ K1: { met: false, named: ["double"], checked: ["mod.py", "mod", "double"] }, K2: { met: true, named: [], checked: ["mod.py", "mod", "name_upper"] } });
    expect(result.hunkOverlaps).toEqual(["K1 and K3 share hunk(s) 0"]);
    expect(readFileSync(byId.K1.runs.pre.log.startsWith("/") ? byId.K1.runs.pre.log : join(REPO, byId.K1.runs.pre.log), "utf8")).toContain("double(2) = 5");
    // The case dir: case.json (protocol.ts diagnosisPrompt of the verbatim issue) accepted by run.ts loadCase; the verified defects only.
    const caseDir = join(root, "out/c7-toy");
    const loaded = loadCase(caseDir);
    expect(loaded).toMatchObject({ id: "c7", order: 7, task: "toy", projectDir: "toy", sourceDir: src, venvDir: ISORT_VENV });
    expect(loaded.prompt).toBe(diagnosisPrompt({ repo: "example/toy", baseCommit: "abc", problemStatement: "double() returns the wrong value" }));
    const rubric = JSON.parse(readFileSync(join(caseDir, "rubric.json"), "utf8"));
    expect(rubric.knownDefects.map((item: any) => [item.id, item.hunks, item.namedInIssue])).toEqual([["K1", [0], true], ["K2", [1], false]]);
    expect(rubric.knownDefects[0].scoring.L).toContain("pkg/mod.py double");
    expect(rubric.verification.unverified.map((item: any) => item.id)).toEqual(["K3", "K4"]);
    expect(readdirSync(join(caseDir, "probes")).sort()).toEqual(["k1_double.py", "k2_upper.py", "k3_always.py"]);
    expect(existsSync(join(caseDir, "rubric.md")) && existsSync(join(caseDir, "verification/verification.json"))).toBe(true);
    // An E1 failure or a route-violating screener session never makes a case.
    write(join(record, "output/screening.json"), JSON.stringify({ ...output, e1: { met: false, reason: "a feature request" } }));
    const rejected: any = await finishRecord({ id: "toy", n: 7, tranche: "T1", outDir: join(root, "out"), scratch: join(root, "scratch"), log: () => undefined }, record, paths, task, reference, "toy", { routeOk: false });
    expect(rejected).toMatchObject({ eligible: false, caseDir: null });
    expect(rejected.reasons).toEqual(["E1 not met: a feature request", "the screener session was not route-compliant (model rule): its output cannot make a case"]);
    expect(existsSync(caseDir)).toBe(false);
  }, 60_000);
});

describe("qualifying and selection (R2-A1 item 4)", () => {
  /** Eligible case dirs c1..c5 and a calibration study: per case, A r1/r2 run plans and the scorer's found maps. */
  async function calibration(plan: Record<string, { runs?: Record<number, RunPlan>; scores: Record<number, Record<string, boolean> | "absent" | "missingK2"> }>) {
    const root = await temp();
    const outDir = join(root, "cases-r2"), cal = join(root, "cal"), scores = join(root, "cal-scores/S1");
    const key: Record<string, unknown> = {}, index: Record<string, unknown[]> = {};
    for (const [caseId, item] of Object.entries(plan)) {
      const n = Number(caseId.slice(1));
      json(join(outDir, `${caseId}-task${n}`, "case.json"), { id: caseId, order: n, task: `task${n}`, prompt: "p" });
      json(join(outDir, `${caseId}-task${n}`, "rubric.json"), { knownDefects: [{ id: "K1" }, { id: "K2" }] });
      index[caseId] = [];
      const packetsOut: Record<string, unknown> = {};
      for (const repeat of [1, 2]) {
        const unit = `${caseId}/A/r${repeat}`, label = sha(unit).slice(0, 6);
        json(join(cal, "runs", unit, "meta.json"), metaOf(unit, item.runs?.[repeat]));
        write(join(cal, "runs", unit, "wire.jsonl"), item.runs?.[repeat]?.providerStop ? `${JSON.stringify({ method: "POST", model: "gpt-6.1-sol", providerError: { type: "invalid_request", code: "cyber_policy" } })}\n` : "");
        key[label] = { unit, arm: "A", repeat };
        index[caseId]!.push({ label, packetSha256: "x" });
        const score = item.scores[repeat]!;
        if (score === "absent") continue;
        packetsOut[label] = score === "missingK2" ? entry({ K1: true }) : entry(score);
      }
      json(join(scores, caseId, "scores.json"), { case: caseId, packets: packetsOut });
      json(join(scores, caseId, "validation.json"), { compliant: true });
    }
    json(join(cal, "scoring/key.json"), key);
    json(join(cal, "scoring/packets.json"), { index });
    return { root, outDir, cal, scores, selected: join(root, "selected") };
  }

  it("headroom only from completed, compliant, scored reports: a miss in a missing (provider-stopped), non-compliant or unscored report is no evidence; fewer than three qualify -> the protocol's fallback is recorded", async () => {
    const c = await calibration({
      c1: { scores: { 1: { K1: true, K2: true }, 2: { K1: true, K2: true } } },
      c2: { scores: { 1: { K1: true, K2: false }, 2: { K1: true, K2: true } } },
      c3: { runs: { 1: { report: false, providerStop: true } }, scores: { 1: { K1: false, K2: false }, 2: { K1: true, K2: true } } },
      c4: { scores: { 1: "missingK2", 2: { K1: true, K2: true } } },
      c5: { runs: { 1: { route: false } }, scores: { 1: { K1: false, K2: true }, 2: { K1: true, K2: true } } },
    });
    const selection: any = selectCases(c.outDir, c.cal, c.scores, c.selected);
    expect(selection.candidates.map((item: any) => [item.caseId, item.qualifies])).toEqual([["c1", false], ["c2", true], ["c3", false], ["c4", false], ["c5", false]]);
    expect(selection.candidates[1].missed).toEqual([{ unit: "c2/A/r1", k: "K2" }]);
    expect(selection.candidates[2].reports[0]).toMatchObject({ runStatus: "missing", packetStatus: "not scored (run missing)", inSet: false, why: "run missing: no final report (provider stop: invalid_request/cyber_policy)" });
    expect(selection.candidates[3].reports[0]).toMatchObject({ runStatus: "completed", packetStatus: "unscored", inSet: false });
    expect(selection.candidates[4].reports[0]).toMatchObject({ runStatus: "non-compliant", inSet: false });
    expect(selection.selected).toEqual([{ as: "c1-task2", from: "c2-task2", task: "task2", n: 2 }]);
    expect(selection.fewerThanThree).toMatch(/^1 case: validated descriptively; the verdict cannot be supported/);
    const spec = JSON.parse(readFileSync(join(c.selected, "c1-task2/case.json"), "utf8"));
    expect(spec).toMatchObject({ id: "c1", order: 1, task: "task2" });
    expect(existsSync(join(c.selected, "selection.json"))).toBe(true);
    expect(() => selectCases(c.outDir, c.cal, c.scores, c.selected)).toThrow(/written once/);
  });

  it("the first three qualifying in pool order become c1, c2, c3", async () => {
    const miss = { scores: { 1: { K1: false, K2: true }, 2: { K1: true, K2: true } } };
    const c = await calibration({ c4: miss, c2: miss, c9: miss, c7: miss, c1: { scores: { 1: { K1: true, K2: true }, 2: { K1: true, K2: true } } } });
    const selection: any = selectCases(c.outDir, c.cal, c.scores, c.selected);
    expect(selection.selected.map((item: any) => [item.as, item.from])).toEqual([["c1-task2", "c2-task2"], ["c2-task4", "c4-task4"], ["c3-task7", "c7-task7"]]);
    expect(selection.fewerThanThree).toBeUndefined();
  });
});

describe("pool and arm-A-only calibration options", () => {
  it("pool formats: tranches, top-level T1/T2, records with a tranche; N = order when given, else the position over T1 then T2", () => {
    expect(readPool({ tranches: { T1: ["a", "b"], T2: ["c"] } }, "T2")).toEqual([{ id: "c", n: 3, tranche: "T2" }]);
    expect(readPool({ T1: [{ id: "a", order: 5 }, "b"] }, "T1")).toEqual([{ id: "a", n: 5, tranche: "T1" }, { id: "b", n: 2, tranche: "T1" }]);
    expect(readPool([{ id: "x", tranche: "T1" }, { id: "y", tranche: "T2" }], "T2")).toEqual([{ id: "y", n: 2, tranche: "T2" }]);
    expect(() => readPool({ T1: [] }, "T2")).toThrow(/no tranche T2/);
    expect(() => readPool({ T1: ["../x"] }, "T1")).toThrow(/no valid id/);
  });

  it("run.ts driver --arms A runs only arm A's units (default: every arm); score.ts packets --arms A packets only A units (default: every arm must be completed)", async () => {
    const root = await temp();
    const s = join(root, "study");
    json(join(s, "environment.json"), {});
    mkdirSync(join(root, "src")); write(join(root, "venv/bin/python"), "");
    const caseDir = join(root, "cases/c1-t");
    json(join(caseDir, "case.json"), { id: "c1", order: 1, task: "t", repo: "r", baseCommit: "b", projectDir: "p", pythonPath: ".", prompt: "p", promptSha256: sha("p"), source: join(root, "src"), venv: join(root, "venv") });
    write(join(root, "unit.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";',
      "const [study, , arm, repeat] = process.argv.slice(3); const dir = join(study, \"runs\", \"c1\", arm, \"r\" + repeat); mkdirSync(dir, { recursive: true });",
      'writeFileSync(join(dir, "wire.jsonl"), JSON.stringify({ method: "POST", model: "gpt-6.1-sol", status: 200, usage: { input: 1, cached: 0, output: 1, reasoning: 0 } }) + "\\n");',
      'writeFileSync(join(dir, "final.json"), JSON.stringify({ report: { arguments: { summary: "s " + arm } }, text: "t" }));',
      'writeFileSync(join(dir, "meta.json"), JSON.stringify({ status: "completed", successfulRequests: 1, infra: false, pi: { code: 0 }, final: { report: true } }));',
    ].join("\n"));
    const command = (unit: { caseDir: string; arm: string; repeat: number }) => ({ command: process.execPath, args: [join(root, "unit.mjs"), "unit", s, unit.caseDir, unit.arm, String(unit.repeat)] });
    const result = await runDriver({ study: s, caseDirs: [caseDir], concurrency: 2, preflight: true, command, arms: ["A"] });
    expect(result).toMatchObject({ completed: 2, failed: 0 });
    expect(JSON.parse(readFileSync(join(s, "driver/state.json"), "utf8")).units.map((unit: any) => unit.id).sort()).toEqual(["c1/A/r1", "c1/A/r2"]);
    expect(readdirSync(join(s, "runs/c1"))).toEqual(["A"]);
    expect(() => packets(s, join(root, "cases"))).toThrow();
    packets(s, join(root, "cases"), ["A"]);
    const key = JSON.parse(readFileSync(join(s, "scoring/key.json"), "utf8"));
    expect(Object.values(key).map((item: any) => item.unit).sort()).toEqual(["c1/A/r1", "c1/A/r2"]);
    expect(JSON.parse(readFileSync(join(s, "scoring/packets.json"), "utf8")).index.c1).toHaveLength(2);
    const full = join(root, "study2");
    json(join(full, "environment.json"), {});
    const all = await runDriver({ study: full, caseDirs: [caseDir], concurrency: 3, preflight: true, command: (unit: { caseDir: string; arm: string; repeat: number }) => ({ command: process.execPath, args: [join(root, "unit.mjs"), "unit", full, unit.caseDir, unit.arm, String(unit.repeat)] }) });
    expect(all.completed).toBe(6);
  }, 30_000);
});

describe("sandbox paths of the verifier", () => {
  it("probe runs see the copy at ~/Code/<project>, the venv and the probes; no network namespace is shared", async () => {
    const { probeSandboxArgs } = await import("../../experiments/cb-ab/verify.js");
    const args = probeSandboxArgs("/c", "/v", "proj", "/p");
    expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--die-with-parent"]));
    expect(args.join(" ")).toContain(`--bind /c ${join(HOME, "Code/proj")}`);
    expect(args.join(" ")).toContain(`--ro-bind /v ${join(HOME, ".venvs/proj")}`);
    expect(args.join(" ")).toContain(`--ro-bind /p ${join(HOME, "probes")}`);
  });
});
