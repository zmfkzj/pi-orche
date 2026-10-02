/**
 * The single orche module that imports the bundled CLIProxyAPI image provider (`cliproxyapi-images`).
 *
 * Source: the `pi-gateway-images` package (github.com/zmfkzj/pi-images), a git dependency of pi-orche, so a
 * plain `pi install git:github.com/zmfkzj/pi-orche` brings the provider along (`npm install --omit=dev
 * --legacy-peer-deps` puts it in node_modules; its Pi peers stay host-provided and are not installed).
 *
 * The package ships TypeScript source only (no build step, no `main`/`exports`), so the bare specifier
 * `pi-gateway-images` does not resolve; the explicit `src/index.ts` deep specifier does. That is the file the
 * package itself declares as its Pi extension entry. It loads as is in:
 * - Pi's jiti extension loader (transpiles .ts inside node_modules, maps host packages to Pi's own copies),
 * - vitest (vite-node inlines .ts from node_modules, so no `server.deps.inline` is needed),
 * - tsc (needs `allowImportingTsExtensions`, set in tsconfig.json; the source also passes orche's strict flags).
 *
 * Everything else in orche imports the provider from here, never from `pi-gateway-images` directly, so a
 * change of entry point (for example a future `exports` map) is a one-line change in this file.
 */
export { createProviderConfig, MODEL_ID, PROVIDER_ID } from "pi-gateway-images/src/index.ts";
export type { ConnectionOptions } from "pi-gateway-images/src/index.ts";
export type { ProviderConfig } from "@earendil-works/pi-coding-agent";
