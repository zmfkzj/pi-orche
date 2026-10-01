import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { EXTENDED_CONTEXT_WINDOWS, withExtendedContext } from "../../src/pi/extended-context.js";
import { createSession } from "../../src/pi/session-factory.js";
import { parseRouteConfig, resolveRoute } from "../../src/orchestration/routing.js";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { fauxRuntime } from "../helpers/faux.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** A faux provider exposing models with the ids of the curated table plus ones outside it. */
async function runtimeWithGptModels() {
  const f = await fauxRuntime();
  const gpt = fauxProvider({
    provider: "gateway",
    models: [
      { id: "gpt-6.1-sol", contextWindow: 272_000 },
      { id: "gpt-6-luna", contextWindow: 272_000 },
      { id: "gpt-6-astra", contextWindow: 1_000_000 },
    ],
  });
  f.runtime.registerNativeProvider(gpt.provider);
  return { ...f, gpt };
}

describe("extendedContext configuration", () => {
  it("parses per-route and top-level values with precedence route > default > top-level", () => {
    const config = parseRouteConfig({
      extendedContext: true,
      default: { model: "gateway/gpt-6.1-sol" },
      routes: {
        a: { model: "gateway/gpt-6.1-sol", extendedContext: false },
        b: { model: "gateway/gpt-6.1-sol", extendedContext: true },
      },
    });
    expect(resolveRoute(config, "a").extendedContext).toBe(false);
    expect(resolveRoute(config, "b").extendedContext).toBe(true);
    expect(resolveRoute(config, "unlisted").extendedContext).toBe(true); // falls to the top-level default
    const perDefault = parseRouteConfig({ default: { model: "p/m", extendedContext: true }, routes: {} });
    expect(resolveRoute(perDefault, "x").extendedContext).toBe(true);
    expect(resolveRoute(parseRouteConfig({ default: { model: "p/m" }, routes: {} }), "x")).toEqual({ role: "x", model: "p/m" });
  });

  it("rejects non-boolean values with located errors", () => {
    expect(() => parseRouteConfig({ routes: {}, extendedContext: "yes" })).toThrow("config.extendedContext: expected boolean");
    expect(() => parseRouteConfig({ routes: { coordinator: { model: "p/m", extendedContext: 1 } } })).toThrow("config.routes.coordinator.extendedContext: expected boolean");
  });
});

describe("extended context application", () => {
  it("raises only table models, only when enabled, and never lowers a window", async () => {
    const f = await runtimeWithGptModels();
    const sol = f.runtime.getModel("gateway", "gpt-6.1-sol")!;
    const luna = f.runtime.getModel("gateway", "gpt-6-luna")!;
    const astra = f.runtime.getModel("gateway", "gpt-6-astra")!;
    expect(withExtendedContext(sol, true).info).toEqual({ model: "gateway/gpt-6.1-sol", contextWindow: 922_000, advertisedContextWindow: 272_000, extended: true });
    expect(withExtendedContext(sol, true).model.contextWindow).toBe(922_000);
    expect(sol.contextWindow).toBe(272_000); // the catalog entry is copied, not mutated
    expect(withExtendedContext(sol, false).model).toBe(sol);
    expect(withExtendedContext(sol, undefined).info.extended).toBe(false);
    expect(withExtendedContext(luna, true).info).toMatchObject({ contextWindow: 272_000, extended: false }); // no curated maximum
    expect(withExtendedContext(astra, true).model.contextWindow).toBe(1_000_000); // already larger: kept
    expect(Object.keys(EXTENDED_CONTEXT_WINDOWS)).not.toContain("gpt-6-luna");
  });

  it("sessions use the raised window, including the output-token clamp input, and report it", async () => {
    const f = await runtimeWithGptModels();
    const reports: unknown[] = [];
    const session = await createSession({
      route: { role: "implementer", model: "gateway/gpt-6.1-sol", extendedContext: true },
      cwd: process.cwd(), modelRuntime: f.runtime, instructions: "x", tools: [], onContextWindow: info => reports.push(info),
    });
    try {
      expect(session.model?.contextWindow).toBe(922_000);
      expect(reports).toEqual([{ model: "gateway/gpt-6.1-sol", contextWindow: 922_000, advertisedContextWindow: 272_000, extended: true }]);
    } finally {
      session.dispose();
    }
    const plain = await createSession({ route: { role: "r", model: "gateway/gpt-6.1-sol" }, cwd: process.cwd(), modelRuntime: f.runtime, instructions: "x", tools: [] });
    try {
      expect(plain.model?.contextWindow).toBe(272_000);
    } finally {
      plain.dispose();
    }
  });

  it("a run records the effective window per actor: coordinator, workers and advisors", async () => {
    const f = await runtimeWithGptModels();
    const dir = await mkdtemp(join(tmpdir(), "orche-ctx-"));
    roots.push(dir);
    const events: RunEvent[] = [];
    const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });
    f.gpt.setResponses([
      tool("coordinator_decision", { decision: { type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "q" } }),
      tool("report_result", { kind: "answer", summary: "A", data: { evidence: [] } }),
      tool("advisor_verdict", { verdict: "ok", notes: [] }),
      tool("coordinator_decision", { decision: { type: "answer_from_worker", sourceAgentId: "A1", summary: "done" } }),
    ]);
    const routes = parseRouteConfig({
      extendedContext: true,
      default: { model: "gateway/gpt-6.1-sol" },
      routes: { analyst: { model: "gateway/gpt-6-luna" }, advisor: { model: "gateway/gpt-6-astra", extendedContext: false } },
      advisors: [{ name: "watch", domains: ["correctness"], targets: ["coordinator"], triggers: [{ on: "assignment_result" }] }],
    });
    const report = await runOrchestrated({ problem: "explain", cwd: dir, routes, modelRuntime: f.runtime, sink: event => events.push(event) });
    expect(report.status).toBe("done");
    const windows = Object.fromEntries(events.flatMap(event => event.type === "context_window" ? [[event.actor, [event.model, event.contextWindow, event.extended]]] : []));
    expect(windows).toEqual({
      coordinator: ["gateway/gpt-6.1-sol", 922_000, true],
      A1: ["gateway/gpt-6-luna", 272_000, false], // analyst route: luna has no curated maximum
      "advisor:watch": ["gateway/gpt-6-astra", 1_000_000, false], // route says extendedContext:false
    });
  });
});
