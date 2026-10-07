import { describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { InheritedProviders } from "../../src/pi/inherit-providers.js";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";
import { createHarness, tool } from "../extension/harness.js";

// No network, no real credentials: the faux stream stands in for a host's OAuth request wrapper.
describe("host provider inheritance", () => {
  it("preserves an Anthropic stream override for SDK turns and compaction, not just model metadata", async () => {
    const host = await fauxRuntime([reply("First answer"), reply("Second answer"), reply("Summary"), reply("Turn prefix summary")]);
    const child = await fauxRuntime();
    const stream = vi.fn(host.faux.provider.streamSimple.bind(host.faux.provider));
    host.runtime.registerProvider("anthropic", { api: "anthropic-messages", apiKey: "test-only", streamSimple: stream });
    const registry = new ModelRegistry(host.runtime);
    const inherited = new InheritedProviders();
    inherited.sync(child.runtime, registry);
    const model = child.runtime.getModels("anthropic")[0]!;
    expect(model).toBeDefined();
    const session = await createSession({ cwd: process.cwd(), route: { role: "test", model: `anthropic/${model.id}` }, tools: [], instructions: "Answer briefly.", modelRuntime: child.runtime });
    try {
      await session.prompt("First question");
      await session.prompt("Second question");
      expect(session.getLastAssistantText()).toBe("Second answer");
      expect(stream).toHaveBeenCalledTimes(2);
      session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
      await session.compact();
      expect(stream.mock.calls.length).toBeGreaterThan(2);
      expect(child.faux.state.callCount).toBe(0);
    } finally { session.dispose(); }
  });

  it("inherits native providers without reloading extensions and skips unchanged registrations", async () => {
    const host = await fauxRuntime([reply("native")]);
    const child = await fauxRuntime();
    const registry = new ModelRegistry(host.runtime);
    const inherited = new InheritedProviders();
    const register = vi.spyOn(child.runtime, "registerNativeProvider");
    inherited.sync(child.runtime, registry);
    inherited.sync(child.runtime, registry);
    expect(register).toHaveBeenCalledTimes(1);
    const model = child.runtime.getModel(host.faux.provider.id, host.faux.getModel().id)!;
    expect((await child.runtime.completeSimple(model, { messages: [] })).content).toEqual(expect.arrayContaining([expect.objectContaining({ text: "native" })]));
    expect(child.faux.state.callCount).toBe(0);
  });

  it("updates and removes its own copies without retaining old merged fields", async () => {
    const host = await fauxRuntime();
    const child = await fauxRuntime();
    const registry = new ModelRegistry(host.runtime);
    const inherited = new InheritedProviders();
    host.runtime.registerProvider("anthropic", { api: "anthropic-messages", apiKey: "test-only", streamSimple: host.faux.provider.streamSimple });
    inherited.sync(child.runtime, registry);
    host.runtime.unregisterProvider("anthropic");
    host.runtime.registerProvider("anthropic", { apiKey: "replacement" });
    inherited.sync(child.runtime, registry);
    expect(child.runtime.getRegisteredProviderConfig("anthropic")).toEqual({ apiKey: "replacement" });
    host.runtime.unregisterProvider("anthropic");
    inherited.sync(child.runtime, registry);
    expect(child.runtime.getRegisteredProviderConfig("anthropic")).toBeUndefined();
    expect(child.runtime.getModels("anthropic").length).toBeGreaterThan(0);
  });

  it("leaves explicit worker providers and the host runtime untouched", async () => {
    const host = await fauxRuntime();
    const child = await fauxRuntime();
    const registry = new ModelRegistry(host.runtime);
    const inherited = new InheritedProviders();
    host.runtime.registerProvider("anthropic", { apiKey: "host" });
    child.runtime.registerProvider("anthropic", { apiKey: "worker" });
    inherited.sync(child.runtime, registry);
    expect(child.runtime.getRegisteredProviderConfig("anthropic")?.apiKey).toBe("worker");
    // A providerExtensions package replaces a previously inherited native provider.
    child.runtime.registerProvider(host.faux.provider.id, { apiKey: "worker-override", models: [] });
    host.runtime.unregisterProvider(host.faux.provider.id);
    inherited.sync(child.runtime, registry);
    expect(child.runtime.getRegisteredProviderConfig(host.faux.provider.id)?.apiKey).toBe("worker-override");
    expect(host.runtime.getRegisteredProviderConfig("anthropic")?.apiKey).toBe("host");
    const register = vi.spyOn(host.runtime, "registerProvider");
    new InheritedProviders().sync(host.runtime, registry); // SDK caller already shares the runtime
    expect(register).not.toHaveBeenCalled();
  });

  it("wires main → orche_task → orche_spawn through inherited providers on a separate runtime", async () => {
    const h = await createHarness({
      extension: { inheritProviders: true },
      mainSteps: [
        tool("orche_task", { role: "answer", request: "Explain the greeting using an isolated reader." }),
        tool("orche_spawn", { reason: "isolation", workers: [{ name: "reader", role: "answer", request: "Read-only answer", files: [] }] }),
        tool("report_result", { kind: "answer", summary: "Child answer", data: { evidence: ["greeting.txt"] } }),
        tool("report_result", { kind: "answer", summary: "Orchestrator answer", data: { split: { decision: "split", criteria: ["isolation"], reason: "Isolated reader" } } }),
        reply("Main finished"),
      ],
      orcheSteps: [],
    });
    try {
      expect(h.orche.runtime.getModel(h.main.faux.provider.id, h.main.faux.getModel().id)).toBeUndefined();
      await h.session.prompt("Answer through orche");
      const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "orche_task");
      expect(result).toMatchObject({ isError: false, details: { worker: "W1", spawned: [expect.objectContaining({ id: "W1.1", status: "done" })] } });
      expect(h.session.getLastAssistantText()).toBe("Main finished");
      expect(h.main.faux.state.callCount).toBe(5);
      expect(h.orche.faux.state.callCount).toBe(0);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await h.dispose();
    }
  });
});
