// Control flow of the delivery pipelines and instruments without any model: the session runtime is replaced by a scripted fake that
// writes the files a real turn would leave in its record, so cell/attempt/fallback/re-execution logic is exercised end to end.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", calls: [] as any[], failOnce: new Set<string>(), script: {} as Record<string, (spec: any) => Record<string, string> | "fail"> }));
vi.mock("../../experiments/mdsd-ab/delivery-runtime.js", async () => {
  const fs = await import("node:fs/promises"), fsSync = await import("node:fs"), path = await import("node:path");
  const turn = async (spec: any) => {
    state.calls.push({ label: spec.label, number: spec.number, inputs: Object.keys(spec.inputs), model: spec.model, effort: spec.effort });
    const record = path.join(spec.record, `turn-${spec.number}`);
    const key = `${spec.label}#${spec.number}`;
    const failing = state.failOnce.has(key);
    if (failing) state.failOnce.delete(key);
    const kind = Object.keys(state.script).find(k => spec.label.includes(k)) ?? "";
    const files = failing ? "fail" : state.script[kind]?.(spec) ?? {};
    // outputs accumulate across the turns of one session, like the private work directory
    const work = path.join(spec.session, "work");
    await fs.mkdir(work, { recursive: true });
    if (files !== "fail") for (const [n, b] of Object.entries(files)) await fs.writeFile(path.join(work, n), b);
    await fs.mkdir(path.join(record, "outputs"), { recursive: true });
    for (const n of await fs.readdir(work)) await fs.copyFile(path.join(work, n), path.join(record, "outputs", n));
    const ok = files !== "fail";
    return { label: spec.label, number: spec.number, record, ok, technical: ok ? [] : ["final stop error: scripted outage"], reply: `reply ${key}`, finalStop: ok ? "stop" : "error", ms: 1, thinking: spec.effort, wire: { costUSD: 0.01, requests: 1, unknownUsage: 0 } };
  };
  return {
    // the replication's role-based efforts: measured turns high, instruments max; inputs read in place from another root
    ROOT: state.root, INPUT_ROOT: state.root, MODEL: "cliproxyapi/gpt-6-astra", JUDGES: ["cliproxyapi/claude-opus-5-5", "cliproxyapi/gpt-6-astra"], PINS: "", PROVIDER: "", MEASURED_EFFORT: "high", INSTRUMENT_EFFORT: "max", VARIANT: { name: "effort-high", root: "x", inputs: "x", measuredEffort: "high", sessionPrefix: "dvh", baseline: "y" }, GUARDS: { compose: 1, audit: 1, revise: 1, recheck: 1, fix: 1, judge: 1, pairwise: 1 },
    turn, outputOf: (t: any, f: string) => { const p = path.join(t.record, "outputs", f); return fsSync.existsSync(p) ? fsSync.readFileSync(p, "utf8") : ""; },
    retainSession: async () => {}, setStudy: () => {}, setup: async () => {}, studyDir: () => path.join(state.root, "scratch"), sourceHashes: () => ({}), checkPins: () => {}, freezePins: async () => ({}), providerHashes: () => ({}),
  };
});

beforeAll(async () => { const base = join(process.cwd(), ".orche/delivery-tests"); await mkdir(base, { recursive: true }); state.root = await mkdtemp(join(base, "flow-")); });
afterAll(async () => { if (state.root) await rm(state.root, { recursive: true, force: true }); });

describe("delivery cells and instruments (scripted runtime)", () => {
  it("runs both arms through compose, fix, audit, revise and recheck, re-executes a technically failed attempt once, and judges the finals", async () => {
    const d = await import("../../experiments/mdsd-ab/delivery.js");
    const { ledger } = d.canonicalLedger("toy", d.TOY.claims, d.TOY.plan, {});
    const dir = join(state.root, "inputs", "toy");
    await mkdir(dir, { recursive: true });
    for (const [n, b] of Object.entries({ "task.md": d.TOY.task, "guide.md": d.TOY.guide, "ledger.json": d.ledgerJson(ledger), "ledger.md": d.ledgerMarkdown(ledger), "judge-ledger.json": d.judgeLedger(ledger), "judge-background.json": d.judgeBackground(ledger) })) await writeFile(join(dir, n), b);
    const arrangement = { main: ["k1", "k2"], sections: [{ label: "Supporting details", span: null, from: null, items: ["k3", "k4"] }], appendix: [] };
    let composeCalls = 0;
    state.script = {
      "toy-C-r1-a1-compose": spec => { composeCalls++; return spec.number === 1 ? { "final.md": "Answer mentioning k1 by mistake." } : { "final.md": "The answer: mean computes the average." }; },
      "toy-C-r1-a1-audit": () => ({ "audit.json": JSON.stringify({ defects: [{ id: "D1", kind: "absent", refs: ["k3"], where: "absent", problem: "sum detail missing", fix: "add it" }] }) }),
      "toy-C-r1-a1-recheck": () => ({ "audit.json": "{\"defects\":[]}" }),
      "toy-B-r1-a1-compose": () => ({ "arrangement.json": JSON.stringify(arrangement) }),
      "toy-B-r1-a2-compose": () => ({ "arrangement.json": JSON.stringify(arrangement) }),
      "toy-B-r1-a2-audit": spec => spec.number === 1 ? { "audit.json": "not json" } : { "audit.json": JSON.stringify({ defects: [] }) },
      "toy-B-r1-a2-recheck": () => ({ "audit.json": "{\"defects\":[]}" }),
      // only the Claude judge is scripted: the GPT judge writes nothing, so its fix continuation also fails and the judgment is invalid
      "judge-C-r1-claude": () => ({ "judgment.json": JSON.stringify({ items: ledger.entries.map(e => ({ id: e.id, realization: "missing", stance: "absent", status: "not_applicable", conditions: "not_applicable", quote: "" })), other: [], contradictions: [], usefulness: { answersTask: 2, organization: 2, readability: 3, statusClarity: 2, concision: 4, mainAnswerLines: [1], problems: [] } }) }),
    };
    state.failOnce.add("toy-B-r1-a1-audit#1");
    await d.cell("toy" as any, "C", 1);
    await d.cell("toy" as any, "B", 1);
    const c = JSON.parse(readFileSync(join(state.root, "runs/toy/C-r1/pipeline.json"), "utf8"));
    expect(c.status).toBe("complete");
    expect(c.attempts[0].stages.map((s: any) => s.stage)).toEqual(["compose", "compose-fix", "audit", "revise", "recheck"]);
    expect(composeCalls).toBe(3);
    expect(readFileSync(join(state.root, "runs/toy/C-r1/final/final.md"), "utf8")).toBe("The answer: mean computes the average.");
    expect(existsSync(join(state.root, "runs/toy/C-r1/final/revision.diff"))).toBe(true);
    const b = JSON.parse(readFileSync(join(state.root, "runs/toy/B-r1/pipeline.json"), "utf8"));
    expect(b.status).toBe("complete");
    expect(b.finalAttempt).toBe(2);
    expect(b.attempts[0].technicalFailure).toMatch(/audit: final stop error/);
    expect(b.attempts[1].stages.map((s: any) => s.stage)).toEqual(["compose", "audit", "audit-fix", "revise", "recheck"]);
    const bFinal = readFileSync(join(state.root, "runs/toy/B-r1/final/final.md"), "utf8");
    const bCheck = JSON.parse(readFileSync(join(state.root, "runs/toy/B-r1/final/check.json"), "utf8"));
    expect(bCheck.errors).toEqual([]);
    expect(bFinal).toContain("## Supporting details");
    // the second call is a no-op once pipeline.json exists
    const before = state.calls.length;
    await d.cell("toy" as any, "B", 1);
    expect(state.calls.length).toBe(before);
    // every measured turn (compose, fixes, audit, audit-fix, revise, recheck) runs at the measured effort; pipeline.json records it
    const measured = state.calls.filter(x => /^toy-[CB]-r1-a\d-(compose|audit|recheck)$/.test(x.label));
    expect(new Set(measured.map(x => x.label.replace(/^toy-[CB]-r1-a\d-/, "")))).toEqual(new Set(["compose", "audit", "recheck"]));
    expect(measured.length).toBeGreaterThanOrEqual(12);
    expect(measured.every(x => x.effort === "high")).toBe(true);
    expect(c.thinking).toBe("high");
    expect(b.thinking).toBe("high");
    // composer inputs: identical shared packet; B additionally gets the renderer
    const cCompose = state.calls.find(x => x.label === "toy-C-r1-a1-compose" && x.number === 1)!, bCompose = state.calls.find(x => x.label === "toy-B-r1-a2-compose" && x.number === 1)!;
    expect(cCompose.inputs).toEqual(["task.md", "guide.md", "ledger.json", "ledger.md"]);
    expect(bCompose.inputs).toEqual(["task.md", "guide.md", "ledger.json", "ledger.md", "render.mjs"]);
    await d.judge("toy", "C-r1", "cliproxyapi/claude-opus-5-5");
    const j = JSON.parse(readFileSync(join(state.root, "judgments/toy/C-r1.claude.json"), "utf8"));
    expect(j.valid).toBe(true);
    expect(j.textSha256).toBeTruthy();
    await d.judge("toy", "C-r1", "cliproxyapi/gpt-6-astra");
    const g = JSON.parse(readFileSync(join(state.root, "judgments/toy/C-r1.gpt.json"), "utf8"));
    expect(g.valid).toBe(false);
    expect(g.errors.join(" ")).toMatch(/judgment.json needs items/);
    // instruments (judge turns and their fix continuations) stay at max
    const judging = state.calls.filter(x => x.label.includes("-judge-"));
    expect(judging.length).toBeGreaterThanOrEqual(3);
    expect(judging.every(x => x.effort === "max")).toBe(true);
  });
});
