import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { createGenerateImageTool } from "../../src/tools/generate-image.js";

// Exactly one billable call when enabled; no provider import or credential lookup by default.
describe.skipIf(process.env.LIVE_IMAGES !== "1")("generate_image live gateway e2e", () => {
  it("generates and saves a transparent 32x32 RGBA coin sprite through a real ModelRuntime", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orche-image-live-"));
    try {
      // Lazy import of the bundled provider (the pi-gateway-images dependency, via orche's single import point):
      // nothing is loaded and no credentials are read unless LIVE_IMAGES=1.
      const { createProviderConfig, PROVIDER_ID, MODEL_ID } = await import("../../src/pi/bundled-images.js");
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false,
      });
      runtime.registerProvider(PROVIDER_ID, createProviderConfig());
      expect(runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)).toBeDefined();
      const tool = createGenerateImageTool({ cwd, runtime, images: { model: `${PROVIDER_ID}/${MODEL_ID}`, timeoutMs: 180000 } });
      const result = await tool.execute("live-coin", {
        prompt: "A single golden coin sprite for a retro pixel-art game, centered, crisp simple pixel-art shapes, front view, no text, no shadow, isolated on a completely transparent background. Designed to be readable at 32 by 32 pixels.",
        path: "assets/coin.png", background: "transparent", width: 32, height: 32, kernel: "nearest",
      }, new AbortController().signal, undefined, {} as never);
      if (result.isError) throw new Error(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
      const bytes = await readFile(join(cwd, "assets/coin.png"));
      const metadata = await sharp(bytes).metadata();
      expect(metadata).toMatchObject({ format: "png", width: 32, height: 32, channels: 4, hasAlpha: true });
      expect((await sharp(bytes).stats()).isOpaque).toBe(false);
      expect(result.content.find(block => block.type === "image")).toMatchObject({ mimeType: "image/png", data: bytes.toString("base64") });
      expect(result.usage?.totalTokens).toBeGreaterThan(0);
      const details = result.details as { originalWidth: number; originalHeight: number; elapsedMs: number };
      // Log safe evidence only: never provider options, configuration, image bytes, or credentials.
      console.log(JSON.stringify({ liveImage: "coin", width: metadata.width, height: metadata.height,
        channels: metadata.channels, alpha: metadata.hasAlpha, format: metadata.format,
        originalWidth: details.originalWidth, originalHeight: details.originalHeight,
        elapsedMs: details.elapsedMs, inputTokens: result.usage?.input, outputTokens: result.usage?.output }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 240000);
});
