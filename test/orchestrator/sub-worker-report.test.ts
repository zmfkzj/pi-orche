import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createSubWorkerRunner } from "../../src/orchestrator/sub-worker.js";
import type { PlannedWorker } from "../../src/orchestrator/spawn.js";
import { reportData, reportDataHint } from "../../src/orchestration/result-schemas.js";
import { Type } from "typebox";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * report_result of an orche_spawn sub-worker through the real runner (faux model). Regression: in it-0146 every reviewer
 * sub-worker sent `data` as a JSON string of the object and was rejected with `Invalid data: /: must be object` on every retry,
 * while the same string was parsed for orche_task workers.
 */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const report = (args: Record<string, unknown>) => reply([call("report_result", args as never)], { stopReason: "toolUse" });

async function run(role: PlannedWorker["role"], steps: FauxResponseStep[], extra: Partial<PlannedWorker> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "orche-subreport-"));
  roots.push(cwd);
  const seen: string[] = [];
  const recorded = steps.map((step, index): FauxResponseStep => async (context, options, state, model) => {
    // What the sub-worker saw back from its previous call (the rejection text), for each later step.
    if (index > 0) seen.push(JSON.stringify(context.messages.at(-1)));
    return typeof step === "function" ? step(context, options, state, model) : step;
  });
  const faux = await fauxRuntime(recorded);
  const runner = createSubWorkerRunner({
    orchestrator: "W1", cwd, runtime: faux.runtime, route: faux.route, routeSource: "orchestrator", thinkingSource: "orchestrator",
    specialistRoute: () => faux.route, prompt: worker => worker.request, timeoutMs: 30_000, maxTurns: 6,
  });
  const worker: PlannedWorker = { id: "W1.1", name: "w", role, request: "Review it", reason: "verification", ...extra };
  const outcome = await runner(worker, [worker], new AbortController().signal, () => undefined);
  return { outcome, seen };
}

const verdict = { passed: false, evidence: ["read protocol.md 1-30"], issues: [{ severity: "major", text: "(d) turns off" }] };

describe("orche_spawn sub-worker report_result data", () => {
  it("accepts a verify report whose data arrives as a JSON string (the it-0146 failure) and keeps the parsed object", async () => {
    const { outcome, seen } = await run("verify", [report({ kind: "verify", summary: "issues found", data: JSON.stringify(verdict, null, 2) })]);
    expect(seen).toEqual([]);
    expect(outcome).toMatchObject({ status: "not passed", summary: "issues found", data: verdict, requests: 1 });
  });
  it("still accepts data sent as an object", async () => {
    const { outcome } = await run("verify", [report({ kind: "verify", summary: "ok", data: { passed: true } })]);
    expect(outcome).toMatchObject({ status: "passed", data: { passed: true } });
  });
  it("parses a JSON-string data for implement too (optional contract)", async () => {
    const { outcome } = await run("implement", [report({ kind: "implement", summary: "done", data: JSON.stringify({ status: "blocked", reason: "x" }) })], { files: ["a.ts"], reason: "parallelism" });
    expect(outcome).toMatchObject({ status: "blocked", data: { status: "blocked", reason: "x" } });
  });
  it("a JSON string that breaks the contract is rejected at the problem's path, not at '/'", async () => {
    const { outcome, seen } = await run("verify", [
      report({ kind: "verify", summary: "probe", data: JSON.stringify({ passed: "x" }) }),
      report({ kind: "verify", summary: "fixed", data: JSON.stringify({ passed: true }) }),
    ]);
    expect(seen[0]).toContain("Invalid data: /passed");
    expect(seen[0]).not.toContain("/: must be object");
    expect(outcome).toMatchObject({ status: "passed", summary: "fixed", data: { passed: true } });
  });
  it("missing, null, non-JSON, malformed and array data are still rejected for a required object contract, with what to fix", async () => {
    const { outcome, seen } = await run("verify", [
      report({ kind: "verify", summary: "no data" }),
      report({ kind: "verify", summary: "null", data: null }),
      report({ kind: "verify", summary: "broken", data: "{\"passed\": false," }),
      report({ kind: "verify", summary: "plain text", data: "passed" }),
      report({ kind: "verify", summary: "string array", data: "[true]" }),
      report({ kind: "verify", summary: "ok", data: "{\"passed\": false}" }),
    ]);
    expect(seen[0]).toContain("data is missing");
    expect(seen[1]).toContain("data is null");
    expect(seen[2]).toMatch(/Invalid data: \/: must be object.*arrived as a string that is not valid JSON of an object/);
    expect(seen[3]).toContain("arrived as a string");
    expect(seen[4]).toContain("Invalid data: /: must be object");
    expect(seen[4]).not.toContain("arrived as a string");
    expect(seen).toHaveLength(5);
    expect(outcome).toMatchObject({ status: "not passed", summary: "ok", data: { passed: false } });
  });
  it("optional contracts still accept omitted or null data", async () => {
    for (const data of [undefined, null]) {
      const { outcome, seen } = await run("answer", [report({ kind: "answer", summary: "a", ...(data === undefined ? {} : { data }) })], { reason: "search" });
      expect(seen).toEqual([]);
      expect(outcome).toMatchObject({ status: "done", summary: "a" });
    }
  });
  it("an extra contract (MDSD search fields) checks the parsed data", async () => {
    const check = (data: unknown) => (data as { cells?: unknown } | undefined)?.cells === 3 ? undefined : "Invalid data.cells: expected 3.";
    const { outcome, seen } = await run("answer", [
      report({ kind: "answer", summary: "x", data: JSON.stringify({ cells: 2 }) }),
      report({ kind: "answer", summary: "y", data: JSON.stringify({ cells: 3 }) }),
    ], { check, reason: "search" });
    expect(seen[0]).toContain("Invalid data.cells: expected 3.");
    expect(outcome).toMatchObject({ status: "done", summary: "y", data: { cells: 3 } });
  });
});

describe("reportData / reportDataHint", () => {
  it("parses JSON object and array strings only; everything else is unchanged", () => {
    expect(reportData(" \n{\"a\":1}")).toEqual({ a: 1 });
    expect(reportData("[1]")).toEqual([1]);
    expect(reportData("{bad")).toBe("{bad");
    expect(reportData("true")).toBe("true");
    expect(reportData("\"{}\"")).toBe("\"{}\"");
    const object = { a: 1 };
    expect(reportData(object)).toBe(object);
    expect(reportData(undefined)).toBeUndefined();
    expect(reportData(null)).toBeNull();
  });
  it("hints for missing or null data, and for a string only where the contract wants an object or array", () => {
    const object = Type.Object({ a: Type.String() }), list = Type.Array(Type.String()), text = Type.String({ minLength: 3 });
    expect(reportDataHint(undefined, object)).toContain("missing");
    expect(reportDataHint(null, object)).toContain("null");
    expect(reportDataHint("x", object)).toContain("send data as a JSON object");
    expect(reportDataHint("x", list)).toContain("send data as a JSON array");
    expect(reportDataHint("x", text)).toBe("");
    expect(reportDataHint({}, object)).toBe("");
    expect(reportDataHint([], object)).toBe("");
  });
});
