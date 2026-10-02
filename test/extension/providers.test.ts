import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider, fauxAssistantMessage as reply, fauxToolCall as call, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { loadProviderExtensions, ProviderExtensionError } from "../../src/pi/provider-extensions.js";
import { MODEL_ID, PROVIDER_ID } from "../../src/pi/bundled-images.js";
import { ensureBundledImageProvider } from "../../src/pi/register-bundled-image-provider.js";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import { parseRouteConfig } from "../../src/orchestration/routing.js";
import { fauxRuntime } from "../helpers/faux.js";

interface Globals { __orcheTestProvider?: FauxProviderHandle; __orcheRogueLoaded?: boolean }
const shared = globalThis as Globals;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete shared.__orcheTestProvider;
  delete shared.__orcheRogueLoaded;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A user-scope "installed" Pi package whose extension registers a provider, and an unrelated user extension. */
async function installProviderPackage(name = "fake-provider-pkg") {
  const root = await mkdtemp(join(tmpdir(), "orche-provext-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const pkg = join(root, "pkg");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name, type: "module", pi: { extensions: ["./index.ts"] } }));
  await writeFile(join(pkg, "index.ts"), "export default function (pi) { pi.registerProvider(globalThis.__orcheTestProvider.provider); }\n");
  await writeFile(join(agentDir, "extensions", "rogue.ts"), "globalThis.__orcheRogueLoaded = true;\nexport default function () {}\n");
  return { root, agentDir, source: pkg };
}
const modelRef = (provider: FauxProviderHandle) => `${provider.provider.id}/${provider.getModel().id}`;
const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });

describe("provider extensions in orche's own runtime", () => {
  it("makes an extension-registered provider resolvable, loading only the configured package", async () => {
    const installed = await installProviderPackage();
    shared.__orcheTestProvider = fauxProvider({ provider: "ext-provider" });
    const f = await fauxRuntime();
    const model = shared.__orcheTestProvider.getModel();
    expect(f.runtime.getModel("ext-provider", model.id)).toBeUndefined();

    const host = await loadProviderExtensions(f.runtime, [installed.source], { cwd: installed.root, agentDir: installed.agentDir });
    try {
      expect(f.runtime.getModel("ext-provider", model.id)).toBeDefined();
      expect(shared.__orcheRogueLoaded).toBeUndefined(); // the user's other extensions are never loaded
    } finally {
      host.dispose();
    }
  });

  it("fails clearly for a source that is not installed, and refuses pi-orche itself", async () => {
    const installed = await installProviderPackage("pi-orche");
    shared.__orcheTestProvider = fauxProvider({ provider: "ext-provider" });
    const f = await fauxRuntime();
    await expect(loadProviderExtensions(f.runtime, [join(installed.root, "missing")], { cwd: installed.root, agentDir: installed.agentDir }))
      .rejects.toBeInstanceOf(ProviderExtensionError);
    await expect(loadProviderExtensions(f.runtime, [join(installed.root, "missing")], { cwd: installed.root, agentDir: installed.agentDir }))
      .rejects.toThrow(/not installed at user scope.*pi install/);
    await expect(loadProviderExtensions(f.runtime, [installed.source], { cwd: installed.root, agentDir: installed.agentDir }))
      .rejects.toThrow(/recurse/);
    expect(f.runtime.getModel("ext-provider", shared.__orcheTestProvider.getModel().id)).toBeUndefined();
  });

  it("runOrchestrated routes every role to an extension provider when providerExtensions is configured (and fails without it)", async () => {
    const installed = await installProviderPackage();
    const provider = fauxProvider({ provider: "ext-provider" });
    shared.__orcheTestProvider = provider;
    provider.setResponses([
      tool("coordinator_decision", { decision: { type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "explanation" } }),
      tool("report_result", { kind: "answer", summary: "EXT_PROVIDER_ANSWER", data: { evidence: [] } }),
      tool("coordinator_decision", { decision: { type: "answer_from_worker", sourceAgentId: "A1", summary: "done" } }),
    ]);
    const f = await fauxRuntime();
    const route = { model: modelRef(provider) };
    const without = await runOrchestrated({ problem: "explain", cwd: installed.root, routes: parseRouteConfig({ routes: {}, default: route }), modelRuntime: f.runtime });
    expect(without.status).toBe("failed");
    expect(without.summary).toContain("Unknown model: ext-provider/");

    const withProviders = await runOrchestrated({
      problem: "explain", cwd: installed.root, modelRuntime: f.runtime,
      routes: { ...parseRouteConfig({ routes: {}, default: route }), providerExtensions: [installed.source] },
    });
    expect(withProviders).toMatchObject({ status: "done", answer: "EXT_PROVIDER_ANSWER" });
    expect(provider.getPendingResponseCount()).toBe(0);
  });

  it("validates the providerExtensions config field", () => {
    const base = { routes: {} };
    expect(parseRouteConfig({ ...base, providerExtensions: ["npm:@scope/pkg"] }).providerExtensions).toEqual(["npm:@scope/pkg"]);
    for (const bad of [[], "npm:x", [""], [" npm:x"], [1], ["a", "a"], ["a", "b", "c", "d", "e"]]) {
      expect(() => parseRouteConfig({ ...base, providerExtensions: bad })).toThrow("config.providerExtensions");
    }
  });

  describe("with the bundled cliproxyapi-images provider", () => {
    const bundled = { model: `${PROVIDER_ID}/${MODEL_ID}` };

    it("is not registered again when a providerExtensions package already provides it", async () => {
      const installed = await installProviderPackage();
      await writeFile(join(installed.source, "index.ts"), `export default function (pi) {\n  pi.registerProvider(${JSON.stringify(PROVIDER_ID)}, { name: "From extension", apiKey: "x", models: [{ type: "image", id: ${JSON.stringify(MODEL_ID)}, name: "From extension", api: "ext-images", baseUrl: "https://invalid.example/v1", input: ["text"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], images: { "ext-images": { generateImages: async () => { throw new Error("unused"); } } } });\n}\n`);
      const f = await fauxRuntime();
      const host = await loadProviderExtensions(f.runtime, [installed.source], { cwd: installed.root, agentDir: installed.agentDir });
      try {
        expect(f.runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)).toMatchObject({ name: "From extension" });
        const register = vi.spyOn(f.runtime, "registerProvider");
        expect(ensureBundledImageProvider({ runtime: f.runtime, images: bundled, agentDir: installed.agentDir })).toBe(false);
        expect(register).not.toHaveBeenCalled();
        expect(f.runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)).toMatchObject({ name: "From extension" });
      } finally {
        host.dispose();
      }
    });

    it("coexists with the real pi-images package listed in providerExtensions (no conflict, no double registration)", async () => {
      const installed = await installProviderPackage();
      // That package's extension calls createProviderConfig() with the default agent dir: point it at the temp one.
      vi.stubEnv("PI_CODING_AGENT_DIR", installed.agentDir);
      vi.stubEnv("CLIPROXYAPI_BASE_URL", "");
      vi.stubEnv("CLIPROXYAPI_API_KEY", "");
      const f = await fauxRuntime();
      const piImages = fileURLToPath(new URL("../../node_modules/pi-gateway-images", import.meta.url));
      const host = await loadProviderExtensions(f.runtime, [piImages], { cwd: installed.root, agentDir: installed.agentDir });
      try {
        const loaded = f.runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID);
        expect(loaded).toBeDefined();
        const register = vi.spyOn(f.runtime, "registerProvider");
        expect(ensureBundledImageProvider({ runtime: f.runtime, images: bundled, agentDir: installed.agentDir })).toBe(false);
        expect(ensureBundledImageProvider({ runtime: f.runtime, images: bundled, agentDir: installed.agentDir })).toBe(false);
        expect(register).not.toHaveBeenCalled();
        expect(f.runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)).toMatchObject({ name: loaded!.name, baseUrl: loaded!.baseUrl });
        expect(f.runtime.getModelsOfType("image", PROVIDER_ID)).toHaveLength(1);
      } finally {
        host.dispose();
      }
    });
  });
});
