import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWritable, callVerdict, canonicalScope, diffFiles, exclusionOf, FINDING_CLASSES, findingHandoff, fileKind, FROZEN_OUTPUTS, isAccepted, pathMentions, refusedInText, relativePath, reportLocations,
  runtimeHandoff, scopeCovers, snapshotOf, testCheck, unitChain, unitTask, writeChains, type CandidatesCall, type TaskSource,
} from "../../experiments/ultra-ho/chain.js";
import { REPO } from "../../experiments/ultra-ho/env.js";

/**
 * experiments/ultra-ho/chain.ts without any model: the extraction rule of analyst-reported locations (the runtime's, on the initial
 * snapshot), H2's hand-off classes per finding (assigned = owned and named by the same implement candidate, reference, excluded, out of
 * scope, mention-only, owned-only, dropped) with the first proposal, the refusals and the gate attribution's timing, a synthetic unit of
 * each arm end to end with the study totals, the unit's own fixture root, the frozen round-1 outputs, and the historical hand-off loss
 * (tox-dev__tox-3904 B r1, the older ultra-ab layout).
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "ultra-ho-chain-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
const jsonl = (items: unknown[]) => `${items.map(item => JSON.stringify(item)).join("\n")}\n`;
const put = async (root: string, files: Record<string, string>) => { for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); } };
const WS = "/ws/run-1/ws-abc";

describe("the extraction rule: analyst-reported locations (the runtime's rule on the task's initial snapshot)", () => {
  async function snapshot(): Promise<string> {
    const root = await temp();
    await put(root, {
      "src/a.py": "a", "src/pkg/b.py": "b", "README.md": "r", Makefile: "m", "tests/test_a.py": "t", "tests/basis/x.py": "x",
      "node_modules/x/index.js": "n", ".venv/lib/x.py": "v", "venv/y.py": "v", ".git/config": "g", ".orche/notes.txt": "o", "docs/guide/intro.rst": "d",
    });
    await symlink(join(root, "src/a.py"), join(root, "link.py"));
    const outside = await temp();
    await put(outside, { "f.py": "outside" });
    await symlink(outside, join(root, "ext"));
    return root;
  }

  it("normalizes paths as written: ./ and .. resolved, trailing dots dropped, absolute under the workspace made relative, others outside", () => {
    expect(relativePath("./src/a.py", [WS])).toBe("src/a.py");
    expect(relativePath("././src/a.py.", [WS])).toBe("src/a.py");
    expect(relativePath("src/sub/../a.py", [WS])).toBe("src/a.py");
    expect(relativePath(`${WS}/src/a.py`, [WS])).toBe("src/a.py");
    expect(relativePath(`${WS}/`, [WS])).toBeUndefined();
    expect(relativePath("/elsewhere/src/a.py", [WS])).toBeUndefined();
    expect(relativePath("../outside/src/a.py", [WS])).toBeUndefined();
    expect(relativePath("src/../../a.py", [WS])).toBeUndefined();
    // Bare tokens are mentions too (only an existing top-level file makes them a location); a line reference follows the path at once.
    const mentions = pathMentions("see `src/a.py:12-14`, src/pkg/b.py:3–9,20 and README.md.", [WS]);
    expect(mentions.filter(item => /[./]/.test(item.path)).map(item => [item.path, item.lines ?? ""])).toEqual([["src/a.py", "12-14"], ["src/pkg/b.py", "3-9,20"], ["README.md", ""]]);
    expect(mentions.map(item => item.path)).toEqual(["see", "src/a.py", "12-14", "src/pkg/b.py", "3", "9", "20", "and", "README.md"]);
  });

  it("keeps regular snapshot files named in the summary or the data (relative, ./, absolute, :line, :a-b), and ignores the rest", async () => {
    const root = await snapshot();
    const summary = [
      "Cause: `src/a.py:12` and ./src/pkg/b.py:3-9; the docs at /ws/run-1/ws-abc/README.md and the Makefile.",
      "Not locations: src/missing.py, /elsewhere/src/a.py, ../outside/src/a.py, docs/guide, link.py, ext/f.py, the basis tests/test_a.py:4 and tests/basis/x.py,",
      "node_modules/x/index.js, .venv/lib/x.py, venv/y.py, .git/config, .orche/notes.txt, ~/src/a.py.",
    ].join("\n");
    const data = { evidence: [{ location: "src/pkg/b.py:10–12,20" }, "first line\nsrc/a.py:40"], "src/sub/../a.py": "a key names it too" };
    const found = reportLocations({ summary, data }, { snapshot: snapshotOf(root), workspaces: [WS], basis: ["tests/test_a.py", "tests/basis"] });
    expect(Object.fromEntries(found.map(item => [item.path, item.lines]))).toEqual({ "src/a.py": ["12", "40"], "src/pkg/b.py": ["3-9", "10-12", "20"], "README.md": [], Makefile: [] });
    expect(found[0]!.excerpt).toContain("Cause: `src/a.py:12`");
    // Without the basis the protected files are ordinary locations (they exist in the snapshot).
    expect(reportLocations({ summary }, { snapshot: snapshotOf(root), workspaces: [WS] }).map(item => item.path)).toEqual(expect.arrayContaining(["tests/test_a.py", "tests/basis/x.py"]));
  });

  it("scans at most the runtime's bound of a report and none of a missing summary or data", async () => {
    const root = await snapshot();
    expect(reportLocations({ summary: `${"x ".repeat(100_000)} src/a.py` }, { snapshot: snapshotOf(root), workspaces: [] })).toEqual([]);
    expect(reportLocations({}, { snapshot: snapshotOf(root), workspaces: [] })).toEqual([]);
  });
});

describe("H2's hand-off classes of a finding", () => {
  const call = (ref: string, workers: CandidatesCall["workers"], extra: Partial<CandidatesCall> = {}): CandidatesCall => ({ ref, orchestrator: "W1", at: "2026-10-24T01:10:00.000Z", status: "accepted", workers, reference: [], excluded: [], ...extra });
  const options = { workspaces: [WS] };
  const implement = (id: string, request: string, files: string[]) => ({ id, name: id.toLowerCase().replace(".", "-"), role: "implement", request, files });

  it("canonicalizes files scopes like the runtime's ownership: dir/** → dir/, ./ the workspace; absolute, glob and outside paths own nothing", () => {
    expect(["src/pkg/", "src/pkg/**", "src/pkg/**/*", "./src/pkg/", "src/a.py", "./", "/abs/x.py", "src/*.py", "../x.py"].map(file => canonicalScope(file) ?? null)).toEqual(["src/pkg/", "src/pkg/", "src/pkg/", "src/pkg/", "src/a.py", "/", null, null, null]);
    expect([scopeCovers("src/pkg/", "src/pkg/b.py"), scopeCovers("src/pkg/", "src/pkg/b.py".replace("pkg", "pkgx")), scopeCovers("src/pkg", "src/pkg/b.py"), scopeCovers("/", "any/file.py")]).toEqual([true, false, false, true]);
    expect(FINDING_CLASSES).toEqual(["assigned", "reference", "excluded", "out-of-scope", "mention-only", "owned-only", "dropped"]);
  });

  it("assigned only when the same implement candidate owns the path (file, dir/, ./) and names it (relative or absolute); a mention, ownership, or both split across candidates is not", () => {
    const dump = call("c", [implement("W1.3", `Fix src/a.py; see src/pkg/b.py, ${WS}/src/c.py:7 and lib/z.py.`, ["src/a.py"]), implement("W1.4", "Own the package.", ["src/pkg/"]), implement("W1.5", "Rewrite the helper.", ["./"])]);
    expect(callVerdict("src/a.py", dump, options)).toEqual({ class: "assigned", assignedBy: [{ candidate: "W1.3", name: "w1-3", files: ["src/a.py"] }], namedBy: ["W1.3"], ownedBy: ["W1.3", "W1.5"] });
    // Named by W1.3 (which does not own it) and owned by W1.4: split, so a mention without the owner's request.
    expect(callVerdict("src/pkg/b.py", dump, options)).toMatchObject({ class: "mention-only", assignedBy: [], namedBy: ["W1.3"], ownedBy: ["W1.4", "W1.5"] });
    expect(callVerdict("lib/z.py", call("c", [implement("W1.3", "Fix src/a.py; see lib/z.py.", ["src/a.py"])]), options)).toMatchObject({ class: "mention-only", ownedBy: [] });
    expect(callVerdict("src/pkg/d.py", dump, options)).toMatchObject({ class: "owned-only", namedBy: [], ownedBy: ["W1.4", "W1.5"] });
    expect(callVerdict("docs/x.rst", call("c", [implement("W1.3", "Fix it.", ["src/a.py"])]), options).class).toBe("dropped");
    // Through a directory scope with the absolute path in the request; a scope without the trailing slash owns only that path.
    expect(callVerdict("src/c.py", call("c", [implement("W1.6", `Fix ${WS}/src/c.py:7.`, ["src/"])]), options)).toMatchObject({ class: "assigned", assignedBy: [{ candidate: "W1.6", files: ["src/"] }] });
    expect(callVerdict("src/pkg/b.py", call("c", [implement("W1.6", "Fix src/pkg/b.py.", ["src/pkg"])]), options).class).toBe("mention-only");
    // A read-only run: an answer candidate's request suffices; its files mean nothing.
    expect(callVerdict("src/pkg/b.py", call("c", [{ name: "x", role: "answer", request: "Explain src/pkg/b.py.", files: [] }, { name: "y", role: "answer", request: "Other.", files: ["src/pkg/b.py"] }]), options)).toMatchObject({ class: "assigned", assignedBy: [{ candidate: "x" }], ownedBy: [] });
    // Out of scope comes first (the runtime records it before anything else).
    expect(callVerdict("src/a.py", dump, { ...options, outOfScope: true }).class).toBe("out-of-scope");
  });

  it("reference needs its entry and the path named in a request; excluded needs its entry; both keep the reason and whether evidence is cited", () => {
    const named = call("c", [implement("W1.3", "Fix src/a.py; read src/c.py for context.", ["src/a.py"])], {
      reference: [exclusionOf({ path: "./src/c.py:7", reason: "context only", evidence: ["[orche ref T4] grep names src/c.py"] })],
      excluded: [exclusionOf({ path: "src/d.py", reason: "  " }), exclusionOf({ path: "src/e.py", reason: "unaffected", evidence: ["T5"] })],
    });
    expect(callVerdict("src/c.py", named, options)).toMatchObject({ class: "reference", entry: { path: "./src/c.py:7", reason: "context only", grounded: true } });
    expect(callVerdict("src/d.py", named, options)).toMatchObject({ class: "excluded", entry: { grounded: false } });
    expect(callVerdict("src/e.py", named, options)).toMatchObject({ class: "excluded", entry: { reason: "unaffected", grounded: true } });
    // A reference no request names is no reference (H2 refuses it); assigned beats an entry.
    expect(callVerdict("src/c.py", { ...named, workers: [implement("W1.3", "Fix src/a.py.", ["src/a.py"])] }, options).class).toBe("dropped");
    expect(callVerdict("src/a.py", { ...named, excluded: [exclusionOf({ path: "src/a.py", reason: "r", evidence: ["T1"] })] }, options).class).toBe("assigned");
  });

  it("over the proposals after the report: the best accepted class, the first proposal, the refusals naming it, and gate attribution only for refusal → assignment with no earlier assignment", () => {
    // As unitChain asks: did this call's hand-off refusal name the finding (src/b.py)?
    const named = (item: CandidatesCall) => item.refused?.some(entry => entry.path === "src/b.py") ? {} : undefined;
    const refused = (ref: string, workers: CandidatesCall["workers"], paths: string[]) => call(ref, workers, { status: "refused", message: "Refused (ultra hand-off): 1 analyst finding(s) have no accepted disposition", refused: paths.map(path => ({ path, exploration: 1 })) });
    const owner = implement("W1.3", "Fix src/a.py and src/b.py.", ["src/a.py", "src/b.py"]);
    const mention = implement("W1.3", "Fix src/a.py; see src/b.py.", ["src/a.py"]);

    // 1. Refused for b (a path dump: named, not owned), then accepted with b assigned: gate-transferred.
    const gate = findingHandoff("src/b.py", [refused("#1", [mention], ["src/b.py"]), call("#2", [owner])], { ...options, named });
    expect(gate).toMatchObject({ class: "assigned", firstProposal: { call: "#1", status: "refused", class: "mention-only" }, firstAccepted: { call: "#2", class: "assigned" }, refusals: [{ call: "#1", next: "#2", nextAssigned: true }], gateTransferred: true, assigned: [{ call: "#2", candidate: "W1.3", files: ["src/a.py", "src/b.py"] }] });
    expect(gate.calls.map(item => [item.call, item.status, item.class])).toEqual([["#1", "refused", "mention-only"], ["#2", "accepted", "assigned"]]);
    // 2. The first proposal already assigned it (refused for another finding): the later assignment is not the gate's.
    const earlier = findingHandoff("src/b.py", [refused("#1", [owner], ["src/c.py"]), call("#2", [owner])], { ...options, named });
    expect(earlier).toMatchObject({ class: "assigned", firstProposal: { class: "assigned" }, refusals: [], gateTransferred: false });
    // 3. A refusal named it, an even earlier refused proposal had assigned it: not gate-caused either.
    const third = findingHandoff("src/b.py", [refused("#1", [owner], ["src/c.py"]), refused("#2", [mention], ["src/b.py"]), call("#3", [owner])], { ...options, named });
    expect(third).toMatchObject({ refusals: [{ call: "#2", next: "#3", nextAssigned: true }], gateTransferred: false });
    // 4. A refusal named it, the next accepted call excluded it: no transfer, not assigned.
    const excluded = findingHandoff("src/b.py", [refused("#1", [mention], ["src/b.py"]), call("#2", [mention], { excluded: [exclusionOf({ path: "src/b.py", reason: "out", evidence: ["T3"] })] })], { ...options, named });
    expect(excluded).toMatchObject({ class: "excluded", refusals: [{ next: "#2", nextAssigned: false }], gateTransferred: false, assigned: [] });
    // 5. Refused calls never count for the class; a call without a result counts only when the runtime prepared its candidates; no call at all: dropped.
    expect(findingHandoff("src/b.py", [refused("#1", [owner], [])], options)).toMatchObject({ class: "dropped", firstProposal: { class: "assigned" }, gateTransferred: false });
    expect(findingHandoff("src/b.py", [call("#1", [owner], { status: "no result", prepared: true })], options).class).toBe("assigned");
    const unprepared = findingHandoff("src/b.py", [call("#1", [owner], { status: "no result" })], options);
    expect(unprepared).toMatchObject({ class: "dropped", assigned: [], firstProposal: { call: "#1", status: "no result", class: "assigned" }, gateTransferred: false });
    expect(unprepared.firstAccepted).toBeUndefined();
    expect(unprepared.calls).toEqual([{ call: "#1", status: "no result", prepared: false, class: "assigned", namedBy: ["W1.3"], ownedBy: ["W1.3"] }]);
    // 6. A refusal named it and the session ended during the next call: a transfer only with evidence that the candidates were made.
    const cutUnprepared = findingHandoff("src/b.py", [refused("#1", [mention], ["src/b.py"]), call("#2", [owner], { status: "no result", prepared: false })], { ...options, named });
    expect(cutUnprepared).toMatchObject({ class: "dropped", refusals: [{ call: "#1", nextAssigned: false }], gateTransferred: false, assigned: [] });
    expect(cutUnprepared.refusals[0]!.next).toBeUndefined();
    const cutPrepared = findingHandoff("src/b.py", [refused("#1", [mention], ["src/b.py"]), call("#2", [owner], { status: "no result", prepared: true })], { ...options, named });
    expect(cutPrepared).toMatchObject({ class: "assigned", refusals: [{ call: "#1", next: "#2", nextAssigned: true }], gateTransferred: true, assigned: [{ call: "#2", candidate: "W1.3" }] });
    expect(isAccepted({ status: "accepted" })).toBe(true);
    expect([isAccepted({ status: "refused" }), isAccepted({ status: "no result" }), isAccepted({ status: "no result", prepared: false }), isAccepted({ status: "no result", prepared: true })]).toEqual([false, false, false, true]);
    expect(findingHandoff("src/b.py", [], options)).toEqual({ class: "dropped", assigned: [], calls: [], refusals: [], gateTransferred: false });
    // The best accepted class wins over a later or earlier weaker one.
    expect(findingHandoff("src/b.py", [call("#1", [mention]), call("#2", [owner]), call("#3", [implement("W1.9", "x", ["src/"])])], options).class).toBe("assigned");
  });

  it("reads the findings a refusal's text lists, and the runtime's hand-off events of H2 (by round) and of round 1 (by path)", () => {
    const text = ["Refused (ultra hand-off): 2 analyst finding(s) have no accepted disposition; no copy was made, no candidate ran and no candidate round was used.", "- src/c.py:7 (analyst W1.2, exploration round 1): \"the helper\"", "  in no candidate's request or files", "- Makefile (analyst W1.2, W1.5, exploration round 2): \"build\"", "  named in the request of #1 a but owned by no candidate"].join("\n");
    expect(refusedInText(text)).toEqual([{ path: "src/c.py", exploration: 1 }, { path: "Makefile", exploration: 2 }]);
    expect(refusedInText("Refused: the candidate copies could not be made")).toEqual([]);
    const h2 = runtimeHandoff([
      { type: "ultra", stage: "handoff", worker: "W1", exploration: 1, analysts: ["W1.2"], findings: [{ path: "src/a.py", round: 1, analysts: ["W1.2"], excerpt: "…" }, { path: "lib/z.py", round: 1, analysts: ["W1.2"], excerpt: "…" }], pending: 2 },
      { type: "ultra", stage: "handoff", worker: "W1", candidates: 1, refused: [{ path: "src/a.py", exploration: 1, analysts: ["W1.2"], problems: ["in no candidate's request or files"] }] },
      { type: "ultra", stage: "handoff", worker: "W1", candidates: 1, dispositions: [{ path: "src/a.py", exploration: 1, disposition: "assigned", by: ["W1.3"], round: 1, analysts: ["W1.2"], excerpt: "…" }, { path: "lib/z.py", exploration: 1, disposition: "out-of-scope", round: 1 }] },
      { type: "ultra", stage: "exploration", round: 1 },
    ]);
    expect(h2).toEqual({ events: 3, findings: ["W1 r1 lib/z.py", "W1 r1 src/a.py"], dispositions: { "W1 r1 src/a.py": { disposition: "assigned", by: ["W1.3"] }, "W1 r1 lib/z.py": { disposition: "out-of-scope" } }, outOfScope: ["W1 r1 lib/z.py"], refused: ["W1 r1 src/a.py"], errors: [] });
    const round1 = runtimeHandoff([
      { type: "ultra", stage: "handoff", worker: "W1", exploration: 1, locations: [{ path: "src/a.py", round: 1 }] },
      { type: "ultra", stage: "handoff", worker: "W1", candidates: 1, refused: [{ path: "src/a.py", analysts: ["W1.2"] }] },
      { type: "ultra", stage: "handoff", worker: "W1", candidates: 1, dispositions: [{ path: "src/a.py", disposition: "covered", by: ["W1.3"], round: 1 }] },
    ]);
    expect(round1).toMatchObject({ findings: ["W1 r1 src/a.py"], dispositions: { "W1 r* src/a.py": { disposition: "covered" } }, refused: ["W1 r* src/a.py"] });
    expect(runtimeHandoff([{ type: "ultra", stage: "candidates", round: 1 }]).events).toBe(0);
  });
});

describe("gold, diff and grade parsing", () => {
  it("lists the files a diff touches from its headers only, and classes reference files as source, test or doc", () => {
    const diff = [
      "diff --git a/src/a.py b/src/a.py", "index 1..2 100644", "--- a/src/a.py", "+++ b/src/a.py", "@@ -1,2 +1,2 @@", "--- a/not-a-header.sql", "+x",
      "diff --git a/old name.py b/new name.py", "similarity index 90%", "rename from old name.py", "rename to new name.py",
      "diff --git a/docs/new.rst b/docs/new.rst", "new file mode 100644", "--- /dev/null", "+++ b/docs/new.rst", "@@ -0,0 +1 @@", "+doc",
    ].join("\n");
    expect(diffFiles(diff)).toEqual(["docs/new.rst", "new name.py", "old name.py", "src/a.py"]);
    expect(["src/a.py", "tests/test_a.py", "pkg/test_b.py", "docs/changelog/1.bugfix.rst", "CHANGES.md", "changelog.md", "pyproject.toml", "generate-code.py"].map(fileKind)).toEqual(["source", "test", "test", "doc", "doc", "doc", "source", "source"]);
  });

  it("counts failures of fail-to-pass and pass-to-pass (SWE) and of hidden/visible TAP runs (suite)", () => {
    expect(testCheck({ passed: false, detail: "1/2 passed: tests/x.py::t FAILED" })).toMatchObject({ passed: false, passedTests: 1, total: 2, failures: 1, failing: ["tests/x.py::t FAILED"] });
    expect(testCheck({ passed: true, detail: "165/165 passed (1 excluded)" })).toEqual({ passed: true, passedTests: 165, total: 165, failures: 0, detail: "165/165 passed (1 excluded)" });
    expect(testCheck({ passed: false, detail: "10/12 passed (0 excluded): a::x FAILED; a::y ERROR" })).toMatchObject({ failures: 2, failing: ["a::x FAILED", "a::y ERROR"] });
    expect(testCheck({ passed: true, detail: "exit 0, pass 4, fail 0" })).toMatchObject({ passedTests: 4, total: 4, failures: 0 });
    expect(testCheck(undefined)).toBeUndefined();
  });
});

describe("one unit end to end and the study totals (synthetic records of both arms)", () => {
  const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 24, 1, minute, second)).toISOString();
  const msg = (minute: number, message: unknown, second = 0) => ({ type: "message", timestamp: at(minute, second), message });
  const tool = (id: string, name: string, args: unknown) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
  const result = (id: string, name: string, text: string, isError = false, details?: unknown) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, ...(details ? { details } : {}) });
  const SUMMARY = "Cause in `src/a.py:10-12` and /ws/run-1/ws-abc/src/pkg/b.py:3; the helper ./src/c.py:7 is unaffected; config in lib/z.py; tests/test_basis.py:1 is the basis; see README.md.";
  const DATA = { evidence: [{ location: "src/a.py:40–41", finding: "rounding" }] };

  /** A task's snapshot and gold (src/a.py, src/pkg/b.py and lib/z.py are the reference fix's sources). */
  async function task(root?: string): Promise<TaskSource> {
    root ??= await temp();
    await put(join(root, "src"), { "src/a.py": "a", "src/pkg/b.py": "b", "src/c.py": "c", "src/late.py": "l", "lib/z.py": "z", "tests/test_basis.py": "t", "README.md": "r" });
    const patch = ["src/a.py", "src/pkg/b.py", "lib/z.py", "tests/test_a.py", "docs/changes.rst"].map(path => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y`).join("\n");
    await put(join(root, "task"), { "reference/fix.patch": `${patch}\n` });
    return { kind: "swe", source: join(root, "src"), dir: join(root, "task") };
  }

  /**
   * A unit of arm H (the H2 runtime: a hand-off refusal, then an accepted call with an exclusion; its handoff events) or F (the baseline:
   * the accepted call only, no events). main gave the orchestrator `files: ["src/", "tests/"]`, so lib/z.py and README.md are out of scope.
   */
  async function unit(dir: string, arm: "F" | "H", extraMeta: Record<string, unknown> = {}): Promise<void> {
    const intervention = arm === "H";
    const session = `uho-t1-${arm}-r1`, records = join(dir, "records", session), record = "2026-10-24T01-00-00-000Z_task-aaaa1111";
    await put(dir, {
      "meta.json": JSON.stringify({ unit: `t1/${arm}/r1`, task: "t1", arm, mode: "ultra", status: "completed", sessionId: session, workspace: WS, terminal: intervention ? "blocked" : "done", primaryPass: false, wire: { requests: 42, costUSD: 1.5 }, wallMs: 600_000, ...extraMeta }),
      "grade.json": JSON.stringify({ grade: { passed: false, checks: { failToPass: { passed: false, detail: "1/2 passed: tests/test_a.py::test_z FAILED" }, passToPass: { passed: false, detail: "10/12 passed (0 excluded): tests/test_x.py::a FAILED; tests/test_x.py::b ERROR" }, runner: { passed: true, detail: "exit 1" } } }, integrity: { violations: ["changed/removed 1 line(s) of test file tests/test_basis.py"], suspicious: [] } }),
      // A removed line "-- a/lib/z.py" reads "--- a/lib/z.py" in the hunk: not a file header, so lib/z.py stays untouched.
      "final.diff": "diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n--- a/lib/z.py\n+y\ndiff --git a/src/pkg/b.py b/src/pkg/b.py\n--- a/src/pkg/b.py\n+++ b/src/pkg/b.py\n@@ -1 +1 @@\n-b\n+c\n",
      [`sessions/2026-10-24T01-00-00-000Z_${session}.jsonl`]: jsonl([
        { type: "session", id: session, timestamp: at(0) },
        msg(0, tool("m1", "orche_task", { role: "implement", request: "Fix it", files: ["src/", "tests/"] })),
        msg(21, result("m1", "orche_task", "Task ledger T1, assignment 1: pass task \"T1\" for a follow-up.\nUltra: stage exploration; report gate not reached\nUltra protected basis: tests/test_basis.py", false, { worker: "W1", status: intervention ? "blocked" : "done", task: "T1" })),
      ]),
      [`records/${session}/${record}/run.json`]: JSON.stringify({ version: 1, kind: "task", id: "aaaa1111", status: intervention ? "blocked" : "done", start: at(0), end: at(21), cwd: WS }),
    });
    await writeFile(join(records, record, "events.jsonl"), jsonl([
      { type: "ultra", timestamp: Date.parse(at(1)), worker: "W1", stage: "exploration", round: 1, workers: ["W1.1", "W1.2"] },
      { type: "ultra", timestamp: Date.parse(at(5)), worker: "W1", stage: "exploration", round: 1, basisDone: 1, analystsDone: 1, protected: ["tests/test_basis.py"] },
      ...(intervention ? [
        { type: "ultra", timestamp: Date.parse(at(5)), worker: "W1", stage: "handoff", exploration: 1, analysts: ["W1.2"], findings: ["src/a.py", "src/pkg/b.py", "src/c.py", "lib/z.py", "README.md"].map(path => ({ path, round: 1, analysts: ["W1.2"], excerpt: "…" })), pending: 5 },
        { type: "ultra", timestamp: Date.parse(at(6, 2)), worker: "W1", stage: "handoff", candidates: 1, refused: [{ path: "src/c.py", exploration: 1, analysts: ["W1.2"], problems: ["in no candidate's request or files"] }, { path: "src/pkg/b.py", exploration: 1, analysts: ["W1.2"], problems: ["named in the request of #1 a but owned by no candidate"] }] },
        { type: "ultra", timestamp: Date.parse(at(7)), worker: "W1", stage: "handoff", candidates: 1, dispositions: [
          { path: "src/a.py", exploration: 1, disposition: "assigned", by: ["W1.4"], round: 1 }, { path: "src/pkg/b.py", exploration: 1, disposition: "assigned", by: ["W1.3"], round: 1 }, { path: "src/c.py", exploration: 1, disposition: "excluded", reason: "unaffected helper", evidence: ["T4"], round: 1 },
          { path: "lib/z.py", exploration: 1, disposition: "out-of-scope", round: 1 }, { path: "README.md", exploration: 1, disposition: "out-of-scope", round: 1 }] },
      ] : []),
      { type: "ultra", timestamp: Date.parse(at(7)), worker: "W1", stage: "candidates", round: 1, workers: [{ id: "W1.3", workspace: "/s/ultra/W1.3" }, { id: "W1.4", workspace: "/s/ultra/W1.4" }] },
      { type: "ultra", timestamp: Date.parse(at(13)), worker: "W1", stage: "exploration", round: 2, workers: ["W1.5", "W1.6"] },
    ]));
    const candidates = [{ name: "dir", role: "implement", files: ["src/pkg/"], request: "Own the package and fix src/pkg/b.py." }, { name: "abs", role: "implement", files: ["src/a.py"], request: `Rewrite ${WS}/src/a.py:10 carefully.` }];
    await put(records, {
      "workers/W1-2026-10-24T01-00-00-100Z.jsonl": jsonl([
        { type: "session", id: "sess-w1", timestamp: at(0) },
        msg(1, tool("e1", "orche_spawn", { reason: "exploration", workers: [{ name: "basis", role: "implement", files: ["tests/test_basis.py"], request: "Build the basis." }, { name: "cause", role: "answer", request: "Find the cause." }] })),
        msg(5, result("e1", "orche_spawn", "orche_spawn (exploration): 2 sub-workers\n\nW1.2 cause (answer, 200s, 9 requests; m): done\nclipped summary", false, {
          reason: "exploration", warnings: [], durationMs: 1,
          workers: [{ id: "W1.1", name: "basis", role: "implement", status: "done", changes: ["tests/test_basis.py"], summary: "basis built", data: {} }, { id: "W1.2", name: "cause", role: "answer", status: "done", changes: [], summary: SUMMARY, data: DATA }],
          ultra: ["Ultra exploration round 1/2: 1 basis builder(s) and 1 analyst(s) finished (0 did not).", "Protected verification basis (candidates and you cannot change it; only another exploration round can): tests/test_basis.py."],
        })),
        ...(intervention ? [
          // A path dump: both candidates name the package file, neither owns it; nothing names the helper.
          msg(6, tool("c1", "orche_spawn", { reason: "candidates", workers: [{ name: "a", role: "implement", files: ["src/a.py"], request: "Fix src/a.py; see src/pkg/b.py" }, { name: "b", role: "implement", files: ["src/a.py"], request: "Fix src/a.py another way" }] })),
          msg(6, result("c1", "orche_spawn", "Refused (ultra hand-off): 2 analyst finding(s) have no accepted disposition; no copy was made.\n- src/c.py:7 (analyst W1.2, exploration round 1): \"…\"\n  in no candidate's request or files\n- src/pkg/b.py:3 (analyst W1.2, exploration round 1): \"…\"", true), 5),
        ] : []),
        msg(7, tool("c2", "orche_spawn", { reason: "candidates", workers: candidates, ...(intervention ? { excluded: [{ path: "./src/c.py:7", reason: "unaffected helper", evidence: ["[orche ref T4] grep: no caller"] }] } : {}) })),
        msg(12, result("c2", "orche_spawn", "orche_spawn (candidates): 2 sub-workers", false, { reason: "candidates", warnings: [], durationMs: 1, workers: [{ id: "W1.3", name: "dir", role: "implement", status: "done" }, { id: "W1.4", name: "abs", role: "implement", status: "done" }] })),
        // The last exploration round ran when the assignment ended: no result, its ids from the ultra event, the report from the transcript.
        msg(13, tool("e2", "orche_spawn", { reason: "exploration", workers: [{ name: "basis2", role: "implement", files: ["tests/test_more.py"], request: "More basis." }, { name: "late", role: "answer", request: "Look again." }] })),
      ]),
      "workers/W1.2-2026-10-24T01-01-00-000Z.jsonl": jsonl([{ type: "session", id: "sess-w12" }, msg(4, tool("r", "report_result", { kind: "answer", summary: SUMMARY, data: DATA })), msg(4, result("r", "report_result", "Report recorded."), 1)]),
      "workers/W1.6-2026-10-24T01-13-00-000Z.jsonl": jsonl([{ type: "session", id: "sess-w16" }, msg(20, tool("r", "report_result", { kind: "answer", summary: "Also src/late.py:3 and src/pkg/b.py." }))]),
    });
  }

  it("measures every link of the intervention arm's chain per finding: provenance, class, assignment with files, first proposal, refusals and gate attribution, diff, the runtime cross-check", async () => {
    const dir = join(await temp(), "runs/t1/H/r1");
    await unit(dir, "H");
    const chain = await unitChain(dir, { task: await task() });
    expect(chain).toMatchObject({ id: "t1/H/r1", task: "t1", arm: "H", layout: "ultra-ho", basis: ["tests/test_basis.py"], workspaces: [WS] });
    expect(chain.analysts).toEqual([
      expect.objectContaining({ id: "W1.2", name: "cause", call: "W1 orche_spawn #1", round: 1, status: "done", source: "details", transcript: "same", locations: ["src/a.py", "src/pkg/b.py", "src/c.py", "lib/z.py", "README.md"] }),
      expect.objectContaining({ id: "W1.6", name: "late", call: "W1 orche_spawn #4", round: 2, status: "done", source: "transcript", transcript: "used", locations: ["src/late.py", "src/pkg/b.py"] }),
    ]);
    expect(Object.fromEntries(chain.findings.map(entry => [entry.key, entry.class]))).toEqual({
      "W1 r1 lib/z.py": "out-of-scope", "W1 r1 src/a.py": "assigned", "W1 r1 src/pkg/b.py": "assigned", "W1 r2 src/pkg/b.py": "dropped",
      "W1 r1 README.md": "out-of-scope", "W1 r1 src/c.py": "excluded", "W1 r2 src/late.py": "dropped",
    });
    const byKey = new Map(chain.findings.map(entry => [entry.key, entry]));
    // The package file: the path dump named it without an owner and was refused for it; the next accepted call assigned it: gate-transferred.
    expect(byKey.get("W1 r1 src/pkg/b.py")).toMatchObject({
      decisive: true, lines: ["3"], analysts: [{ id: "W1.2" }], diffTouched: true, firstProposal: { call: "W1 orche_spawn #2", status: "refused", class: "mention-only" },
      firstAccepted: { call: "W1 orche_spawn #3", class: "assigned" }, assigned: [{ call: "W1 orche_spawn #3", candidate: "W1.3", name: "dir", files: ["src/pkg/"] }],
      refusals: [{ call: "W1 orche_spawn #2", problems: ["named in the request of #1 a but owned by no candidate"], next: "W1 orche_spawn #3", nextAssigned: true }], gateTransferred: true, runtime: { disposition: "assigned", by: ["W1.3"] },
    });
    // src/a.py: the first (refused) proposal already assigned it, so its assignment is no gate effect.
    expect(byKey.get("W1 r1 src/a.py")).toMatchObject({ decisive: true, lines: ["10-12", "40-41"], firstProposal: { class: "assigned" }, refusals: [], gateTransferred: false, assigned: [{ candidate: "W1.4", files: ["src/a.py"] }] });
    expect(byKey.get("W1 r1 src/c.py")).toMatchObject({ decisive: false, refusals: [{ next: "W1 orche_spawn #3", nextAssigned: false }], gateTransferred: false });
    // A later round's report of an assigned file is a new finding; nothing came after it.
    expect(byKey.get("W1 r2 src/pkg/b.py")).toMatchObject({ decisive: true, analysts: [{ id: "W1.6" }], calls: [], refusals: [], gateTransferred: false });
    expect(chain.candidates.map(call => [call.ref, call.status, call.scope, call.refused?.map(item => item.path)])).toEqual([["W1 orche_spawn #2", "refused", ["src/", "tests/"], ["src/c.py", "src/pkg/b.py"]], ["W1 orche_spawn #3", "accepted", ["src/", "tests/"], undefined]]);
    expect(chain.handoffRecord).toMatchObject({ events: 3, outOfScope: ["W1 r1 README.md", "W1 r1 lib/z.py"], refused: ["W1 r1 src/c.py", "W1 r1 src/pkg/b.py"], agreement: { analysisOnly: ["W1 r2 src/pkg/b.py", "W1 r2 src/late.py"], runtimeOnly: [], mismatches: [] } });
    expect(chain.implementation).toMatchObject({ diffFiles: ["src/a.py", "src/pkg/b.py"], decisive: [{ key: "W1 r1 lib/z.py", touched: false }, { key: "W1 r1 src/a.py", touched: true }, { key: "W1 r1 src/pkg/b.py", touched: true }, { key: "W1 r2 src/pkg/b.py", touched: true }] });
    expect(chain.implementation.reference.map(file => `${file.path} ${file.kind} ${file.reported ? file.class : "-"} ${file.touched}`)).toEqual(["docs/changes.rst doc - false", "lib/z.py source out-of-scope false", "src/a.py source assigned true", "src/pkg/b.py source assigned true", "tests/test_a.py test - false"]);
    expect(chain.correctness).toMatchObject({ gradePassed: false, failToPass: { failures: 1, failing: ["tests/test_a.py::test_z FAILED"] }, passToPass: { failures: 2 }, integrityViolations: [expect.stringContaining("tests/test_basis.py")] });
    expect(chain.process).toEqual({ terminal: "blocked", primaryPass: false, requests: 42, costUSD: 1.5, wallMinutes: 10, assignments: 1, carried: 0, continuations: 0 });
    expect(chain.chain).toMatchObject({
      findings: 7, reportedDecisive: true, decisive: ["W1 r1 lib/z.py", "W1 r1 src/a.py", "W1 r1 src/pkg/b.py", "W1 r2 src/pkg/b.py"],
      decisiveByClass: { assigned: ["W1 r1 src/a.py", "W1 r1 src/pkg/b.py"], "out-of-scope": ["W1 r1 lib/z.py"], dropped: ["W1 r2 src/pkg/b.py"], "mention-only": [], "owned-only": [], reference: [], excluded: [] },
      decisiveFirstProposalAssigned: ["W1 r1 src/a.py"], decisiveRefused: ["W1 r1 src/pkg/b.py"], decisiveGateTransferred: ["W1 r1 src/pkg/b.py"],
      diffTouchedDecisive: false, diffTouchedReference: false, f2pPassed: false, p2pRegression: true, integrityViolation: true, terminalNonDone: true, refusedCandidates: 1, handoffRefusals: 1,
    });
  });

  it("derives the same classes for the baseline arm from its accepted call alone; writes chain.json per unit and the totals per arm and task; a destination elsewhere, never a frozen one", async () => {
    const out = await temp();
    await unit(join(out, "runs/t1/H/r1"), "H");
    await unit(join(out, "runs/t1/F/r1"), "F");
    await put(out, { "runs/t1/F/r2/meta.json": JSON.stringify({ unit: "t1/F/r2", task: "t1", arm: "F", status: "running" }), "runs/t1/F/r1.interrupted-1/meta.json": "{}" });
    const source = await task();
    const { summary, text } = await writeChains(out, { task: () => source });
    const f = JSON.parse(readFileSync(join(out, "runs/t1/F/r1/chain.json"), "utf8"));
    // The same accepted call: owned and named files are assigned, the unnamed helper is dropped; main's files make lib/z.py and README.md out of scope.
    expect(Object.fromEntries(f.findings.map((entry: any) => [entry.key, [entry.class, entry.gateTransferred]]))).toEqual({
      "W1 r1 lib/z.py": ["out-of-scope", false], "W1 r1 src/a.py": ["assigned", false], "W1 r1 src/pkg/b.py": ["assigned", false], "W1 r2 src/pkg/b.py": ["dropped", false],
      "W1 r1 README.md": ["out-of-scope", false], "W1 r1 src/c.py": ["dropped", false], "W1 r2 src/late.py": ["dropped", false],
    });
    expect(f.handoffRecord.events).toBe(0);
    expect(existsSync(join(out, "runs/t1/H/r1/chain.json"))).toBe(true);
    expect(summary.arms.F).toMatchObject({ units: 1, reportedDecisive: 1, decisiveAllAssigned: 0, decisiveNotAllAssigned: 1, f2pPassed: 0, p2pRegressions: 1, terminalNonDone: 0, primaryPass: 0, refusedCandidates: 0, decisiveFindings: { total: 4, assigned: 2, "out-of-scope": 1, dropped: 1, diffTouched: 3, firstProposalAssigned: 2, refused: 0, gateTransferred: 0 }, requests: 42, costUSD: 1.5 });
    expect(summary.arms.H).toMatchObject({ units: 1, terminalNonDone: 1, refusedCandidates: 1, handoffRefusals: 1, findings: { total: 7, assigned: 2, excluded: 1, "out-of-scope": 2, dropped: 2 }, decisiveFindings: { total: 4, firstProposalAssigned: 1, refused: 1, gateTransferred: 1 } });
    expect(Object.keys(summary.tasks.t1!)).toEqual(["F", "H"]);
    expect(summary.units.find(item => item.id === "t1/F/r2")).toMatchObject({ status: "running" });
    expect(JSON.parse(readFileSync(join(out, "chain.json"), "utf8")).arms.H.decisiveFindings.gateTransferred).toBe(1);
    expect(readFileSync(join(out, "chain.md"), "utf8")).toBe(`${text}\n`);
    expect(text).toContain("- DECISIVE src/pkg/b.py:3 (W1 round 1; analysts W1.2): assigned; assigned to W1.3 [files src/pkg/] in W1 orche_spawn #3; first proposal W1 orche_spawn #2 (refused): mention-only; refusals naming it: W1 orche_spawn #2 → W1 orche_spawn #3 assigned it; gate-transferred: yes; runtime: assigned by W1.3; final.diff touches it");
    expect(text).toContain("- t1/F/r2: status running");
    // Another destination: the units are read from `out` and written there only.
    const dest = join(await temp(), "reanalysis");
    const again = await writeChains(out, { task: () => source, dest });
    expect(again.dest).toBe(dest);
    expect(existsSync(join(dest, "runs/t1/H/r1/chain.json")) && existsSync(join(dest, "chain.md"))).toBe(true);
    // A frozen study directory is refused before anything is read or written (also through a link).
    const frozen = await temp();
    await symlink(frozen, join(dest, "alias"));
    await expect(writeChains(out, { task: () => source, dest: join(frozen, "sub"), frozen: [frozen] })).rejects.toThrow(/outputs are frozen/);
    await expect(writeChains(out, { task: () => source, dest: join(dest, "alias", "x"), frozen: [frozen] })).rejects.toThrow(/outputs are frozen/);
    expect(existsSync(join(frozen, "sub"))).toBe(false);
  });

  it("never writes into round 1's stage-3 outputs: results/ultra-ho/stage3 is frozen (checked on the path alone)", () => {
    expect(FROZEN_OUTPUTS).toEqual(["results/ultra-ho/stage3"]);
    expect(() => assertWritable(join(REPO, "results/ultra-ho/stage3"))).toThrow(/outputs are frozen/);
    expect(() => assertWritable(join(REPO, "results/ultra-ho/stage3/runs/x"))).toThrow(/outputs are frozen/);
    expect(() => assertWritable(join(REPO, "results/ultra-ho/stage3-r2"))).not.toThrow();
  });

  it("reads the gold under the unit's own fixture root (meta.fixtureRoot, meta.sweCacheSource): an r2 task is analysed like a canonical one", async () => {
    const root = await temp();
    const fixtures = join(root, "fixtures/advisor-bench/swe-r2"), cache = join(root, "results/advisor-reviewer/cache/swe-r2");
    const made = await task(root);
    await put(join(fixtures, "t1"), { "task.json": "{}", "hidden/test.patch": "", "reference/fix.patch": readFileSync(join(made.dir, "reference/fix.patch"), "utf8") });
    await mkdir(join(cache, "t1"), { recursive: true });
    await symlink(made.source, join(cache, "t1", "src"));
    expect(await unitTask({ task: "t1", kind: "swe", fixtureRoot: fixtures, sweCacheSource: cache })).toEqual({ kind: "swe", dir: join(fixtures, "t1"), source: join(cache, "t1", "src") });
    expect(await unitTask({ task: "t1", kind: "suite", fixtureRoot: fixtures })).toEqual({ kind: "suite", dir: join(fixtures, "t1"), source: join(fixtures, "t1", "repo") });
    // Without a recorded cache source: the canonical cache under the repository.
    expect((await unitTask({ task: "t1", kind: "swe", fixtureRoot: fixtures }, root)).source).toBe(join(root, "results/advisor-reviewer/cache/swe/t1/src"));
    const dir = join(root, "runs/t1/H/r1");
    await unit(dir, "H", { kind: "swe", fixtureRoot: fixtures, sweCacheSource: cache });
    const chain = await unitChain(dir);
    expect(chain.fixture).toBe(join(fixtures, "t1"));
    expect(chain.chain.decisive).toEqual(["W1 r1 lib/z.py", "W1 r1 src/a.py", "W1 r1 src/pkg/b.py", "W1 r2 src/pkg/b.py"]);
    expect(chain.chain.decisiveGateTransferred).toEqual(["W1 r1 src/pkg/b.py"]);
  });
});

// The historical hand-off loss (results/ultra-ab/main, the older ultra-ab layout; results/ is local, not versioned).
const TOX_UNIT = fileURLToPath(new URL("../../results/ultra-ab/main/runs/tox-dev__tox-3904/B/r1", import.meta.url));
const TOX_SNAPSHOT = fileURLToPath(new URL("../../results/advisor-reviewer/cache/swe/tox-dev__tox-3904/src", import.meta.url));
describe.skipIf(!existsSync(join(TOX_UNIT, "meta.json")) || !existsSync(TOX_SNAPSHOT))("the historical hand-off loss: tox-dev__tox-3904 B r1 (ultra-ab layout)", () => {
  it("finds the analyst-reported toml/_replace.py and classifies it as dropped: both candidate rounds were scoped to the INI loader", async () => {
    const chain = await unitChain(TOX_UNIT);
    expect(chain).toMatchObject({ id: "tox-dev__tox-3904/B/r1", arm: "B", layout: "ultra-ab", mode: "ultra" });
    expect(chain.analysts).toEqual([expect.objectContaining({ id: "W1.3", name: "factor-analysis", round: 1, status: "done", source: "details", transcript: "same" })]);
    const toml = chain.findings.find(entry => entry.path === "src/tox/config/loader/toml/_replace.py");
    expect(toml).toMatchObject({ key: "W1 r1 src/tox/config/loader/toml/_replace.py", lines: ["46-57"], decisive: true, reference: "source", diffTouched: false, class: "dropped", assigned: [], gateTransferred: false });
    expect(toml!.calls.map(item => item.class)).toEqual(["dropped", "dropped"]);
    expect(toml!.analysts).toEqual([expect.objectContaining({ id: "W1.3", excerpt: expect.stringContaining("The same unconditional union exists in TOML at `src/tox/config/loader/toml/_replace.py:46–57`") })]);
    // Both accepted candidates rounds: every candidate owns only the INI factor module for production, and no request names the TOML loader.
    expect(chain.candidates.map(call => call.status)).toEqual(["accepted", "accepted"]);
    for (const worker of chain.candidates.flatMap(call => call.workers)) {
      expect(worker.files.filter(file => file.startsWith("src/"))).toEqual(["src/tox/config/loader/ini/factor.py"]);
      expect(worker.request).not.toContain("toml/_replace");
    }
    // The INI factor module was owned by every candidate, but no request named its path (they described it): owned-only under H2's test.
    expect(chain.findings.find(entry => entry.path === "src/tox/config/loader/ini/factor.py")).toMatchObject({ decisive: true, diffTouched: true, class: "owned-only", firstProposal: { class: "owned-only" }, assigned: [] });
    expect(chain.basis).toEqual(["tests/config/loader/ini/test_factor_arch_commands.py", "tests/config/loader/ini/test_factor_arch_selection.py"]);
    expect(chain.chain).toMatchObject({ reportedDecisive: true, decisiveByClass: { assigned: [], "owned-only": ["W1 r1 src/tox/config/loader/ini/factor.py"], dropped: expect.arrayContaining(["W1 r1 src/tox/config/loader/toml/_replace.py"]) }, decisiveGateTransferred: [], diffTouchedDecisive: false, f2pPassed: false, p2pRegression: false, terminalNonDone: false, primaryPass: false, refusedCandidates: 0 });
    expect(chain.correctness.failToPass).toMatchObject({ passed: false, passedTests: 1, total: 2, failures: 1, failing: ["tests/config/source/test_toml_pyproject.py::test_toml_machine_isa_does_not_override_explicit_env_factor FAILED"] });
    expect(chain.process).toMatchObject({ terminal: "done", requests: 280, costUSD: null, assignments: 1, carried: 0 });
  });
});
