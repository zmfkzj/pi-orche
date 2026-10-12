import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * A worker capability that another Pi extension provides: `gui` (pi-gui, opt-in per task), `web-fetch` (pi-browser) and
 * `codegraph` (pi-codegraph), the last two asked for every worker. Orche asks on `pi.events` channel {@link WORKER_CAPABILITY_CHANNEL} with a
 * {@link WorkerCapabilityRequest} plus `provide(answer)`; the provider answers synchronously. The answer's extension
 * factories are loaded into that worker's own session only, so whatever they start (an MCP server process, a fetch child)
 * belongs to that worker and stops with its session: nothing of main's own tool instances or state is shared. Orche knows
 * no specifics.
 */
export interface WorkerCapabilityProvider {
  /** Stable description of the configuration: a reused worker whose key differs is replaced by a fresh one. */
  key: string;
  /** Exact tool names the factories register, added to the worker's tool allowlist. */
  tools: string[];
  extensionFactories: ExtensionFactory[];
  /** Appended to the worker's instructions. */
  instructions?: string;
  /** Own timeouts of those tools, for liveness (see KNOWN_TOOL_TIMEOUTS_MS). */
  toolTimeoutsMs?: Record<string, number>;
}
/** `role` is the worker's role; `readOnly` is true for every role that may not write the workspace (answer, explore, verify). */
export interface WorkerCapabilityRequest { capability: string; cwd: string; workerId?: string; role?: string; readOnly?: boolean }
/** Undefined: nobody provides the capability. */
export type WorkerCapabilityAnswer = WorkerCapabilityProvider | { error: string } | undefined;
export const WORKER_CAPABILITY_CHANNEL = "orche:worker-capability";
/** Stateless public-web reading (pi-browser's `browser_fetch`), asked for every worker and sub-worker. */
export const WEB_FETCH_CAPABILITY = "web-fetch";
/** The project's CodeGraph code graph (pi-codegraph's MCP tools in the worker's own session), asked for every worker and sub-worker. */
export const CODEGRAPH_CAPABILITY = "codegraph";
/**
 * The capabilities of one worker session, merged: their tools, factories, instructions and tool timeouts. Factories are
 * merged by identity: providers that need the same shared factory (Pi's MCP extension for the worker, see pi-gui and
 * pi-codegraph) hand over one object, which loads once.
 */
export function mergeCapabilities(providers: readonly (WorkerCapabilityProvider | undefined)[]): { tools: string[]; extensionFactories: ExtensionFactory[]; instructions: string[]; toolTimeoutsMs: Record<string, number> } {
  const present = providers.filter((provider): provider is WorkerCapabilityProvider => !!provider);
  return {
    tools: [...new Set(present.flatMap(provider => provider.tools))],
    extensionFactories: [...new Set(present.flatMap(provider => provider.extensionFactories))],
    instructions: present.flatMap(provider => provider.instructions ? [provider.instructions] : []),
    toolTimeoutsMs: Object.assign({}, ...present.map(provider => provider.toolTimeoutsMs ?? {})) as Record<string, number>,
  };
}
/** Ask for a capability asked for every worker: the provider's answer, or why there is none (absent: no provider at all). */
export function askCapability(capability: string, ask: ((request: WorkerCapabilityRequest) => WorkerCapabilityAnswer) | undefined, request: Omit<WorkerCapabilityRequest, "capability">): { provider?: WorkerCapabilityProvider; unavailable?: string } {
  const answer = ask?.({ capability, ...request });
  if (!answer) return {};
  return "error" in answer ? { unavailable: answer.error } : { provider: answer };
}
/** Ask for the web-fetch capability: the provider's answer, or why there is none (absent: no provider at all, e.g. no pi-browser). */
export function webFetchCapability(ask: ((request: WorkerCapabilityRequest) => WorkerCapabilityAnswer) | undefined, request: Omit<WorkerCapabilityRequest, "capability">): { provider?: WorkerCapabilityProvider; unavailable?: string } {
  return askCapability(WEB_FETCH_CAPABILITY, ask, request);
}
/** Ask for the codegraph capability (absent: no pi-codegraph, or the user turned CodeGraph off). */
export function codeGraphCapability(ask: ((request: WorkerCapabilityRequest) => WorkerCapabilityAnswer) | undefined, request: Omit<WorkerCapabilityRequest, "capability">): { provider?: WorkerCapabilityProvider; unavailable?: string } {
  return askCapability(CODEGRAPH_CAPABILITY, ask, request);
}
