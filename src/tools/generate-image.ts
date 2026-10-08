import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesOptions, Usage } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import type { ImageSettings } from "../orchestration/routing.js";
import { checkWriteRealPath } from "../orchestration/ownership.js";
import { coerceIntegerArguments } from "./prepare-arguments.js";

export const generateImageParameters = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1, description: "Workspace-relative output file (.png, .webp or .jpg)" }),
  references: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Workspace image files to edit/use as references" })),
  background: Type.Optional(Type.Union([Type.Literal("transparent"), Type.Literal("opaque"), Type.Literal("auto")])),
  width: Type.Optional(Type.Integer({ minimum: 1 })),
  height: Type.Optional(Type.Integer({ minimum: 1 })),
  fit: Type.Optional(Type.Union([Type.Literal("contain"), Type.Literal("cover"), Type.Literal("fill"), Type.Literal("inside")])),
  kernel: Type.Optional(Type.Union([Type.Literal("nearest"), Type.Literal("lanczos3")])),
});
export type GenerateImageInput = Static<typeof generateImageParameters>;
/** Narrow enough for fake runtimes, implemented by the worker pool's ModelRuntime. */
export interface ImageRuntime {
  getModelOfType(type: "image", provider: string, id: string): ImageModel<ImageApi> | undefined;
  generateImages(model: ImageModel<ImageApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
}

function inside(cwd: string, target: string): boolean {
  const rel = relative(cwd, target);
  return !!rel && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}
function workspacePath(cwd: string, path: string): string {
  const target = resolve(cwd, path);
  if (!path.trim() || isAbsolute(path) || /^[A-Za-z]:/.test(path) || !inside(cwd, target)) throw new Error("Image paths must be workspace-relative and inside the workspace");
  return target;
}
const referenceMime: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function createGenerateImageTool(options: { cwd: string; runtime: ImageRuntime; images: ImageSettings }): ToolDefinition<typeof generateImageParameters> {
  const cwd = resolve(options.cwd);
  return {
    name: "generate_image",
    label: "Generate image",
    description: "Generate raster art, or edit workspace reference images, and save inside your write scope. PNG/WebP preserve alpha. Set width/height for exact target dimensions (gateway size is ignored); use nearest for pixel art. Inspect the saved image with read.",
    parameters: generateImageParameters,
    prepareArguments: coerceIntegerArguments(["width", "height"]),
    async execute(_id, params, signal) {
      const started = Date.now();
      let usage: Usage | undefined;
      try {
        signal?.throwIfAborted();
        if (!params.prompt.trim()) throw new Error("prompt must be nonempty");
        for (const size of [params.width, params.height]) if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) throw new Error("width and height must be positive integers");
        const target = workspacePath(cwd, params.path);
        const extension = extname(target).toLowerCase();
        if (![".png", ".webp", ".jpg"].includes(extension)) throw new Error("Output path must end in .png, .webp or .jpg");
        const path = relative(cwd, target);
        // The session guard enforces the worker's narrower scope. Also fail closed for direct
        // callers and recheck after a slow generation in case a parent link changed meanwhile.
        const guard = () => checkWriteRealPath({ toolName: "generate_image", input: { path }, cwd, agentId: "image", assignmentKind: "game-asset", tasks: [{ id: "image", owner: "image", description: "Image output", files: [path], status: "running" }] });
        const blocked = await guard();
        if (blocked) throw new Error(blocked.reason);
        const slash = options.images.model.indexOf("/");
        const model = options.runtime.getModelOfType("image", options.images.model.slice(0, slash), options.images.model.slice(slash + 1));
        if (!model) throw new Error(`Image model ${options.images.model} is not registered in orche's runtime. cliproxyapi-images is bundled with pi-orche and registered automatically when images.model names it (check the model id, e.g. cliproxyapi-images/gpt-image-2.5, and the gateway credentials). Any other image provider needs a providerExtensions entry, installed with \`pi install\`, so orche can load it.`);
        const input: ImagesContext["input"] = [{ type: "text", text: params.prompt }];
        const root = await realpath(cwd);
        for (const reference of params.references ?? []) {
          const absolute = workspacePath(cwd, reference);
          if (!inside(root, await realpath(absolute))) throw new Error("Reference image is outside the workspace via a symlink");
          const bytes = await readFile(absolute);
          const metadata = await sharp(bytes).metadata();
          const mimeType = metadata.format && referenceMime[metadata.format];
          if (!mimeType) throw new Error("Reference images must be PNG, JPEG, WebP or GIF raster files");
          input.push({ type: "image", data: bytes.toString("base64"), mimeType });
        }
        signal?.throwIfAborted();
        const response = await options.runtime.generateImages(model, { input }, {
          signal, timeoutMs: options.images.timeoutMs ?? 180_000,
          metadata: { ...(params.background ? { background: params.background } : {}) },
        });
        usage = response.usage;
        if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Image generation ${response.stopReason}`);
        const image = response.output.find(block => block.type === "image");
        if (!image) throw new Error("Image generation returned no image");
        signal?.throwIfAborted();
        const bytes = Buffer.from(image.data, "base64");
        const original = await sharp(bytes).metadata();
        let pipeline = sharp(bytes);
        if (params.width !== undefined || params.height !== undefined) pipeline = pipeline.resize(params.width, params.height, {
          fit: params.fit ?? "contain", kernel: params.kernel ?? "lanczos3", background: { r: 0, g: 0, b: 0, alpha: 0 },
        });
        pipeline = extension === ".jpg" ? pipeline.jpeg() : extension === ".webp" ? pipeline.ensureAlpha().webp() : pipeline.ensureAlpha().png();
        const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
        await withFileMutationQueue(target, async () => {
          signal?.throwIfAborted();
          const blocked = await guard();
          if (blocked) throw new Error(blocked.reason);
          await mkdir(dirname(target), { recursive: true });
          signal?.throwIfAborted();
          await writeFile(target, data, { signal });
        });
        const elapsedMs = Date.now() - started;
        const mimeType = extension === ".jpg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
        return {
          content: [
            { type: "text", text: `Saved ${path}: ${info.width}x${info.height} (original ${original.width}x${original.height}); tokens: ${usage ? `${usage.input} input, ${usage.output} output, ${usage.totalTokens} total` : "not reported"}; elapsed ${elapsedMs}ms` },
            { type: "image", data: data.toString("base64"), mimeType },
          ],
          details: { path, width: info.width, height: info.height, originalWidth: original.width, originalHeight: original.height, elapsedMs },
          ...(usage ? { usage } : {}),
        };
      } catch (error) {
        const message = signal?.aborted ? "Image generation aborted" : error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: undefined, isError: true, ...(usage ? { usage } : {}) };
      }
    },
  };
}
