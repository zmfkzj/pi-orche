import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage as reply, fauxProvider, fauxThinking as thinking, fauxToolCall as call,
  InMemoryCredentialStore, type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";

/**
 * Reproductions of the two thinking-level defects of the first output-limit recovery (found by code review, docs/thinking-policy.md):
 * 1. its step-down picked the next name in a fixed list, so on a model without that level Pi clamped it back UP (no step-down at all);
 * 2. the level it saved to restore was re-applied at the next assignment start, over the new assignment's own level.
 * Real stack: AgentManager, orche's session factory, Pi's AgentSession and a faux provider whose model lacks `xhigh`.
 */
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const capped = () => reply([thinking("t".repeat(32_000 * 4))], { stopReason: "length" });
const report = () => reply([call("report_result", { kind: "answer", summary: "ok", data: { evidence: ["notes"] } })], { stopReason: "toolUse" });

async function fixture(levels: Record<string, string | null>, script: (requests: string[]) => FauxResponseFactory) {
  const dir = await mkdtemp(join(tmpdir(), "orche-thinking-"));
  const faux = fauxProvider({ provider: `thinking-${Math.random().toString(36).slice(2, 8)}`, models: [{ id: "m", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 }] });
  // The faux provider drops `thinkingLevelMap` from its definitions: set it on the (shared) model object before registration.
  Object.assign(faux.getModel(), { thinkingLevelMap: levels });
  const requests: string[] = [];
  const factory = script(requests);
  faux.setResponses(Array.from({ length: 40 }, () => ((context, options, state, model) => { requests.push(options?.reasoning ?? "off"); return factory(context, options, state, model); }) as FauxResponseFactory));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const manager = new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas });
  cleanup.push(async () => { await manager.disposeWithin(2_000).catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
  return { dir, manager, requests, model: `${faux.provider.id}/m` };
}

describe("thinking level step-down follows the model's supported levels", () => {
  it("the last length recovery really lowers max to high on a model without xhigh (it used to be clamped back to max)", async () => {
    let calls = 0;
    const { manager, requests, model, dir } = await fixture({ xhigh: null, max: "max" }, () => () => ++calls <= 2 ? capped() : report());
    await manager.spawn({ id: "W1", role: "analyst", cwd: dir, route: { role: "analyst", model, thinking: "max" }, instructions: "worker", peerMessaging: false });
    manager.assign("W1", "answer", "Assignment: answer. What is in notes?");
    const waited = await manager.wait("W1", 10_000);
    expect(waited.type).toBe("outcome");
    // Request 1 at max (overrun), request 2 still max (first recovery), request 3 one supported level lower: high, not "xhigh"→max.
    expect(requests).toEqual(["max", "max", "high"]);
    // Delivered output restores the level.
    expect(manager.session("W1").thinkingLevel).toBe("max");
  });
});

describe("an assignment's own thinking level is never overwritten by an earlier assignment's restore", () => {
  it("a level set for the next assignment survives the length-recovery reset at assign", async () => {
    let calls = 0;
    // First assignment: every response overruns (the recovery steps down and the assignment fails with the level still lowered).
    const { manager, model, dir, requests } = await fixture({}, () => () => ++calls <= 4 ? capped() : report());
    await manager.spawn({ id: "W1", role: "analyst", cwd: dir, route: { role: "analyst", model, thinking: "high" }, instructions: "worker", peerMessaging: false });
    manager.assign("W1", "answer", "Assignment: answer. First.");
    const first = await manager.wait("W1", 10_000);
    expect(first.type === "outcome" && first.outcome.status).toBe("failed");
    // The owner chooses the next assignment's level (as WorkerPool does for a new main thinking level), then assigns.
    manager.session("W1").setThinkingLevel("low");
    manager.assign("W1", "answer", "Assignment: answer. Second.");
    const second = await manager.wait("W1", 10_000);
    expect(second.type === "outcome" && second.outcome.status).toBe("completed");
    expect(requests.at(-1)).toBe("low");
    expect(manager.session("W1").thinkingLevel).toBe("low");
  });
});
