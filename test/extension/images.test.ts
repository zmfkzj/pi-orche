import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { AssistantImages, FauxResponseStep } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { OrcheController } from "../../src/extension/controller.js";
import { WorkerPool, type TaskRole } from "../../src/extension/workers.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { discoverOrcheConfig } from "../../src/extension/config.js";
import { createProviderConfig, MODEL_ID, PROVIDER_ID } from "../../src/pi/bundled-images.js";

// The real bundled provider module, with createProviderConfig observable: registration must be lazy (it reads credential files).
vi.mock("../../src/pi/bundled-images.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/pi/bundled-images.js")>();
  return { ...actual, createProviderConfig: vi.fn(actual.createProviderConfig) };
});
const providerConfig = vi.mocked(createProviderConfig);
const BUNDLED = `${PROVIDER_ID}/${MODEL_ID}`;

const open: { h: Harness; pool: WorkerPool }[] = [];
beforeEach(() => { providerConfig.mockReset(); }); // back to the real implementation passed to vi.fn
afterEach(async () => {
  for (const { h, pool } of open.splice(0)) { await pool.dispose(); await h.dispose(); }
  vi.restoreAllMocks();
});
const report = (role: TaskRole) => tool("report_result", { kind: role, summary: "Done", data: role === "verify" ? { passed: true } : role === "game-asset" || role === "video" ? { status: "done", outputs: [] } : { status: "done" } });
/** A network-free image provider whose single model uses `generateImages`. */
const imageProvider = (modelId: string, generateImages: ReturnType<typeof vi.fn>): ProviderConfig => ({
  apiKey: "test-placeholder",
  models: [{ type: "image", id: modelId, name: "Test image", api: "test-images", baseUrl: "https://invalid.example/v1", input: ["text", "image"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  images: { "test-images": { generateImages } },
});
async function fixture(steps: FauxResponseStep[], configured = true, imageModel = "image-test/image") {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps });
  const configure = async (enabled: boolean) => writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, ...(enabled ? { images: { model: imageModel, timeoutMs: 50000 } } : {}) }));
  await configure(configured);
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 200, b: 0, alpha: 0.5 } } }).png().toBuffer();
  const response: AssistantImages = { api: "test-images", provider: "image-test", model: "image", output: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], stopReason: "stop", timestamp: Date.now() };
  const generateImages = vi.fn().mockResolvedValue(response);
  h.runtime.registerProvider("image-test", imageProvider("image", generateImages));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  open.push({ h, pool });
  const execute = (role: TaskRole, worker?: string) => pool.execute({ role, worker, request: "Produce deliverables", cwd: h.cwd, projectTrusted: false, files: ["assets/"] });
  return { h, pool, execute, configure, generateImages };
}

describe("image tool worker exposure", () => {
  it.each(["game-asset", "video"] as const)("offers %s the image tool with raster instructions and an enforced write scope", async role => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    let rejected = "";
    const { h, pool, execute, generateImages } = await fixture([
      tool("generate_image", { prompt: "gold coin", path: "unowned.png", width: 32, height: 32 }),
      context => { rejected = JSON.stringify(context.messages); return tool("generate_image", { prompt: "gold coin", path: "assets/coin.png", width: 32, height: 32, background: "transparent", kernel: "nearest" }); },
      report(role),
    ]);
    await execute(role);
    expect(rejected).toContain("outside your owned files");
    await expect(readFile(join(h.cwd, "unowned.png"))).rejects.toThrow();
    expect(generateImages).toHaveBeenCalledTimes(1);
    expect(await sharp(await readFile(join(h.cwd, "assets/coin.png"))).metadata()).toMatchObject({ width: 32, height: 32, hasAlpha: true, channels: 4 });
    expect(spawned.mock.calls[0]?.[0].tools).toContain("generate_image");
    expect(spawned.mock.calls[0]?.[0].customTools?.map(tool => tool.name)).toEqual(["generate_image"]);
    expect(pool.session("W1").getActiveToolNames()).toContain("generate_image");
    const messages = JSON.stringify(pool.session("W1").messages);
    for (const phrase of ["generate_image for raster art", "1254x1254", 'nearest', "Inspect results with read", "procedural/SVG", "outputs[].spec"]) expect(messages).toContain(phrase);
  });

  for (const configured of [true, false]) it.each(["explore", "answer", "implement", "verify"] as const)(`never offers %s the tool (configured: ${configured})`, async role => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const { pool, execute } = await fixture([report(role)], configured);
    await execute(role);
    expect(pool.session("W1").getActiveToolNames()).not.toContain("generate_image");
    expect(spawned.mock.calls[0]?.[0].customTools).toEqual([]);
    expect(JSON.stringify(pool.session("W1").messages)).not.toContain("generate_image");
  });

  it.each(["game-asset", "video"] as const)("does not mention/offfer images for %s when unconfigured", async role => {
    const { pool, execute } = await fixture([report(role)], false);
    await execute(role);
    expect(pool.session("W1").getActiveToolNames()).not.toContain("generate_image");
    expect(JSON.stringify(pool.session("W1").messages)).not.toContain("generate_image");
  });

  it("recreates a reused specialist when its next role must not receive the image tool", async () => {
    const { pool, execute } = await fixture([report("game-asset"), report("implement")]);
    await execute("game-asset");
    const result = await execute("implement", "W1");
    expect(result.details.retired).toContain("W1");
    expect(result.details.worker).toBe("W2");
    expect(pool.session("W2").getActiveToolNames()).not.toContain("generate_image");
    expect(JSON.stringify(pool.session("W2").messages)).not.toContain("generate_image");
  });

  it("adds the tool on non-specialist reuse, and removes it when config is unset", async () => {
    const { pool, execute, configure } = await fixture([report("implement"), report("video"), report("video")]);
    await execute("implement");
    const second = await execute("video", "W1");
    expect(second.details.worker).toBe("W2");
    expect(pool.session("W2").getActiveToolNames()).toContain("generate_image");
    await configure(false);
    const third = await execute("video", "W2");
    expect(third.details.worker).toBe("W3");
    expect(pool.session("W3").getActiveToolNames()).not.toContain("generate_image");
    expect(JSON.stringify(pool.session("W3").messages)).not.toContain("generate_image");
  });

  it("carries image configuration through discovery and surfaces malformed timeout values", async () => {
    const { h } = await fixture([]);
    expect((await discoverOrcheConfig({ cwd: h.cwd, agentDir: h.agentDir, projectTrusted: false, session: {} })).routes.images).toEqual({ model: "image-test/image", timeoutMs: 50000 });
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, images: { model: "image-test/image", timeoutMs: 0 } }));
    await expect(discoverOrcheConfig({ cwd: h.cwd, agentDir: h.agentDir, projectTrusted: false, session: {} })).rejects.toThrow("config.images.timeoutMs");
  });
});

describe("bundled cliproxyapi-images provider registration", () => {
  const generate = tool("generate_image", { prompt: "gold coin", path: "assets/coin.png", width: 32, height: 32 });

  it.each(["game-asset", "video"] as const)("registers it lazily for %s with the pool's agentDir, once across reuse and new workers", async role => {
    const { h, pool, execute, generateImages } = await fixture([generate, report(role), report(role), report(role)], true, BUNDLED);
    providerConfig.mockImplementation(() => imageProvider(MODEL_ID, generateImages)); // network-free stand-in for the gateway client
    expect(providerConfig).not.toHaveBeenCalled();
    expect(h.runtime.getProvider(PROVIDER_ID)).toBeUndefined();

    await execute(role);
    expect(providerConfig).toHaveBeenCalledTimes(1);
    expect(providerConfig).toHaveBeenCalledWith({ agentDir: h.agentDir });
    expect(h.runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)).toBeDefined();
    expect(pool.session("W1").getActiveToolNames()).toContain("generate_image");
    expect(generateImages).toHaveBeenCalledTimes(1);
    expect(await sharp(await readFile(join(h.cwd, "assets/coin.png"))).metadata()).toMatchObject({ width: 32, height: 32 });

    expect((await execute(role, "W1")).details.worker).toBe("W1"); // reused worker
    expect((await execute(role)).details.worker).toBe("W2"); // fresh worker
    expect(providerConfig).toHaveBeenCalledTimes(1);
  });

  const scenarios: [name: string, role: TaskRole, configured: boolean, imageModel: string][] = [
    ["the explore role", "explore", true, BUNDLED],
    ["the answer role", "answer", true, BUNDLED],
    ["the implement role", "implement", true, BUNDLED],
    ["the verify role", "verify", true, BUNDLED],
    ["game-asset with images unset", "game-asset", false, BUNDLED],
    ["video with images unset", "video", false, BUNDLED],
    ["game-asset with another image provider", "game-asset", true, "image-test/image"],
    ["video with another image provider", "video", true, "image-test/image"],
  ];
  it.each(scenarios)("neither registers it nor reads provider configuration for %s", async (_name, role, configured, imageModel) => {
    const { h, execute } = await fixture([report(role)], configured, imageModel);
    const register = vi.spyOn(h.runtime, "registerProvider");
    await execute(role);
    expect(providerConfig).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(h.runtime.getProvider(PROVIDER_ID)).toBeUndefined();
  });

  it.each(["game-asset", "video"] as const)("is a no-op without error for %s when the provider is already registered (e.g. via providerExtensions)", async role => {
    const { h, execute, generateImages } = await fixture([generate, report(role), report(role)], true, BUNDLED);
    h.runtime.registerProvider(PROVIDER_ID, imageProvider(MODEL_ID, generateImages));
    const register = vi.spyOn(h.runtime, "registerProvider");
    await execute(role);
    await execute(role, "W1");
    expect(providerConfig).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(generateImages).toHaveBeenCalledTimes(1); // the existing registration served the request
    expect(h.runtime.getModelsOfType("image", PROVIDER_ID)).toHaveLength(1);
  });
});
