import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

type Registration = NonNullable<ReturnType<ModelRegistry["getRegisteredNativeProvider"]>> | NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>;
const registration = (registry: ModelRegistry | ModelRuntime, id: string): Registration | undefined =>
  registry.getRegisteredNativeProvider(id) ?? registry.getRegisteredProviderConfig(id);

/**
 * Carry host provider registrations (including OAuth/stream wrappers) into the worker runtime.
 * SDK sessions already stream through that runtime, including compaction; replacing agent.streamFn
 * would bypass SDK request hooks and leave compaction on a different path.
 *
 * Only public APIs; no extension reloading, credential copying, or compat/global registry mutation.
 * Explicit worker registrations win. Track only registrations we own so updates/removals in the
 * host are reflected at the next assignment without removing a provider installed by someone else.
 */
export class InheritedProviders {
  private readonly inherited = new Map<string, { source: Registration; installed: Registration }>();

  sync(runtime: ModelRuntime, host: ModelRegistry): void {
    const ids = new Set(host.getRegisteredProviderIds());
    for (const [id, previous] of this.inherited) {
      if (registration(runtime, id) !== previous.installed) {
        this.inherited.delete(id);
      } else if (!ids.has(id)) {
        runtime.unregisterProvider(id);
        this.inherited.delete(id);
      }
    }
    for (const id of ids) {
      const source = registration(host, id);
      if (!source) continue;
      const previous = this.inherited.get(id);
      if (previous?.source === source) continue;
      if (!previous && registration(runtime, id)) continue;
      // Legacy registration merges fields, so remove our old copy first to avoid stale wrappers.
      if (previous) runtime.unregisterProvider(id);
      const native = host.getRegisteredNativeProvider(id);
      if (native) runtime.registerNativeProvider(native);
      else runtime.registerProvider(id, host.getRegisteredProviderConfig(id)!);
      this.inherited.set(id, { source, installed: registration(runtime, id)! });
    }
  }
}
