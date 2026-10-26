import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryGovernor, isNetworkFailure, parseStatuses } from "../../experiments/swe-pool/env.js";
import { compareManifests, deriveLists, fixtureIdOf, manifestOf, renderReadme, selectBuild, transformInstall, verdict, type ListRecord, type VariantResult } from "../../experiments/swe-pool/build.js";
import {
  POOL_SEED, REPO, STAGE3_SEED, isNonTestPython, nonTestPython, parseDiff, prescreen, readRecords, screenRecord, seededOrder, setUpAs, unquotePath,
  type PrescreenEntry, type RawRecord,
} from "../../experiments/swe-pool/prescreen.js";

/**
 * The round-2 SWE pool P2 (results/cb-ab/PROTOCOL-R2.md "Pool P2", experiments/swe-pool): its mechanical, model-free rules, pinned
 * without building anything.
 */
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("non-test Python source classifier", () => {
  const table: [string, boolean][] = [
    ["src/pkg/mod.py", true],
    ["pkg/mod.py", true],
    ["setup.py", true],
    ["pkg/test.py", true], // basename "test.py" is neither test_*.py nor *_test.py, and a basename is not a test directory
    ["pkg/tests.py", true],
    ["pkg/testutils.py", true],
    ["pkg/contest.py", true],
    ["pkg/docs.py", true],
    ["pkg/mytests/helpers.py", true],
    ["documentation/gen.py", true],
    ["Tests/helpers.py", true], // segments compare exactly, as the protocol names them
    ["tests/helpers.py", false],
    ["test/helpers.py", false],
    ["pkg/tests/unit/helpers.py", false],
    ["pkg/testing/fixtures.py", false],
    ["docs/conf.py", false],
    ["doc/source/conf.py", false],
    ["examples/demo.py", false],
    ["pkg/test_utils.py", false],
    ["test_top.py", false],
    ["pkg/utils_test.py", false],
    ["pkg/_test.py", false],
    ["conftest.py", false],
    ["pkg/conftest.py", false],
    ["pkg/mod.pyi", false],
    ["pkg/mod.pyx", false],
    ["pkg/mod.py.orig", false],
    ["README.md", false],
  ];
  it.each(table)("%s -> %s", (path, expected) => { expect(isNonTestPython(path)).toBe(expected); });
});

const SAMPLE = [
  "diff --git a/pkg/core.py b/pkg/core.py",
  "index 1111111..2222222 100644",
  "--- a/pkg/core.py",
  "+++ b/pkg/core.py",
  "@@ -1,4 +1,4 @@",
  " import os",
  "--- a SQL comment the old code carried",
  "+++ looks like a file header but is an added line",
  " def f():",
  "     return 1",
  "@@ -20 +20,2 @@ def g():",
  "-    return 2",
  "+    x = 2",
  "+    return x",
  "\\ No newline at end of file",
  "diff --git a/pkg/new_mod.py b/pkg/new_mod.py",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/pkg/new_mod.py",
  "@@ -0,0 +1,2 @@",
  "+def h():",
  "+    return 3",
  "diff --git a/pkg/old_mod.py b/pkg/old_mod.py",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/pkg/old_mod.py",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-def gone():",
  "-    pass",
  "diff --git a/pkg/a.py b/pkg/b.py",
  "similarity index 90%",
  "rename from pkg/a.py",
  "rename to pkg/b.py",
  "index 5555555..6666666 100644",
  "--- a/pkg/a.py",
  "+++ b/pkg/b.py",
  "@@ -3,3 +3,3 @@ class A:",
  "     def m(self):",
  "-        return 'a'",
  "+        return 'b'",
  " ",
  "diff --git a/pkg/moved.py b/pkg/util/moved.py",
  "similarity index 100%",
  "rename from pkg/moved.py",
  "rename to pkg/util/moved.py",
  "diff --git a/tests/test_core.py b/tests/test_core.py",
  "index 7777777..8888888 100644",
  "--- a/tests/test_core.py",
  "+++ b/tests/test_core.py",
  "@@ -1,2 +1,3 @@",
  " import pkg",
  "+import pytest",
  " ",
  "@@ -10,1 +11,1 @@",
  "-assert 1",
  "+assert 2",
  "diff --git a/docs/conf.py b/docs/conf.py",
  "index 9999999..aaaaaaa 100644",
  "--- a/docs/conf.py",
  "+++ b/docs/conf.py",
  "@@ -1 +1 @@",
  "-version = '1'",
  "+version = '2'",
  "diff --git a/logo.png b/logo.png",
  "index bbbbbbb..ccccccc 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git \"a/pkg/sp\\303\\244m.py\" \"b/pkg/sp\\303\\244m.py\"",
  "index ddddddd..eeeeeee 100644",
  "--- \"a/pkg/sp\\303\\244m.py\"",
  "+++ \"b/pkg/sp\\303\\244m.py\"",
  "@@ -1 +1 @@",
  "-a = 1",
  "+a = 2",
  "",
].join("\n");

describe("unified diff: files and hunks", () => {
  it("parses every file entry with its status and hunk count", () => {
    expect(parseDiff(SAMPLE)).toEqual([
      { oldPath: "pkg/core.py", newPath: "pkg/core.py", status: "modified", hunks: 2 },
      { oldPath: null, newPath: "pkg/new_mod.py", status: "added", hunks: 1 },
      { oldPath: "pkg/old_mod.py", newPath: null, status: "deleted", hunks: 1 },
      { oldPath: "pkg/a.py", newPath: "pkg/b.py", status: "renamed", hunks: 1 },
      { oldPath: "pkg/moved.py", newPath: "pkg/util/moved.py", status: "renamed", hunks: 0 },
      { oldPath: "tests/test_core.py", newPath: "tests/test_core.py", status: "modified", hunks: 2 },
      { oldPath: "docs/conf.py", newPath: "docs/conf.py", status: "modified", hunks: 1 },
      { oldPath: "logo.png", newPath: "logo.png", status: "modified", hunks: 0 },
      { oldPath: "pkg/späm.py", newPath: "pkg/späm.py", status: "modified", hunks: 1 },
    ]);
  });

  it("counts hunks and files in non-test Python source only (new, deleted and renamed files included)", () => {
    expect(nonTestPython(SAMPLE)).toEqual({
      files: ["pkg/core.py", "pkg/new_mod.py", "pkg/old_mod.py", "pkg/b.py", "pkg/util/moved.py", "pkg/späm.py"],
      hunks: 2 + 1 + 1 + 1 + 0 + 1,
    });
  });

  it("classifies a deleted file by its old path and a renamed file by its new path", () => {
    expect(nonTestPython(["diff --git a/tests/x.py b/tests/x.py", "deleted file mode 100644", "--- a/tests/x.py", "+++ /dev/null", "@@ -1 +0,0 @@", "-x = 1", ""].join("\n"))).toEqual({ files: [], hunks: 0 });
    expect(nonTestPython(["diff --git a/tests/x.py b/pkg/x.py", "similarity index 80%", "rename from tests/x.py", "rename to pkg/x.py", "--- a/tests/x.py", "+++ b/pkg/x.py", "@@ -1 +1 @@", "-x = 1", "+x = 2", ""].join("\n"))).toEqual({ files: ["pkg/x.py"], hunks: 1 });
  });

  it("reads plain (non-git) unified diffs and quoted paths", () => {
    const plain = ["--- pkg/a.py\t2026-01-01 00:00:00", "+++ pkg/a.py\t2026-01-02 00:00:00", "@@ -1,2 +1,2 @@", "-a", "+b", " c", "--- pkg/c.py", "+++ pkg/c.py", "@@ -5 +5 @@", "-x", "+y", ""].join("\n");
    expect(parseDiff(plain).map(file => [file.newPath, file.hunks])).toEqual([["pkg/a.py", 1], ["pkg/c.py", 1]]);
    expect(unquotePath('"a/x\\tb.py"')).toBe("a/x\tb.py");
    expect(unquotePath("a/plain.py")).toBe("a/plain.py");
  });

  it("screens D1 and D2 with reasons", () => {
    const patch = SAMPLE;
    expect(screenRecord({ FAIL_TO_PASS: ["t::a"], problem_statement: "Bug", patch, interface: "  " })).toMatchObject({ d1: true, d2: true, multiFile: true, interface: false, nonTestPyHunks: 6 });
    expect(screenRecord({ FAIL_TO_PASS: [], problem_statement: "Bug", patch, interface: "API: f(x)" })).toMatchObject({ d1: false, d2: true, interface: true, reason: "D1: FAIL_TO_PASS is empty" });
    const one = ["diff --git a/pkg/a.py b/pkg/a.py", "--- a/pkg/a.py", "+++ b/pkg/a.py", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    expect(screenRecord({ FAIL_TO_PASS: ["t::a"], problem_statement: " \n", patch: one, interface: "" })).toMatchObject({ d1: false, d2: false, multiFile: false, reason: "D1: the problem statement is empty; D2: 1 hunk(s) in 1 non-test Python file(s) (< 2 hunks)" });
  });
});

const raw = (id: string, extra: Partial<Record<string, unknown>> = {}): RawRecord => ({
  id, recordFile: "results/iso-token/raw/rebench-2026_01.jsonl", recordSha256: sha(id),
  record: { instance_id: id, FAIL_TO_PASS: ["t::x"], problem_statement: "Issue", interface: "", patch: ["diff --git a/p/m.py b/p/m.py", "--- a/p/m.py", "+++ b/p/m.py", "@@ -1 +1 @@", "-a", "+b", "@@ -9 +9 @@", "-c", "+d", ""].join("\n"), ...extra },
});

describe("pool order and exclusion", () => {
  const ids = Array.from({ length: 30 }, (_, index) => `owner__repo-${index}`);
  it("sorts the ids, then orders them by sha256(seed + id) ascending, independent of the input order", () => {
    const expected = [...ids].sort().sort((a, b) => (sha(POOL_SEED + a) < sha(POOL_SEED + b) ? -1 : 1));
    expect(seededOrder(ids, POOL_SEED)).toEqual(expected);
    expect(seededOrder([...ids].reverse(), POOL_SEED)).toEqual(expected);
    expect(seededOrder(ids, STAGE3_SEED)).not.toEqual(expected);
    const hashes = expected.map(id => sha(POOL_SEED + id));
    expect([...hashes].sort()).toEqual(hashes);
  });

  it("counts a fixture named id or id + _interface as set up", () => {
    const dirs = new Set(["a__b-1", "c__d-2_interface", "e__f-3_interface"]);
    expect(setUpAs("a__b-1", dirs)).toBe("a__b-1");
    expect(setUpAs("c__d-2", dirs)).toBe("c__d-2_interface");
    expect(setUpAs("e__f-3_interface", dirs)).toBe("e__f-3_interface");
    expect(setUpAs("a__b-10", dirs)).toBeUndefined();
    expect(setUpAs("g__h-4", dirs)).toBeUndefined();
  });

  it("excludes the set-up records and orders the rest with 1-based orders", () => {
    const records = ["a__b-1", "c__d-2", "e__f-3_interface", "g__h-4", "i__j-5"].map(id => raw(id));
    const { excluded, entries } = prescreen(records, new Set(["a__b-1", "c__d-2_interface", "e__f-3_interface", "unrelated"]));
    expect(excluded).toEqual([{ id: "a__b-1", fixture: "a__b-1" }, { id: "c__d-2", fixture: "c__d-2_interface" }, { id: "e__f-3_interface", fixture: "e__f-3_interface" }]);
    expect(entries.map(entry => entry.id)).toEqual(seededOrder(["g__h-4", "i__j-5"], POOL_SEED));
    expect(entries.map(entry => entry.order)).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({ d1: true, d2: true, multiFile: false, interface: false, nonTestPyFiles: ["p/m.py"], nonTestPyHunks: 2, recordSha256: sha(entries[0]!.id) });
    expect(() => prescreen([raw("x"), raw("x")], new Set())).toThrow(/duplicate/);
  });

  it("selects the first 48 D1∧D2 records in pool order", () => {
    const entries = Array.from({ length: 70 }, (_, index) => ({ id: `r${index}`, order: 70 - index, d1: index !== 3, d2: index % 5 !== 0 })) as PrescreenEntry[];
    const passing = entries.filter(entry => entry.d1 && entry.d2).sort((a, b) => a.order - b.order);
    const selected = selectBuild(entries);
    expect(passing.length).toBeGreaterThan(48);
    expect(selected).toEqual(passing.slice(0, 48));
    expect(selected.every(entry => entry.d1 && entry.d2)).toBe(true);
    expect(selected[0]!.order).toBe(1);
    expect(selectBuild(entries.slice(0, 10))).toHaveLength(entries.slice(0, 10).filter(entry => entry.d1 && entry.d2).length);
  });

  it.skipIf(!existsSync(join(REPO, "results/iso-token/raw/rebench-2026_03.jsonl")))("hashes each record line as setup-swe.ts does (an old fixture's recordSha256)", () => {
    const old = JSON.parse(readFileSync(join(REPO, "fixtures/advisor-bench/swe/delgan__loguru-1451/task.json"), "utf8"));
    const record = readRecords(REPO).find(item => item.id === "delgan__loguru-1451")!;
    expect({ file: record.recordFile, sha256: record.recordSha256 }).toEqual({ file: old.source.file, sha256: old.source.recordSha256 });
  });
});

const listRecord = (index: number, extra: Partial<ListRecord> = {}): ListRecord => ({ id: `t__t-${index}`, fixtureId: fixtureIdOf(`t__t-${index}`), order: index + 1, d4Valid: true, interface: false, multiFile: false, ...extra });

describe("derived lists", () => {
  it("T1 = the first 20 valid records without interface text in pool order, T2 = the next 20", () => {
    const records = Array.from({ length: 48 }, (_, index) => listRecord(index, { interface: index % 4 === 1, d4Valid: index % 7 !== 2 }));
    const eligible = records.filter(record => record.d4Valid && !record.interface).map(record => record.fixtureId);
    const lists = deriveLists([...records].reverse());
    expect(lists.stage1.T1).toEqual(eligible.slice(0, 20));
    expect(lists.stage1.T2).toEqual(eligible.slice(20, 40));
    expect(lists.stage1.eligible).toBe(eligible.length);
  });

  it("keeps fewer than 20 when fewer are valid (T2 then possibly empty or short)", () => {
    const few = Array.from({ length: 48 }, (_, index) => listRecord(index, { d4Valid: index < 15 }));
    expect(deriveLists(few).stage1.T1).toHaveLength(15);
    expect(deriveLists(few).stage1.T2).toEqual([]);
    const some = Array.from({ length: 48 }, (_, index) => listRecord(index, { d4Valid: index < 26 }));
    expect(deriveLists(some).stage1.T1).toHaveLength(20);
    expect(deriveLists(some).stage1.T2).toEqual(some.slice(20, 26).map(record => record.fixtureId));
    expect(deriveLists([]).stage1).toMatchObject({ T1: [], T2: [], eligible: 0 });
  });

  it("stage3.pool = the first 10 valid multiFile records (interface allowed) by sha256(ultra-ho seed + id)", () => {
    const records = Array.from({ length: 48 }, (_, index) => listRecord(index, { multiFile: index % 2 === 0, interface: index % 3 === 0, d4Valid: index % 5 !== 4 }));
    const eligible = records.filter(record => record.d4Valid && record.multiFile).map(record => record.id);
    const expected = [...eligible].sort((a, b) => (sha(STAGE3_SEED + a) < sha(STAGE3_SEED + b) ? -1 : 1)).slice(0, 10);
    const lists = deriveLists(records);
    expect(lists.stage3.pool).toEqual(expected);
    expect(lists.stage3.pool.some(id => records.find(record => record.id === id)!.interface)).toBe(true);
    expect(lists.stage3.ranking.map(item => item.fixtureId).slice(0, 10)).toEqual(expected);
    const three = records.map(record => ({ ...record, d4Valid: record.d4Valid && record.order <= 6 }));
    expect(deriveLists(three).stage3.pool).toHaveLength(three.filter(record => record.d4Valid && record.multiFile).length);
  });
});

describe("setup-swe.ts equivalence (pure parts)", () => {
  it("transforms the install command as setup-swe.ts does", () => {
    expect(transformInstall("pip install -q -e . && pip install -q -e .[dev,docs,testing]")).toBe("pip install -q . && pip install -q .[dev,docs,testing]");
    expect(transformInstall('pip install -e ".[test]" --quiet && pip install pypower --quiet')).toBe('pip install ".[test]" --quiet && pip install pypower --quiet');
    expect(transformInstall("pip install -q --root-user-action=ignore \".[tests]\"")).toBe("pip install -q  \".[tests]\"");
    expect(transformInstall("pip install uv --quiet && cd /testbed && uv pip install -e \".[all]\" --system --quiet")).toBe("pip install uv --quiet && cd /testbed && uv pip install \".[all]\" --system --quiet");
  });

  it.skipIf(!existsSync(join(REPO, "results/iso-token/raw/rebench-2026_03.jsonl")))("builds task.json's dataset fields exactly as the old fixture has them", () => {
    const old = JSON.parse(readFileSync(join(REPO, "fixtures/advisor-bench/swe/delgan__loguru-1451/task.json"), "utf8"));
    const manifest = manifestOf(readRecords(REPO).find(item => item.id === "delgan__loguru-1451")!);
    const keys = Object.keys(manifest);
    expect(keys).toEqual(Object.keys(old).slice(0, keys.length));
    for (const key of keys) expect(manifest[key]).toEqual(old[key]);
    expect(transformInstall(old.datasetInstall)).toBe(old.install);
  });

  it("decides validity as setup-swe.ts does (MISSING fails on base; P2P failing with the fix is excluded)", () => {
    const manifest = { failToPass: ["t::a", "t::b"], passToPass: ["t::c", "t::d"] };
    const result = (status: Record<string, string>): VariantResult => ({ ms: 1, status, counts: {}, exit: 1 });
    const ok = verdict(manifest, result({ "t::a": "FAILED", "t::b": "MISSING", "t::c": "PASSED", "t::d": "PASSED" }), result({ "t::a": "PASSED", "t::b": "PASSED", "t::c": "PASSED", "t::d": "ERROR" }));
    expect(ok).toMatchObject({ f2pFailBase: true, f2pPassRef: true, excludedPassToPass: ["t::d"] });
    const bad = verdict(manifest, result({ "t::a": "PASSED", "t::b": "FAILED" }), result({ "t::a": "PASSED", "t::b": "MISSING" }));
    expect(bad).toMatchObject({ f2pFailBase: false, f2pPassRef: false, f2pPassingOnBase: ["t::a"], f2pNotPassingWithReference: [{ test: "t::b", status: "MISSING" }] });
  });

  it("parses pytest -rA statuses as tasks.ts runSweTests does", () => {
    const statuses = parseStatuses(["PASSED tests/a.py::test_x", "FAILED tests/a.py::test_y - AssertionError: no", "ERROR tests/b.py::test_z[1-2] - x", "PASSED not-a-node-id", "= 2 failed ="].join("\n"));
    expect([...statuses]).toEqual([["tests/a.py::test_x", "PASSED"], ["tests/a.py::test_y", "FAILED"], ["tests/b.py::test_z[1-2]", "ERROR"]]);
  });

  it("compares task.json documents without run-specific fields", () => {
    const a = { id: "x", validation: { at: "1", valid: true, base: { ms: 1, counts: { FAILED: 1 } } } };
    const b = { id: "x", validation: { at: "2", valid: true, base: { ms: 9, counts: { FAILED: 1 } } } };
    expect(compareManifests(a, b)).toEqual([]);
    expect(compareManifests({ ...a, install: "pip install ." }, b)).toEqual([{ field: "install", mine: "pip install .", old: undefined }]);
  });

  it("renders the README with counts, lists, failures and method", () => {
    const records = [
      { ...listRecord(0, { multiFile: true }), built: true, d4Valid: true, reason: null, setupAttempts: 1, networkRetry: false, sha256: { taskJson: "a", testPatch: "b", fixPatch: "c" }, validation: { valid: true, f2pFailOnBase: true, f2pPassWithReference: true, failToPass: 1, passToPass: 2, excludedPassToPass: 0, base: { counts: { FAILED: 1, PASSED: 2 }, ms: 1, exit: 1 }, reference: { counts: { PASSED: 3 }, ms: 1, exit: 0 }, at: "t" } },
      { ...listRecord(1, { d4Valid: false }), built: false, reason: "setup failed at install: exit 1: ERROR | no wheel\nfor x", setupAttempts: 2, networkRetry: true, sha256: { taskJson: null, testPatch: "b", fixPatch: "c" }, validation: null },
    ];
    const pool = { builtAt: "now", commands: ["npx tsx experiments/swe-pool/build.ts --list"], method: ["m1"], wallTime: { note: "1 min" }, records, ...deriveLists(records) };
    const text = renderReadme(pool, { records: 215, excluded: 43, pool: 172, expectedPool: 172, d1: 172, d2: 135, d1d2: 135, d1d2MultiFile: 54, d1d2Interface: 32 }, { records: [{ id: "old", identical: true, differences: [], patchesIdentical: true }] });
    expect(text).toContain("| D1 ∧ D2 | 135 (multiFile 54, interface 32) |");
    expect(text).toContain("**stage1.T1** (1;");
    expect(text).toContain("`t__t-0`");
    expect(text).toContain("- #2 `t__t-1` (not built): setup failed at install: exit 1: ERROR \\| no wheel for x");
    expect(text).toContain("`old`: task.json identical");
  });
});

describe("build schedule safety", () => {
  it("retries only network failures", () => {
    expect(isNetworkFailure("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com")).toBe(true);
    expect(isNetworkFailure("WARNING: Retrying (Retry(total=4)) after connection broken by 'NewConnectionError(...)'")).toBe(true);
    expect(isNetworkFailure("curl: (28) Operation timed out after 120001 milliseconds")).toBe(true);
    expect(isNetworkFailure("fatal: remote error: upload-pack: not our ref 0123")).toBe(false);
    expect(isNetworkFailure("ERROR: Could not find a version that satisfies the requirement foo==9 (from versions: none)")).toBe(false);
    expect(isNetworkFailure("error: subprocess-exited-with-error\n× Building wheel for x (pyproject.toml) did not run successfully.")).toBe(false);
  });

  it.skipIf(!existsSync("/proc/self/stat"))("pauses the newest governed process group under memory pressure and resumes it after", async () => {
    const state = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]![0];
    const children = [0, 1].map(() => spawn("sleep", ["30"], { detached: true, stdio: "ignore" }));
    try {
      let available = 1 * 2 ** 30;
      const events: string[] = [];
      const governor = new MemoryGovernor(2 * 2 ** 30, 4 * 2 ** 30, text => events.push(text), () => available);
      for (const [index, child] of children.entries()) governor.add(child.pid!, `c${index}`);
      governor.tick();
      await new Promise(done => setTimeout(done, 100));
      expect([state(children[0]!.pid!), state(children[1]!.pid!)]).toEqual(["S", "T"]);
      expect(governor.paused()).toEqual(["c1"]);
      governor.tick(); // only one runs: never pause the last one
      expect(governor.paused()).toEqual(["c1"]);
      available = 8 * 2 ** 30;
      governor.tick();
      await new Promise(done => setTimeout(done, 100));
      expect(state(children[1]!.pid!)).toBe("S");
      expect(governor.paused()).toEqual([]);
      expect(governor.pausedMs(children[1]!.pid!)).toBeGreaterThan(0);
      expect(events).toHaveLength(2);
    } finally { for (const child of children) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } } }
  });
});
