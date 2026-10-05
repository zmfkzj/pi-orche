import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { createHarness, tool } from "./harness.js";
import { replayLedgerEvents, type LedgerEvent } from "../../src/single/ledger.js";
import { delegationRules } from "../../src/extension/mode.js";

const opened: { dispose(): Promise<void> }[] = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); });

const REQUEST = "Intent/Purpose: value must be two.\nConstraints and non-goals: none.\nOriginal request\nMake value 2.";
const frame = {
  goal: "value is 2",
  requirements: [
    { id: "R1", kind: "explicit", text: "src/value.mjs exports value 2", acceptance: "import value → 2", quote: "Make value 2" },
    { id: "R2", kind: "edge", text: "value is a number, not a string", acceptance: "typeof value → 'number'" },
  ],
  ambiguities: [{ id: "A1", quote: "value 2", readings: ["the number 2", "the string \"2\""], observableDifference: "typeof value", recommended: 1, why: "a value of 2 is a number in the existing code", askUser: false, affects: ["R1", "R2"] }],
  invariants: ["no other export changes"],
  locations: [{ path: "src/value.mjs:1", why: "the export" }],
};
const checklist = [{ id: "R1", status: "met", evidence: "src/value.mjs:1", verifiedBy: "node --test" }, { id: "R2", status: "met", evidence: "src/value.mjs:1", verifiedBy: "node --test" }];
const write = (path: string, content: string) => tool("write", { path, content });
const report = (summary: string, extra: Record<string, unknown> = {}) => tool("report_result", { kind: "implement", summary, data: { status: "done", checklist, ...extra } });
const PROBE = "node .orche/scratch/T1/value.probe.mjs";
const failingCheck = {
  verdict: "fail", trace: [{ id: "R1", status: "missing", evidence: "probe exits 1" }, { id: "R2", status: "covered", evidence: "typeof checked" }],
  findings: [{ id: "F1", severity: "blocking", kind: "executed", requirement: "R1", claim: "value is 1, not 2", evidence: "probe exits 1", probe: PROBE }],
  checks: [],
};

async function fixture(steps: FauxResponseStep[], single: Record<string, unknown>) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, single: single as never });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await mkdir(join(h.cwd, "src"), { recursive: true });
  await writeFile(join(h.cwd, "src", "value.mjs"), "export const value = 0;\n");
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const saved: LedgerEvent[] = [];
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, onLedgerEvent: event => saved.push(event) });
  opened.push(pool);
  const run = () => pool.execute({ role: "implement", request: REQUEST, cwd: h.cwd, projectTrusted: false, mainMode: "single" });
  return { h, pool, saved, run };
}

describe("single pipeline v2", () => {
  it("frames the assignment, verifies the result, sends blocking findings back to the same worker and re-runs the probe itself", async () => {
    const prompts: string[] = [];
    const navResults: string[] = [];
    const nav = (args: Record<string, unknown>) => tool("code_nav", args as never);
    const afterNav = (step: FauxResponseStep): FauxResponseStep => (context, ...rest) => {
      navResults.push(JSON.stringify(context.messages.at(-1)));
      return typeof step === "function" ? step(context, ...rest) : step;
    };
    const capture = (step: FauxResponseStep): FauxResponseStep => (context, ...rest) => {
      prompts.push(JSON.stringify(context.messages.filter(message => message.role === "user").at(-1)));
      return typeof step === "function" ? step(context, ...rest) : step;
    };
    const { h, saved, run } = await fixture([
      capture(nav({ op: "symbols", file: "src/value.mjs" })), afterNav(tool("report_frame", frame as never)),
      capture(write("src/value.mjs", "export const value = 1;\n")), report("value set"),
      capture(nav({ op: "def", symbol: "value" })), afterNav(write(".orche/scratch/T1/value.probe.mjs", "import { value } from '../../../src/value.mjs';\nprocess.exit(value === 2 ? 0 : 1);\n")), tool("report_check", failingCheck),
      capture(write("src/value.mjs", "export const value = 2;\n")), report("value is 2 now (whole change)"),
    ], { pipeline: "v2", checker: { gate: "always" } });
    const result = await run();
    // code_nav works for the Framer and the Verifier (single.nav defaults on with v2).
    expect(navResults[0]).toContain("code_nav symbols src/value.mjs (semantic");
    expect(navResults[1]).toContain("code_nav def value (semantic");
    // The worker got the contract first, then the main session's request.
    expect(prompts[1]).toContain("## Task contract (from orche's Framer");
    expect(prompts[1]).toContain("R2: [edge] value is a number, not a string");
    expect(prompts[1]).toContain('A1 \\"value 2\\": chosen \\"the number 2\\"');
    expect(prompts[1]).toContain("## Request from the main session (verbatim)");
    // The Verifier saw the hand-off, the claims and the diff file; the fix round got only the blocking finding.
    expect(prompts[2]).toContain(".orche/scratch/T1/change-1.diff");
    expect(prompts[2]).toContain("The implementer's claims");
    expect(prompts[3]).toContain("fix round for task T1");
    expect(prompts[3]).toContain(PROBE);
    expect(await readFile(join(h.cwd, ".orche", "scratch", "T1", "change-1.diff"), "utf8")).toContain("+export const value = 1;");
    expect(await readFile(join(h.cwd, ".orche", "scratch", ".gitignore"), "utf8")).toBe("*\n");
    const pipeline = result.details.pipeline!;
    expect(pipeline.frame?.requirements.map(item => item.id)).toEqual(["R1", "R2"]);
    expect(pipeline.risk).toMatchObject({ decision: "verify", reason: "forced: gate always" });
    expect(pipeline.check?.verdict).toBe("fail");
    expect(pipeline.fixRounds).toBe(1);
    expect(pipeline.recheck?.findings).toEqual([{ id: "F1", status: "fixed", detail: "probe exits 0" }]);
    expect(pipeline.specialists.map(stats => stats.actor)).toEqual(["framer:W1", "checker:W1"]);
    expect(result.details.changes).toEqual([{ path: "src/value.mjs", status: "modified" }]);
    expect(result.text).toContain("Frame: 2 requirements (1 explicit, 1 edge), 1 ambiguity settled by the recommended reading.");
    expect(result.text).toContain("Risk ");
    expect(result.text).toContain("- F1 blocking R1 (executed): value is 1, not 2 → fixed: probe exits 0");
    expect(result.text).toContain("Fix rounds: 1 (same worker).");
    expect(result.text).toContain("value is 2 now (whole change)");
    // The ledger has the Framer's reading, both results, the check and the recheck.
    expect(saved.map(event => event.event)).toEqual(["create", "handoff", "check", "result", "recheck", "result"]);
    const ledger = replayLedgerEvents(JSON.parse(JSON.stringify(saved)) as LedgerEvent[]).get("T1")!;
    expect(ledger.decisions).toEqual([{ assignment: 1, id: "A1", quote: "value 2", readings: ["the number 2", "the string \"2\""], chosen: "the number 2", by: "framer" }]);
    expect(ledger.requirements.map(item => [item.id, item.status])).toEqual([["R1", "met"], ["R2", "met"]]);
    expect(ledger.findings).toEqual([{ assignment: 1, id: "F1", severity: "blocking", requirement: "R1", claim: "value is 1, not 2", status: "fixed", probe: PROBE, detail: "probe exits 0" }]);
    expect(ledger.checks?.[0]).toMatchObject({ assignment: 1, decision: "verify", verdict: "fail" });
    expect(ledger.history.map(item => item.summary)).toEqual(["value set", "value is 2 now (whole change)"]);
  });

  it("skips the Verifier below the risk threshold and records the assessment", async () => {
    const { saved, run } = await fixture([
      tool("report_frame", { ...frame, ambiguities: [] } as never),
      write("src/value.mjs", "export const value = 2;\n"), report("value set"),
    ], { pipeline: "v2", checker: { threshold: 30 } });
    const result = await run();
    expect(result.details.pipeline?.risk).toMatchObject({ decision: "skip" });
    expect(result.details.pipeline?.check).toBeUndefined();
    expect(result.details.pipeline?.specialists.map(stats => stats.actor)).toEqual(["framer:W1"]);
    expect(result.text).toContain("→ no verification");
    expect(saved.map(event => event.event)).toEqual(["create", "handoff", "check", "result"]);
  });

  it("keeps working without a contract when the Framer fails, and says so", async () => {
    const { run } = await fixture([
      reply("I will not call the tool."),
      write("src/value.mjs", "export const value = 2;\n"), tool("report_result", { kind: "implement", summary: "value set", data: { status: "done" } }),
    ], { pipeline: "v2", checker: { gate: "off" } });
    const result = await run();
    expect(result.details.pipeline?.frame).toBeUndefined();
    expect(result.text).toContain("Warning: the Framer failed (framer:W1: ended without calling report_frame); the worker got the request without a contract.");
    expect(result.details.pipeline?.risk).toMatchObject({ decision: "skip", reason: "gate off" });
  });

  it("v1 (the default) neither frames nor verifies, and has no code_nav", async () => {
    let navResult = "";
    const { run } = await fixture([
      tool("code_nav", { op: "symbols", file: "src/value.mjs" }),
      context => { navResult = JSON.stringify(context.messages.at(-1)); return write("src/value.mjs", "export const value = 2;\n"); },
      tool("report_result", { kind: "implement", summary: "value set", data: { status: "done" } }),
    ], { ledger: true });
    const result = await run();
    expect(navResult).toContain("toolResult");
    expect(navResult).not.toContain("code_nav symbols src/value.mjs (semantic");
    expect(result.details.pipeline).toBeUndefined();
    expect(result.text).not.toContain("Risk ");
  });

  it("front rules: v2 replaces the hand-off, reuse and supervision rules; v1 keeps them", () => {
    const v1 = delegationRules("single");
    const v2 = delegationRules("single", { pipeline: "v2" });
    expect(v1).toContain("numbered requirements checklist R1..Rn as lines `R1: …`, each testable");
    expect(v1).toContain("run the trusted project checks yourself");
    expect(v2).toContain("Do not write a requirements checklist for implement: orche's Framer");
    expect(v2).not.toContain("run the trusted project checks yourself");
    expect(delegationRules("direct", { pipeline: "v2" })).toBe(delegationRules("direct"));
  });
});
