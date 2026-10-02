import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createProviderConfig, MODEL_ID, PROVIDER_ID } from "../../src/pi/bundled-images.js";
import { ensureBundledImageProvider } from "../../src/pi/register-bundled-image-provider.js";
import { fauxRuntime } from "../helpers/faux.js";

// The real provider module, with createProviderConfig observable (it reads credential files, so "not called" matters).
vi.mock("../../src/pi/bundled-images.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/pi/bundled-images.js")>();
  return { ...actual, createProviderConfig: vi.fn(actual.createProviderConfig) };
});
const providerConfig = vi.mocked(createProviderConfig);

const roots: string[] = [];
beforeEach(() => {
  providerConfig.mockReset(); // back to the real implementation passed to vi.fn
  vi.stubEnv("CLIPROXYAPI_BASE_URL", ""); // keep the developer's environment out of the connection settings
  vi.stubEnv("CLIPROXYAPI_API_KEY", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function agentDirWith(files: Record<string, unknown> = {}): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "orche-bundled-images-"));
  roots.push(agentDir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(agentDir, name), JSON.stringify(content));
  return agentDir;
}
/** A user/extension-registered provider under the bundled provider's id. */
const otherRegistration = (modelId: string): ProviderConfig => ({
  name: "Registered elsewhere", apiKey: "test-placeholder",
  models: [{ type: "image", id: modelId, name: "Registered elsewhere", api: "test-images", baseUrl: "https://invalid.example/v1", input: ["text", "image"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  images: { "test-images": { generateImages: vi.fn() } },
});
const bundled = { model: `${PROVIDER_ID}/${MODEL_ID}`, timeoutMs: 1000 };

describe("ensureBundledImageProvider", () => {
  it("registers the bundled provider with the given agentDir, resolving the connection from it", async () => {
    const agentDir = await agentDirWith({ "cliproxyapi.json": { baseUrl: "http://gateway.test:9999", apiKey: "sk-not-a-real-key-0000" } });
    const { runtime } = await fauxRuntime();
    expect(runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)).toBeUndefined();

    expect(ensureBundledImageProvider({ runtime, images: bundled, agentDir })).toBe(true);

    expect(providerConfig).toHaveBeenCalledTimes(1);
    expect(providerConfig).toHaveBeenCalledWith({ agentDir });
    const model = runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID);
    expect(model).toMatchObject({ type: "image", provider: PROVIDER_ID, id: MODEL_ID, baseUrl: "http://gateway.test:9999/v1" });
    expect(JSON.stringify(model)).not.toContain("sk-not-a-real-key"); // credentials are resolved per request, never stored in the model
  });

  it("registers even when no credentials exist yet (they are resolved per request)", async () => {
    const { runtime } = await fauxRuntime();
    expect(ensureBundledImageProvider({ runtime, images: bundled, agentDir: await agentDirWith() })).toBe(true);
    expect(runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)).toMatchObject({ baseUrl: "http://127.0.0.1:8317/v1" });
  });

  it.each([
    ["images unset", undefined],
    ["another image provider", { model: "image-test/image" }],
    ["the bundled id as the model, not the provider", { model: `other/${PROVIDER_ID}` }],
    ["a provider that merely starts with the bundled id", { model: `${PROVIDER_ID}-2/${MODEL_ID}` }],
    ["a model without a provider part", { model: `${PROVIDER_ID}x` }],
    ["an empty provider part", { model: `/${MODEL_ID}` }],
  ])("does nothing and never calls createProviderConfig for %s", async (_name, images) => {
    const { runtime } = await fauxRuntime();
    const register = vi.spyOn(runtime, "registerProvider");
    expect(ensureBundledImageProvider({ runtime, images, agentDir: await agentDirWith() })).toBe(false);
    expect(providerConfig).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(runtime.getProvider(PROVIDER_ID)).toBeUndefined();
  });

  it("is a no-op without error when the provider is already registered, leaving that registration untouched", async () => {
    const { runtime } = await fauxRuntime();
    runtime.registerProvider(PROVIDER_ID, otherRegistration(MODEL_ID)); // e.g. loaded through providerExtensions
    const register = vi.spyOn(runtime, "registerProvider");
    expect(() => ensureBundledImageProvider({ runtime, images: bundled, agentDir: "/unused" })).not.toThrow();
    expect(ensureBundledImageProvider({ runtime, images: bundled, agentDir: "/unused" })).toBe(false);
    expect(providerConfig).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)).toMatchObject({ name: "Registered elsewhere" });
  });

  it("does not overwrite an existing provider registration that lacks the configured model", async () => {
    const { runtime } = await fauxRuntime();
    runtime.registerProvider(PROVIDER_ID, otherRegistration("some-other-model"));
    const register = vi.spyOn(runtime, "registerProvider");
    expect(ensureBundledImageProvider({ runtime, images: bundled, agentDir: "/unused" })).toBe(false);
    expect(providerConfig).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(runtime.getModelOfType("image", PROVIDER_ID, "some-other-model")).toBeDefined();
  });

  it("treats an already available model as registered even if the provider lookup finds nothing", () => {
    const registerProvider = vi.fn();
    const runtime = { getProvider: () => undefined, getModelOfType: () => ({ id: MODEL_ID }), registerProvider };
    expect(ensureBundledImageProvider({ runtime, images: bundled, agentDir: "/unused" })).toBe(false);
    expect(registerProvider).not.toHaveBeenCalled();
    expect(providerConfig).not.toHaveBeenCalled();
  });

  it("registers once when called repeatedly", async () => {
    const agentDir = await agentDirWith();
    const { runtime } = await fauxRuntime();
    const register = vi.spyOn(runtime, "registerProvider");
    const results = [1, 2, 3].map(() => ensureBundledImageProvider({ runtime, images: bundled, agentDir }));
    expect(results).toEqual([true, false, false]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(PROVIDER_ID, expect.objectContaining({ name: "CLIProxyAPI Images" }));
    expect(providerConfig).toHaveBeenCalledTimes(1);
    expect(runtime.getModelsOfType("image", PROVIDER_ID)).toHaveLength(1);
  });
});
