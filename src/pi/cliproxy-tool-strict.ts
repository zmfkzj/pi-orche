/**
 * `strict: null` on the function tools of orche's own sessions on CLIProxyAPI Responses models.
 *
 * pi-cliproxyapi-provider registers its models with `supportsStrictMode: false`, so Pi's Responses tool conversion leaves the
 * `strict` field out, and adds `strict: null` to every function tool in a `before_provider_request` handler of main's session
 * (`codex-compat.ts` `rewriteCodexCompatibleToolPayload`). Orche's worker, sub-worker and advisor sessions do not load that extension,
 * so their tools went out without the field; the proxy then compiles them as strict schemas (CHANGELOG, `task_plan` `uniqueItems`),
 * where every optional property is required. GPT workers on that path sent every optional argument of `read`, `edit` and `task_plan`
 * with a placeholder (`parent: "/"` or the node's own id, `to: ""` beside an insert, `symbol: ""` beside `outline: true`), which the
 * tools rejected; main's sessions on the same models did not. This applies the provider's rule to orche's sessions: same provider
 * and API test, only function tools without a `strict` field, nothing else in the request changes.
 */

/** The provider id pi-cliproxyapi-provider registers (also claude-native.ts `CPA_PROVIDER_ID`). */
const CPA_PROVIDER = "cliproxyapi";

interface ProviderModel { provider?: string; api?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The payload with `strict: null` on each function tool that has no `strict` field, or undefined when nothing changes. */
export function cliproxyToolStrictPayload(payload: unknown, model: ProviderModel | undefined): unknown | undefined {
  if (model?.provider?.trim().toLowerCase() !== CPA_PROVIDER || !model.api?.toLowerCase().includes("responses")) return undefined;
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return undefined;
  let changed = false;
  const tools = payload.tools.map(tool => {
    if (!isRecord(tool) || tool.type !== "function" || "strict" in tool) return tool;
    changed = true;
    return { ...tool, strict: null };
  });
  return changed ? { ...payload, tools } : undefined;
}
