import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AssistantImages, ImageApi, ImageModel, Usage } from "@earendil-works/pi-ai";
import { createGenerateImageTool, type GenerateImageInput, type ImageRuntime } from "../../src/tools/generate-image.js";
import { checkWriteRealPath } from "../../src/orchestration/ownership.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const model: ImageModel<ImageApi> = { type: "image", id: "image", name: "Test image", provider: "test", api: "test-images", baseUrl: "https://invalid.example/v1", input: ["text", "image"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage: Usage = { input: 14, output: 2058, cacheRead: 0, cacheWrite: 0, totalTokens: 2072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orche-image-"));
  roots.push(root);
  const cwd = join(root, "work");
  await mkdir(cwd);
  const png = await sharp({ create: { width: 64, height: 40, channels: 4, background: { r: 240, g: 180, b: 10, alpha: 0.5 } } }).png().toBuffer();
  const response: AssistantImages = { api: model.api, provider: model.provider, model: model.id, output: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], usage, stopReason: "stop", timestamp: Date.now() };
  const generateImages = vi.fn<ImageRuntime["generateImages"]>().mockResolvedValue(response);
  const getModelOfType = vi.fn<ImageRuntime["getModelOfType"]>().mockReturnValue(model);
  const runtime = { generateImages, getModelOfType };
  const tool = createGenerateImageTool({ cwd, runtime, images: { model: "test/image", timeoutMs: 45000 } });
  const run = (params: Partial<GenerateImageInput> = {}, signal?: AbortSignal) => tool.execute("test-call", { prompt: "A transparent gold coin sprite", path: "assets/coin.png", ...params }, signal, undefined, {} as never);
  return { root, cwd, png, response, runtime, tool, run };
}
const text = (result: Awaited<ReturnType<ReturnType<typeof createGenerateImageTool>["execute"]>>) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

describe("generate_image", () => {
  it("writes in scope, resizes with transparent contain padding, and returns the saved image and usage", async () => {
    const { cwd, run, runtime } = await fixture();
    expect(await checkWriteRealPath({ toolName: "generate_image", input: { path: "assets/coin.png" }, cwd, agentId: "W1", assignmentKind: "game-asset", tasks: [{ id: "T1", owner: "W1", description: "coin", files: ["assets/"], status: "running" }] })).toBeUndefined();
    const signal = new AbortController().signal;
    const result = await run({ width: 32, height: 32, background: "transparent", kernel: "nearest" }, signal);
    expect(result.isError).not.toBe(true);
    const bytes = await readFile(join(cwd, "assets/coin.png"));
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 32, height: 32, channels: 4, hasAlpha: true, format: "png" });
    const pixels = await sharp(bytes).raw().toBuffer();
    expect(pixels[3]).toBe(0); // transparent letterbox, not sharp's default opaque black
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
    expect(result.usage).toEqual(usage);
    expect(text(result)).toContain("32x32 (original 64x40)");
    expect(text(result)).toContain("14 input, 2058 output, 2072 total");
    expect(text(result)).toContain("elapsed");
    expect(runtime.getModelOfType).toHaveBeenCalledWith("image", "test", "image");
    expect(runtime.generateImages).toHaveBeenCalledWith(model, { input: [{ type: "text", text: "A transparent gold coin sprite" }] }, { signal, timeoutMs: 45000, metadata: { background: "transparent" } });
  });

  it.each([[".png", "image/png", "png"], [".webp", "image/webp", "webp"], [".jpg", "image/jpeg", "jpeg"]])("encodes %s by extension", async (extension, mimeType, format) => {
    const { cwd, run } = await fixture();
    const result = await run({ path: `coin${extension}` });
    expect(result.isError).not.toBe(true);
    expect(result.content[1]).toMatchObject({ type: "image", mimeType });
    expect(await sharp(await readFile(join(cwd, `coin${extension}`))).metadata()).toMatchObject({ format, width: 64, height: 40 });
  });

  it("uses the image's aspect ratio when only width is supplied", async () => {
    const { run } = await fixture();
    expect((await run({ width: 32 })).details).toMatchObject({ width: 32, height: 20 });
  });

  it("sends workspace references as decoded image inputs for edits", async () => {
    const { cwd, png, run, runtime } = await fixture();
    await writeFile(join(cwd, "reference.png"), png);
    expect((await run({ references: ["reference.png"] })).isError).not.toBe(true);
    expect(runtime.generateImages.mock.calls[0]?.[1].input[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  });

  it("reports a missing model with providerExtensions/credentials guidance", async () => {
    const { run, runtime } = await fixture();
    runtime.getModelOfType.mockReturnValue(undefined);
    const result = await run();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("providerExtensions");
    expect(text(result)).toContain("credentials");
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });

  it.each(["error", "aborted"] as const)("surfaces generation %s and retains its token usage", async stopReason => {
    const { run, runtime, response, cwd } = await fixture();
    runtime.generateImages.mockResolvedValue({ ...response, stopReason, errorMessage: "Gateway image request failed", output: [] });
    const result = await run();
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Gateway image request failed");
    expect(result.usage).toEqual(usage);
    await expect(readFile(join(cwd, "assets/coin.png"))).rejects.toThrow();
  });

  it("reports an empty successful image response", async () => {
    const { run, runtime, response } = await fixture();
    runtime.generateImages.mockResolvedValue({ ...response, output: [] });
    expect(text(await run())).toContain("returned no image");
  });

  it("honors caller cancellation before generation and before saving", async () => {
    const { run, runtime, response, cwd } = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect((await run({}, controller.signal)).isError).toBe(true);
    expect(runtime.generateImages).not.toHaveBeenCalled();
    const later = new AbortController();
    runtime.generateImages.mockImplementation(async () => { later.abort(); return response; });
    expect(text(await run({}, later.signal))).toContain("aborted");
    await expect(readFile(join(cwd, "assets/coin.png"))).rejects.toThrow();
  });

  it.each(["../outside.png", "/tmp/outside.png", "coin.svg"])("rejects invalid output %s before generation", async path => {
    const { run, runtime } = await fixture();
    expect((await run({ path })).isError).toBe(true);
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });

  it("rejects output symlinks escaping the workspace", async () => {
    const { root, cwd, run, runtime } = await fixture();
    await symlink(root, join(cwd, "escape"));
    expect(text(await run({ path: "escape/outside.png" }))).toContain("outside the workspace");
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });

  it.each(["../reference.png", "/tmp/reference.png"])("rejects outside reference %s before generation", async reference => {
    const { run, runtime } = await fixture();
    const result = await run({ references: [reference] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("inside the workspace");
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });

  it("rejects a reference symlink outside the workspace", async () => {
    const { root, cwd, png, run, runtime } = await fixture();
    await writeFile(join(root, "outside.png"), png);
    await symlink(join(root, "outside.png"), join(cwd, "reference.png"));
    expect(text(await run({ references: ["reference.png"] }))).toContain("outside the workspace via a symlink");
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Infinity])("rejects invalid dimension %s even for direct calls", async width => {
    const { run, runtime } = await fixture();
    expect((await run({ width })).isError).toBe(true);
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });
});
