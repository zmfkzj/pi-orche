import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { OrcheController } from "../../src/extension/controller.js";
import { InheritedProviders } from "../../src/pi/inherit-providers.js";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";
import { createHarness, tool } from "../extension/harness.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function scratch() {
  const path = await mkdtemp(join(tmpdir(), "orche-inherit-"));
  roots.push(path);
  return path;
}

// No network, no real credentials: the faux stream stands in for a host's OAuth request wrapper.
describe("host provider inheritance", () => {
  it("preserves an Anthropic stream override for SDK turns and compaction, not just model metadata", async () => {
    const host = await fauxRuntime([reply("First answer"), reply("Second answer"), reply("Summary"), reply("Turn prefix summary")]);
    const child = await fauxRuntime();
    const stream = vi.fn(host.faux.provider.streamSimple.bind(host.faux.provider));
    host.runtime.registerProvider("anthropic", { api: "anthropic-messages", apiKey: "test-only", streamSimple: stream });
    const registry = new ModelRegistry(host.runtime);
    const inherited = new InheritedProviders();
    const runtime = inherited.sync(child.runtime, registry);
    const model = child.runtime.getModels("anthropic")[0]!;
    expect(model).toBeDefined();
    const session = await createSession({ cwd: process.cwd(), route: { role: "test", model: `anthropic/${model.id}` }, tools: [], instructions: "Answer briefly.", modelRuntime: runtime });
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
    const runtime = inherited.sync(child.runtime, registry);
    const registrations = register.mock.calls.length;
    expect(inherited.sync(child.runtime, registry)).toBe(runtime);
    expect(register.mock.calls.length).toBe(registrations);
    const model = child.runtime.getModel(host.faux.provider.id, host.faux.getModel().id)!;
    expect((await runtime.completeSimple(model, { messages: [] })).content).toEqual(expect.arrayContaining([expect.objectContaining({ text: "native" })]));
    expect(child.faux.state.callCount).toBe(0);
  });

  it("updates and removes its own copies without retaining old merged fields", async () => {
    const host = await fauxRuntime();
    const child = await fauxRuntime();
    const registry = new ModelRegistry(host.runtime);
    const inherited = new InheritedProviders();
    host.runtime.registerProvider("anthropic", { api: "anthropic-messages", apiKey: "test-only", streamSimple: host.faux.provider.streamSimple });
    inherited.sync(child.runtime, registry);
    const original = child.runtime.getRegisteredNativeProvider("anthropic");
    host.runtime.unregisterProvider("anthropic");
    host.runtime.registerProvider("anthropic", { apiKey: "replacement" });
    inherited.sync(child.runtime, registry);
    expect(child.runtime.getProvider("anthropic")?.name).toBe(registry.getProvider("anthropic")?.name);
    expect(child.runtime.getRegisteredNativeProvider("anthropic")).not.toBe(original);
    expect(child.runtime.getRegisteredProviderConfig("anthropic")).toBeUndefined();
    host.runtime.unregisterProvider("anthropic");
    inherited.sync(child.runtime, registry);
    expect(child.runtime.getModel("anthropic", registry.getAll().find(model => model.provider === "anthropic")!.id)).toBeDefined();
    expect(child.runtime.getModels("anthropic").length).toBeGreaterThan(0);
    const id = host.faux.provider.id;
    host.runtime.unregisterProvider(id);
    inherited.sync(child.runtime, registry);
    expect(child.runtime.getProvider(id)).toBeUndefined();
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

  it("dispatches an explicit worker override locally, even after inheriting the same id", async () => {
    const host = await fauxRuntime([reply("host")]);
    const child = await fauxRuntime([reply("worker")]);
    const registry = new ModelRegistry(host.runtime);
    const inherited = new InheritedProviders();
    const runtime = inherited.sync(child.runtime, registry);
    const model = runtime.getModel(host.faux.provider.id, host.faux.getModel().id)!;
    child.runtime.registerNativeProvider({ ...host.faux.provider, streamSimple: child.faux.provider.streamSimple });
    expect(inherited.sync(child.runtime, registry)).toBe(runtime);
    expect((await runtime.completeSimple(model, { messages: [] })).content).toEqual(expect.arrayContaining([expect.objectContaining({ text: "worker" })]));
    expect(host.faux.state.callCount).toBe(0);
    expect(child.faux.state.callCount).toBe(1);
  });


  it("mirrors every Pi builtin and all operation types, not only extension registrations", async () => {
    const host = await fauxRuntime();
    const child = await fauxRuntime();
    const registry = new ModelRegistry(host.runtime);
    const runtime = new InheritedProviders().sync(child.runtime, registry);
    for (const type of ["chat", "image", "classifier"] as const) {
      const models = registry.getModelsOfType(type);
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) expect(runtime.getModelOfType(type, model.provider, model.id)).toEqual(model);
    }
    for (const provider of ["openai", "anthropic", "google", "amazon-bedrock", "google-vertex", "azure", "openrouter"]) {
      expect(runtime.getModels(provider).length).toBeGreaterThan(0);
    }
  });

  it("inherits models.json-only providers and headers from the host's custom config path", async () => {
    const root = await scratch();
    const modelsPath = join(root, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { "local-compatible": {
      baseUrl: "http://localhost:8000/v1", api: "openai-completions", apiKey: "test-only",
      models: [{ id: "local-model", contextWindow: 32000, headers: { "X-Model": "test" } }],
    } } }));
    const host = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath });
    const child = await fauxRuntime();
    const registry = new ModelRegistry(host);
    expect(registry.getRegisteredProviderIds()).not.toContain("local-compatible");
    const runtime = new InheritedProviders().sync(child.runtime, registry);
    expect(runtime.getModel("local-compatible", "local-model")).toEqual(host.getModel("local-compatible", "local-model"));
    expect(await runtime.getAuth("local-compatible")).toMatchObject({ auth: { apiKey: "test-only" } });
  });

  it("resolves runtime-only keys at request time, including rotation and removal, without copying them", async () => {
    const host = await fauxRuntime([reply("first"), reply("rotated")]);
    const child = await fauxRuntime();
    const id = host.faux.provider.id;
    const stream = vi.fn(host.faux.provider.streamSimple.bind(host.faux.provider));
    host.runtime.registerNativeProvider({
      ...host.faux.provider,
      auth: { apiKey: { name: "Runtime-only test", resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "test" } : undefined } },
      streamSimple: stream,
    });
    await host.runtime.setRuntimeApiKey(id, "first-key");
    const registry = new ModelRegistry(host.runtime);
    const runtime = new InheritedProviders().sync(child.runtime, registry);
    const model = runtime.getModel(id, host.faux.getModel().id)!;
    expect(runtime.hasConfiguredAuth(id)).toBe(true);
    expect(await runtime.getAvailable(id)).toEqual([model]);
    await runtime.completeSimple(model, { messages: [] });
    expect(stream.mock.calls[0]?.[2]?.apiKey).toBe("first-key");
    await host.runtime.setRuntimeApiKey(id, "rotated-key"); // no new hand-off
    await runtime.completeSimple(model, { messages: [] });
    expect(stream.mock.calls[1]?.[2]?.apiKey).toBe("rotated-key");
    expect(child.runtime.getProviderAuthStatus(id).source).not.toBe("runtime");
    await host.runtime.removeRuntimeApiKey(id);
    expect(runtime.hasConfiguredAuth(id)).toBe(false);
    expect(await runtime.getAvailable(id)).toEqual([]);
    expect((await runtime.completeSimple(model, { messages: [] })).stopReason).toBe("error");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("uses the host's OAuth credential store and locked refresh, not the worker's store", async () => {
    const f = await fauxRuntime([reply("OAuth answer")]);
    const credentials = new InMemoryCredentialStore();
    const childCredentials = new InMemoryCredentialStore();
    const id = f.faux.provider.id;
    await credentials.modify(id, async () => ({ type: "oauth", access: "expired", refresh: "test-refresh", expires: 0 }));
    const host = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const child = await ModelRuntime.create({ credentials: childCredentials, modelsPath: null, refreshOnCreate: false });
    const refresh = vi.fn(async (credential: { access: string; refresh: string; expires: number }) => ({ ...credential, type: "oauth" as const, access: "renewed-test-token", expires: Date.now() + 3_600_000 }));
    const stream = vi.fn(f.faux.provider.streamSimple.bind(f.faux.provider));
    host.registerNativeProvider({ ...f.faux.provider, streamSimple: stream, auth: { oauth: {
      name: "Test OAuth", login: async () => { throw new Error("No login in tests"); }, refresh,
      toAuth: async credential => ({ apiKey: credential.access, headers: { "X-OAuth-Test": "host" } }),
    } } });
    await host.refresh({ allowNetwork: false });
    const runtime = new InheritedProviders().sync(child, new ModelRegistry(host));
    const model = runtime.getModel(id, f.faux.getModel().id)!;
    const result = await runtime.completeSimple(model, { messages: [] });
    expect(result.stopReason).toBe("stop");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0]?.[2]).toMatchObject({ apiKey: "renewed-test-token", headers: { "X-OAuth-Test": "host" } });
    expect(await credentials.read(id)).toMatchObject({ access: "renewed-test-token" });
    expect(await childCredentials.read(id)).toBeUndefined();
    expect(runtime.isUsingOAuth(id)).toBe(true);
  });


  it("uses host image/classifier dispatch and preserves abort/options without copying hooks", async () => {
    const host = await fauxRuntime();
    const child = await fauxRuntime();
    const registry = new ModelRegistry(host.runtime);
    const images = vi.spyOn(registry, "generateImages").mockResolvedValue({ role: "assistant", output: [], stopReason: "stop" } as never);
    const classify = vi.spyOn(registry, "classify").mockResolvedValue({ answers: {}, stopReason: "stop" } as never);
    const runtime = new InheritedProviders().sync(child.runtime, registry);
    const image = registry.getModelsOfType("image")[0]!;
    const classifier = registry.getModelsOfType("classifier")[0]!;
    const options = { signal: new AbortController().signal };
    await runtime.generateImages(image, { input: [] }, options);
    await runtime.classify(classifier, { state: {}, questions: {} }, options);
    expect(images).toHaveBeenCalledWith(image, { input: [] }, options);
    expect(classify).toHaveBeenCalledWith(classifier, { state: {}, questions: {} }, options);
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(runtime.getAuth(image, { signal: abort.signal })).rejects.toThrow("cancelled");
  });

  it("uses agentDir for standalone Pi models.json and auth.json without a host registry", async () => {
    const agentDir = await scratch();
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "standalone-local": {
      baseUrl: "http://localhost:8000/v1", api: "openai-completions", models: [{ id: "test" }],
    } } }));
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "standalone-local": { type: "api_key", key: "isolated-test-key" } }));
    const runtime = await new OrcheController({ agentDir }).modelRuntime();
    expect(runtime.getModel("standalone-local", "test")).toBeDefined();
    expect(await runtime.getAuth("standalone-local")).toMatchObject({ auth: { apiKey: "isolated-test-key" } });
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
      // Reproduce a package that used to be installed independently, but is now bundled in Pi.
      await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, providerExtensions: ["npm:@scope/removed-provider"], records: { enabled: false } }));
      expect(h.orche.runtime.getModel(h.main.faux.provider.id, h.main.faux.getModel().id)).toBeUndefined();
      await h.session.prompt("Answer through orche");
      const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "orche_task");
      expect(result).toMatchObject({ isError: false, details: { worker: "W1", spawned: [expect.objectContaining({ id: "W1.1", status: "done" })] } });
      expect(result).toMatchObject({ details: { warnings: [expect.stringContaining("Using Pi's inherited providers")] } });
      expect(h.session.getLastAssistantText()).toBe("Main finished");
      expect(h.main.faux.state.callCount).toBe(5);
      expect(h.orche.faux.state.callCount).toBe(0);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await h.dispose();
    }
  });
});
