import type { ImageSettings } from "../orchestration/routing.js";
import { createProviderConfig, PROVIDER_ID, type ProviderConfig } from "./bundled-images.js";

/** The slice of `ModelRuntime` the helper needs; the worker pool's real runtime satisfies it. */
export interface BundledImageProviderRuntime {
  getProvider(providerId: string): unknown;
  getModelOfType(type: "image", providerId: string, modelId: string): unknown;
  registerProvider(providerId: string, config: ProviderConfig): void;
}

/**
 * Register the bundled `cliproxyapi-images` provider into orche's own runtime, but only when it is
 * needed. Returns whether it registered.
 *
 * - Acts only when `images.model` names the bundled provider; every other provider keeps loading
 *   through `providerExtensions`.
 * - A no-op, with no error, when the runtime already has that provider or the configured model, for example
 *   because the user also lists `git:github.com/zmfkzj/pi-images` in `providerExtensions` (that extension
 *   registers the same provider id). `ModelRuntime.registerProvider` would otherwise merge the second
 *   registration over the first, silently replacing the extension's provider. This makes the helper
 *   idempotent, so it can run on every assignment.
 * - `createProviderConfig` reads cliproxyapi.json / auth.json from `agentDir` (and env), so it is only called
 *   when it registers. The returned config keeps `agentDir`, so requests resolve credentials at call time.
 *
 * Call it after the `providerExtensions` load, so a provider that an extension registered is seen.
 */
export function ensureBundledImageProvider(options: { runtime: BundledImageProviderRuntime; images: ImageSettings | undefined; agentDir: string }): boolean {
  const { runtime, images, agentDir } = options;
  if (!images) return false;
  const slash = images.model.indexOf("/");
  if (slash <= 0 || images.model.slice(0, slash) !== PROVIDER_ID) return false;
  if (runtime.getProvider(PROVIDER_ID) || runtime.getModelOfType("image", PROVIDER_ID, images.model.slice(slash + 1))) return false;
  runtime.registerProvider(PROVIDER_ID, createProviderConfig({ agentDir }));
  return true;
}
