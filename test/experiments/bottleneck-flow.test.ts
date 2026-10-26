// Control flow of the bottleneck-isolation runner without any model (protocol §4, §6, §10): the delivery runtime is replaced by a
// scripted fake that leaves the files a real turn would leave in its record. Exercises the single shortening opportunity on every
// branch, schema failures versus technical re-execution, interrupted turns, the stop rule, the readiness gate and hash-exact delivery.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", calls: [] as any[], technical: new Set<string>(), interrupted: new Set<string>(), script: {} as Record<string, (spec: any) => Record<string, string>> }));
vi.mock("../../experiments/mdsd-ab/delivery-runtime.js", async () => {
  const fs = await import("node:fs/promises"), fsSync = await import("node:fs"), path = await import("node:path");
  const turn = async (spec: any) => {
    const key = `${spec.label}#${spec.number}`;
    state.calls.push({ key, label: spec.label, number: spec.number, prompt: spec.prompt, inputs: spec.inputs, model: spec.model, effort: spec.effort });
    const record = path.join(spec.record, `turn-${spec.number}`);
    if (state.interrupted.has(key)) return { label: spec.label, number: spec.number, record, ok: false, interrupted: true, technical: ["interrupted (started without a result; never rerun in place)"], reply: "", thinking: spec.effort };
    const failing = state.technical.has(key);
    const kind = Object.keys(state.script).filter(k => key.includes(k)).sort((a, b) => b.length - a.length)[0];
    const files = failing ? {} : kind ? state.script[kind]!(spec) : {};
    const work = path.join(spec.session, "work");
    await fs.mkdir(work, { recursive: true });
    for (const [n, b] of Object.entries(files)) await fs.writeFile(path.join(work, n), b);
    await fs.mkdir(path.join(record, "outputs"), { recursive: true });
    for (const n of await fs.readdir(work)) await fs.copyFile(path.join(work, n), path.join(record, "outputs", n));
    return { label: spec.label, number: spec.number, record, ok: !failing, technical: failing ? ["final stop error: scripted 503"] : [], reply: `reply ${key}`, finalStop: failing ? "error" : "stop", ms: 1, thinking: spec.effort, routeOk: true, inputsAfter: { unchanged: true }, wire: { costUSD: 0.01, requests: 1, unknownUsage: 0 } };
  };
  const real = path.join(process.cwd(), "results/delivery-validation");
  return {
    ROOT: real, INPUT_ROOT: real, MODEL: "cliproxyapi/gpt-6-astra", JUDGES: ["cliproxyapi/claude-opus-5-5", "cliproxyapi/gpt-6-astra"], PINS: "", PROVIDER: "", MEASURED_EFFORT: "max", INSTRUMENT_EFFORT: "max",
    VARIANT: { name: "max", root: "results/delivery-validation", inputs: "results/delivery-validation", measuredEffort: "max", sessionPrefix: "dv" }, GUARDS: { compose: 1, audit: 1, revise: 1, recheck: 1, fix: 1, judge: 1, pairwise: 1 },
    turn, outputOf: (t: any, f: string) => { const p = path.join(t.record, "outputs", f); return fsSync.existsSync(p) ? fsSync.readFileSync(p, "utf8") : ""; },
    retainSession: async () => {}, setStudy: () => {}, setup: async () => {}, studyDir: () => path.join(state.root, "scratch"), sourceHashes: () => ({}), checkPins: () => {}, freezePins: async () => ({}), providerHashes: () => ({}),
  };
});

const AUDIT_OK = JSON.stringify({ defects: [{ id: "D1", kind: "partial", refs: ["k1"], where: "x", problem: "condition missing", fix: "add it" }] });
let n = 0, unique = 0;
beforeAll(async () => { const base = join(process.cwd(), ".orche/bottleneck-tests"); await mkdir(base, { recursive: true }); state.root = await mkdtemp(join(base, "flow-")); });
afterAll(async () => { if (state.root) await rm(state.root, { recursive: true, force: true }); });
beforeEach(() => { state.calls = []; state.technical.clear(); state.interrupted.clear(); state.script = {}; n++; });
const specOf = async (label: string, cap = 100) => {
  const b = await import("../../experiments/mdsd-ab/bottleneck.js");
  const ledgerObj = { ledger: "toy", entries: [] } as any, u = ++unique;
  return { b, spec: { ledger: "toy", arm: "R" as const, rep: u, cap, packet: { "task.md": "task", "guide.md": "guide", "ledger.json": "{}", "ledger.md": "# l" }, ledgerObj, label: `${label}${u}`, scratchRoot: join(state.root, `s${u}`), recordRoot: join(state.root, `r${u}`) } };
};

describe("Experiment-1 cell flow (scripted runtime)", () => {
  it("gives an over-cap final exactly one shortening turn, never truncates, and rechecks the delivered bytes", async () => {
    const { b, spec } = await specOf("cellA");
    const long = "x".repeat(120), longer = "y".repeat(140), shorter = "z".repeat(110);
    state.script = { "-compose#1": () => ({ "final.md": long }), "-audit#1": () => ({ "audit.json": AUDIT_OK }), "-compose#2": () => ({ "final.md": longer }), "-compose#3": () => ({ "final.md": shorter }), "-recheck#1": () => ({ "audit.json": "{\"defects\":[]}" }) };
    const out = await b.attemptCell(spec, 1);
    expect(out.technicalFailure).toBeUndefined();
    expect(out.stages.map((s: any) => s.stage)).toEqual(["compose", "audit", "revise", "shorten", "recheck"]);
    expect(out).toMatchObject({ draftChars: 120, preShortenChars: 140, shortened: true, finalChars: 110, overCap: true, outcome: "complete" });
    expect(out.files["final.md"]).toBe(shorter);
    const recheck = state.calls.find(c => c.key.endsWith("-recheck#1"))!;
    expect(recheck.inputs["final.md"]).toBe(shorter);
    expect(recheck.inputs["revision-note.md"]).toContain("[Length-limit shortening]");
    expect(state.calls.find(c => c.key.endsWith("-compose#3"))!.prompt).toContain("has 140 characters, more than the length limit of 100 characters");
    expect(state.calls.every(c => c.effort === "max" && c.model === "cliproxyapi/gpt-6-astra")).toBe(true);
    expect(JSON.parse(out.files["length.json"])).toMatchObject({ cap: 100, finalChars: 110, overCap: true, shortened: true });
  });
  it("skips the shortening turn for a final within the cap", async () => {
    const { b, spec } = await specOf("cellB", 500);
    state.script = { "-compose#1": () => ({ "final.md": "short answer" }), "-audit#1": () => ({ "audit.json": AUDIT_OK }), "-compose#2": () => ({ "final.md": "short answer, revised" }), "-recheck#1": () => ({ "audit.json": "{\"defects\":[]}" }) };
    const out = await b.attemptCell(spec, 1);
    expect(out.stages.map((s: any) => s.stage)).toEqual(["compose", "audit", "revise", "recheck"]);
    expect(out).toMatchObject({ shortened: false, overCap: false, finalChars: 21 });
  });
  it("applies the one length step also when the review is unavailable (unusable audit after its fix), without a recheck", async () => {
    const { b, spec } = await specOf("cellC");
    state.script = { "-compose#1": () => ({ "final.md": "w".repeat(130) }), "-audit#1": () => ({ "audit.json": "not json" }), "-audit#2": () => ({ "audit.json": "{\"nope\":1}" }), "-compose#2": () => ({ "final.md": "v".repeat(90) }) };
    const out = await b.attemptCell(spec, 1);
    expect(out.stages.map((s: any) => s.stage)).toEqual(["compose", "audit", "audit-fix", "shorten"]);
    expect(out.reviewAvailable).toBe(false);
    expect(out).toMatchObject({ shortened: true, finalChars: 90, overCap: false });
    expect(out.outcome).toMatch(/review unavailable/);
  });
  it("treats a missing final as a schema problem (one fix, then a measured failure), not as a technical re-execution", async () => {
    const { b, spec } = await specOf("cellD");
    state.script = { "-compose#1": () => ({}), "-compose#2": () => ({ "notes.md": "no answer" }) };
    const out = await b.attemptCell(spec, 1);
    expect(out.stages.map((s: any) => s.stage)).toEqual(["compose", "compose-fix"]);
    expect(out.technicalFailure).toBeUndefined();
    expect(out.deliverable).toBe(false);
  });
  it("re-executes a technically failed or interrupted attempt once from the start and then stops; the stop rule blocks new dispatch", async () => {
    const { b, spec } = await specOf("cellE", 500);
    const d = new b.Dispatch(join(state.root, `dispatch-${n}.json`));
    state.script = { "-compose#1": () => ({ "final.md": "answer" }), "-audit#1": () => ({ "audit.json": AUDIT_OK }), "-compose#2": () => ({ "final.md": "answer 2" }), "-recheck#1": () => ({ "audit.json": "{\"defects\":[]}" }) };
    state.interrupted.add(`${spec.label}-a1-audit#1`);
    await b.cell(spec, d);
    const p = JSON.parse(readFileSync(join(spec.recordRoot, "pipeline.json"), "utf8"));
    expect(p).toMatchObject({ status: "complete", finalAttempt: 2 });
    expect(p.attempts[0].technicalFailure).toMatch(/interrupted/);
    expect(d.state.attempts.map((a: any) => a.outcome)).toEqual(["technical", "complete"]);
    expect(readFileSync(join(spec.recordRoot, "final", "final.md"), "utf8")).toBe("answer 2");
    // both attempts fail: technically incomplete, no third attempt
    const { spec: s2 } = await specOf("cellF", 500);
    state.technical.add(`${s2.label}-a1-compose#1`); state.technical.add(`${s2.label}-a2-compose#1`);
    await b.cell(s2, d);
    expect(JSON.parse(readFileSync(join(s2.recordRoot, "pipeline.json"), "utf8")).status).toBe("technically-incomplete");
    expect(state.calls.filter(c => c.label.startsWith(s2.label))).toHaveLength(2);
    // 3 of 4 started attempts failed technically (> 25%): no further dispatch; the next cell stays pending without a model call
    expect(d.stop()).toMatch(/technical failures 3\/4 started attempts exceed 25%/);
    const { spec: s4 } = await specOf("cellH", 500);
    await b.cell(s4, d);
    expect(existsSync(join(s4.recordRoot, "pipeline.json"))).toBe(false);
    expect(state.calls.some(c => c.label.startsWith(s4.label))).toBe(false);
    expect(d.state.stopped).toMatch(/exceed 25%/);
  });
  it("reuses a completed cell only after its frozen hashes check", async () => {
    const { b, spec } = await specOf("cellI", 500);
    const d = new b.Dispatch(join(state.root, `dispatch-${n}.json`));
    state.script = { "-compose#1": () => ({ "final.md": "answer" }), "-audit#1": () => ({ "audit.json": "{\"defects\":[]}" }), "-compose#2": () => ({ "final.md": "answer" }), "-recheck#1": () => ({ "audit.json": "{\"defects\":[]}" }) };
    await b.cell(spec, d);
    const calls = state.calls.length;
    await b.cell(spec, d);
    expect(state.calls.length).toBe(calls);
    await writeFile(join(spec.recordRoot, "final", "final.md"), "tampered");
    await expect(b.cell(spec, d)).rejects.toThrow(/frozen file changed/);
  });
  it("keeps Experiment-1 instruments closed until all twelve finals are frozen", async () => {
    const b = await import("../../experiments/mdsd-ab/bottleneck.js");
    const root = join(state.root, `ready-${n}`);
    expect(b.exp1Ready(root)).toMatchObject({ ready: false });
    expect(b.exp1Ready(root).pending).toHaveLength(12);
    for (const c of b.CELLS.slice(0, 11)) { await mkdir(join(root, "exp1/runs", c.ledger, `${c.arm}-r${c.rep}`), { recursive: true }); await writeFile(join(root, "exp1/runs", c.ledger, `${c.arm}-r${c.rep}`, "pipeline.json"), "{}"); }
    expect(b.exp1Ready(root).pending).toEqual(["isort-r1.Q-r2/R-r2"]);
  });
});

describe("Experiment-2-b selector delivery (scripted runtime)", () => {
  it("accepts only an id, gives one schema fix, and delivers the stored bytes with a verified hash", async () => {
    const b = await import("../../experiments/mdsd-ab/bottleneck.js"), { sha } = await import("../../experiments/mdsd-ab/run.js");
    const root = join(state.root, `sel-${n}`), stored = join(root, "stored-E.md");
    await mkdir(root, { recursive: true });
    await writeFile(stored, "stored E bytes\n");
    const rel = stored.slice(process.cwd().length + 1);
    const manifest = { candidates: { E: { stored: rel, storedSha256: sha("stored E bytes\n") }, S: { stored: rel, storedSha256: "0".repeat(64) } } };
    state.script = { "select-k-a1#1": () => ({ "selection.json": "{\"candidate_id\":\"candidate-2\",\"why\":\"E is better\"}" }), "select-k-a1#2": () => ({ "selection.json": "{\"candidate_id\":\"candidate-2\"}" }) };
    const dest = join(root, "delivered.md");
    await b.instrumentBI({ kind: "select", key: "k", model: "cliproxyapi/gpt-6-astra", prompt: b.SELECT, fix: b.SELECT_FIX, inputs: { "candidate-1.md": "S", "candidate-2.md": "E" }, validate: b.checkSelection, output: "selection.json", guard: 1, extra: {}, root,
      target: async dir => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, "calc.js"), "x"); },
      onValid: async raw => ({ chosen: ["S", "E"][b.CANDIDATE_IDS.indexOf(JSON.parse(raw).candidate_id)], delivered: await b.deliverChoice("toy", "E", dest, manifest) }) });
    const r = JSON.parse(readFileSync(b.instrumentFile("select", "k", root), "utf8"));
    expect(r).toMatchObject({ valid: true, chosen: "E", value: { candidate_id: "candidate-2" } });
    expect(r.attempts[0].turns).toHaveLength(2);
    expect(state.calls[1].prompt).toContain("selection.json must contain exactly one key, candidate_id");
    expect(readFileSync(dest, "utf8")).toBe("stored E bytes\n");
    expect(r.delivered).toMatchObject({ matches: true, sha256: sha("stored E bytes\n") });
    await expect(b.deliverChoice("toy", "S", join(root, "bad.md"), manifest)).rejects.toThrow(/do not match the frozen candidate hash/);
  });
  it("re-executes an instrument once after a technical failure and records an invalid result without counting it as zero", async () => {
    const b = await import("../../experiments/mdsd-ab/bottleneck.js");
    const root = join(state.root, `inst-${n}`);
    state.technical.add("bi-pairwise-p-a1#1"); state.technical.add("bi-pairwise-p-a2#1");
    await b.instrumentBI({ kind: "pairwise", key: "p", model: "cliproxyapi/claude-opus-5-5", prompt: b.PAIR_U, fix: "fix {ERRORS}", inputs: {}, validate: () => [], output: "pairwise.json", guard: 1, extra: {}, root });
    const r = JSON.parse(readFileSync(b.instrumentFile("pairwise", "p", root), "utf8"));
    expect(r).toMatchObject({ valid: false, technicalFailure: true });
    expect(r.attempts).toHaveLength(2);
    expect(state.calls).toHaveLength(2);
  });
});
