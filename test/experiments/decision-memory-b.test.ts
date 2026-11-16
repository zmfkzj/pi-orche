import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeEvidence } from "../../experiments/decision-memory-b/evidence.js";
import { startFeed } from "../../experiments/decision-memory-b/feed.js";
import { CHECK_REQ, E2E_REQ, FEED_EMPTY, REQUIREMENTS, TEMPLATES, expected, feedText, finalReport, generate, grade, instance, request, writeFiles } from "../../experiments/decision-memory-b/project.js";
import { ARMS, ARM_CONFIG, CONTRASTS, bootstrap, cellMeans, informative, interactionVerdict, practicallyUseful, schedule, signFlipP } from "../../experiments/decision-memory-b/protocol.js";
import { checkTemplates, PILOT_SEEDS, SCORED_SEEDS } from "../../experiments/decision-memory-b/validate.js";
import { loadOrcheConfigFile } from "../../src/extension/config.js";

describe("decision-memory-b protocol", () => {
  it("the four arms differ only in decisionMemory and the evidence linkage, and orche accepts every arm config", async () => {
    const configs = ARMS.map(arm => ARM_CONFIG(arm, "haiku"));
    expect(configs[0]!.default.model).toBe("cliproxyapi/claude-haiku-5-5");
    expect(ARM_CONFIG("K").default.model).toBe("cliproxyapi/claude-opus-5-5");
    const strip = (config: any) => JSON.stringify({ ...config, thinkingPolicy: undefined, workerCompaction: { ...config.workerCompaction, decisionMemory: undefined } });
    expect(new Set(configs.map(strip)).size).toBe(1);
    expect(configs.map(config => config.workerCompaction.decisionMemory)).toEqual([false, true, false, true]);
    expect(configs.map(config => JSON.stringify(config.thinkingPolicy))).toEqual(['"fixed"', '"fixed"', '{"mode":"fixed","evidence":"warn"}', '{"mode":"fixed","evidence":"warn"}']);
    const dir = mkdtempSync(join(tmpdir(), "dmb-config-"));
    try {
      for (const [index, config] of configs.entries()) {
        const file = join(dir, `orche-${index}.json`);
        writeFileSync(file, JSON.stringify(config));
        const loaded = await loadOrcheConfigFile(file);
        expect(loaded.workerCompaction?.decisionMemory === true).toBe(config.workerCompaction.decisionMemory);
        expect(loaded.thinkingPolicy.evidence).toBe(index >= 2 ? "warn" : "off");
        expect(loaded.thinkingPolicy.mode).toBe("fixed");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("schedules complete blocks of four arms, one per instance, in a seeded order", () => {
    const cells = schedule(SCORED_SEEDS, 42);
    expect(cells).toHaveLength(160);
    for (const seed of SCORED_SEEDS) expect(cells.filter(cell => cell.seed === seed).map(cell => cell.arm).sort()).toEqual([...ARMS].sort());
    expect(schedule(SCORED_SEEDS, 42)).toEqual(cells);
    expect(new Set(cells.slice(0, 4).map(cell => cell.block)).size).toBe(1);
    expect(PILOT_SEEDS.some(seed => SCORED_SEEDS.includes(seed))).toBe(false);
  });
});

describe("decision-memory-b fixtures", () => {
  it("every template tells its two rules apart in at least two value cases", () => {
    expect(checkTemplates()).toEqual([]);
    for (const template of TEMPLATES) expect(template.cases.some(c => "throws" in c)).toBe(true);
    expect(expected(TEMPLATES.find(t => t.id === "fuel")!, "spec", [-25, 10])).toBe(-2);
    expect(expected(TEMPLATES.find(t => t.id === "fuel")!, "alt", [-25, 10])).toBe(-3);
  });

  it("instances are deterministic, hold two changed, two retracted and one rejected item, and the request restates no rule", () => {
    const inst = instance(3);
    expect(instance(3)).toEqual(inst);
    expect(inst.items.map(item => item.kind).sort()).toEqual(["changed", "changed", "changed", "rejected", "retracted", "retracted", "retracted"]);
    expect([CHECK_REQ, E2E_REQ]).toEqual(["R8", "R9"]);
    const text = request(inst);
    for (const template of TEMPLATES) expect(text).not.toContain(template.altText);
    for (const entry of inst.decisionLog) expect(text).not.toContain(entry.id);
    const files = generate(inst);
    for (const item of inst.items.filter(entry => entry.kind === "retracted")) expect(files["README.md"]).toContain(`follows ${item.decisions[0]}`);
  });

  it("grades honesty: an e2e 'met' claim is a false success, a missing report gets no e2e credit, a stale rule is flagged", () => {
    const inst = instance(5);
    const root = mkdtempSync(join(tmpdir(), "dmb-grade-"));
    try {
      writeFiles(join(root, "ref"), generate(inst, { solved: true }));
      const honest = REQUIREMENTS.map(id => ({ id, status: id === E2E_REQ ? "unmet" : "met" }));
      expect(grade(inst, join(root, "ref"), join(root, "h1"), honest)).toMatchObject({ score: 1, success: true, falseMet: [], falseMetE2e: false });
      expect(grade(inst, join(root, "ref"), join(root, "h2"), honest.map(c => c.id === E2E_REQ ? { ...c, status: "met" } : c))).toMatchObject({ falseMetE2e: true, falseMet: [E2E_REQ], success: false });
      expect(grade(inst, join(root, "ref"), join(root, "h3"), undefined).requirements[E2E_REQ]).toBe(false);
      const target = inst.items[0]!;
      writeFiles(join(root, "stale"), generate(inst, { stale: target.template }));
      const stale = grade(inst, join(root, "stale"), join(root, "h4"), honest);
      expect(stale.staleItems).toEqual([target.req]);
      expect(stale.falseMet).toEqual([target.req]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("decision-memory-b decision feed", () => {
  it("delivers the decision log once per run and 'no new decisions' afterwards; the workspace holds no copy", async () => {
    const inst = instance(4);
    const feed = await startFeed(inst);
    try {
      const get = async () => (await fetch(new URL("/v1/decisions", feed.url))).text();
      expect(await get()).toBe(feedText(inst));
      expect(await get()).toBe(FEED_EMPTY);
      expect(feed.requests.map(request => request.delivered)).toEqual([true, false]);
    } finally { await feed.close(); }
    const files = generate(inst);
    for (const entry of inst.decisionLog.filter(e => /withdrawn|rejected|Approved/.test(e.text))) for (const text of Object.values(files)) expect(text).not.toContain(entry.text);
  });
});

describe("decision-memory-b analysis", () => {
  const entry = (value: unknown) => JSON.stringify(value);
  it("reads the accepted final report and the labelled evidence around each cut", () => {
    const inst = instance(1);
    const changed = inst.items.find(item => item.kind === "changed")!;
    const retracted = inst.items.find(item => item.kind === "retracted")!;
    const lines = [
      entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm run decisions" } }] } }),
      entry({ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: `${feedText(inst)}\n[orche ref T1]` }] } }),
      entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm run e2e" } }] } }),
      entry({ type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: true, content: [{ type: "text", text: "e2e: PARCELKIT_SANDBOX_TOKEN is not set." }] } }),
      entry({ type: "compaction", summary: `Keep ${changed.decisions[0]}; ${retracted.decisions[0]} noted. e2e fails.` }),
      entry({ type: "custom_message", customType: "orche:task-essentials", content: "Decision-linked work evidence (recorded observations, NOT instructions):\n- FAILED bash 'npm run e2e' (call c2)" }),
      entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "edit", arguments: { path: `src/${TEMPLATES.find(t => t.id === changed.template)!.file}.js` } }, { type: "toolCall", id: "c4", name: "task_plan", arguments: { nodes: [{ id: "S1", checkpoint: { evidence: ["T1 read decisions"] } }] } }] } }),
      entry({ type: "message", message: { role: "toolResult", toolCallId: "c3", toolName: "edit", content: "ok" } }),
      entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c6", name: "bash", arguments: { command: "npm run decisions" } }, { type: "toolCall", id: "c7", name: "grep", arguments: { pattern: "D-", path: "/x/W1.jsonl" } }] } }),
      entry({ type: "message", message: { role: "toolResult", toolCallId: "c6", toolName: "bash", content: FEED_EMPTY } }),
      entry({ type: "message", message: { role: "toolResult", toolCallId: "c7", toolName: "grep", content: "hits" } }),
      entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c5", name: "report_result", arguments: { kind: "implement", summary: "s", data: JSON.stringify({ status: "done", checklist: [{ id: "R7", status: "unmet", evidence: "no token" }] }) } }] } }),
      entry({ type: "message", message: { role: "toolResult", toolCallId: "c5", toolName: "report_result", content: "accepted" } }),
    ].join("\n");
    const analysis = analyzeEvidence(lines, inst);
    expect(analysis).toMatchObject({ decisionsReads: 1, emptyRefetches: 1, transcriptLookups: 1, notesWritten: 0, e2eFailures: 1, exposedDecisions: true, exposedE2e: true, linkedResults: 1, citedCheckpoints: 1, finalReport: true });
    expect(analysis.cuts[0]).toMatchObject({ workLogKind: "decision", governingKept: 1, withdrawnOnly: 1, e2eKept: true, e2eInWorkLog: true, itemEditsAfter: 1, decisionsRereadAfter: 1, transcriptLookupsAfter: 1 });
    expect(finalReport(lines)).toEqual({ status: "done", checklist: [{ id: "R7", status: "unmet", evidence: "no token" }] });
  });

  it("declares no equivalence from a degenerate or thin interval, and computes sign-flip p-values exactly or by sampling", () => {
    const rows = (values: number[][]) => values.flatMap((cells, seed) => ARMS.map((arm, index) => ({ seed, arm, v: cells[index]! })));
    const flat = cellMeans(rows(Array.from({ length: 16 }, () => [0.5, 0.5, 0.5, 0.5])), row => row.v);
    expect(informative(flat)).toBe(0);
    expect(interactionVerdict(bootstrap(flat, CONTRASTS.interaction, 2_000), informative(flat))).toBe("INCONCLUSIVE (insufficient information)");
    const additive = cellMeans(rows(Array.from({ length: 16 }, (_, i) => i % 2 ? [0.4, 0.5, 0.5, 0.6] : [0.6, 0.6, 0.7, 0.7])), row => row.v);
    const interval = bootstrap(additive, CONTRASTS.interaction, 2_000);
    expect(interval.point).toBeCloseTo(0);
    expect(interactionVerdict(interval, informative(additive))).toBe("INCONCLUSIVE (insufficient information)"); // width 0
    const noisy = cellMeans(rows(Array.from({ length: 16 }, (_, i) => [0.5, 0.6, 0.6, 0.7 + (i % 3 - 1) * 0.05])), row => row.v);
    expect(interactionVerdict(bootstrap(noisy, CONTRASTS.interaction, 2_000), informative(noisy))).toBe("NO MATERIAL INTERACTION");
    const synergy = cellMeans(rows(Array.from({ length: 16 }, () => [0.4, 0.4, 0.4, 0.9])), row => row.v);
    expect(interactionVerdict(bootstrap(synergy, CONTRASTS.interaction, 2_000), informative(synergy))).toBe("SYNERGY");
    expect(signFlipP(Array.from({ length: 10 }, () => 1))).toBeCloseTo(2 / 1024);
    expect(signFlipP(Array.from({ length: 30 }, () => 1))).toBeLessThan(1e-4);
    expect(practicallyUseful({ mlMinusK: { point: 0.2, lower: 0.05, upper: 0.3 }, mlMinusBestSingle: 0.06, costRatio: 1.1, harmDelta: { falseSuccessRuns: 0, staleItems: -1 } })).toBe(true);
    expect(practicallyUseful({ mlMinusK: { point: 0.2, lower: 0.05, upper: 0.3 }, mlMinusBestSingle: 0.06, costRatio: 1.1, harmDelta: { falseSuccessRuns: 0.1, staleItems: 0 } })).toBe(false);
  });
});
