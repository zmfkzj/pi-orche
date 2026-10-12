import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AnyModel, AuthResult } from "@earendil-works/pi-ai";
import { abortable } from "../orchestration/run/deadline.js";

type Registration = NonNullable<ReturnType<ModelRegistry["getRegisteredNativeProvider"]>> | NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>;
const registration = (registry: ModelRegistry | ModelRuntime, id: string): Registration | undefined =>
  registry.getRegisteredNativeProvider(id) ?? registry.getRegisteredProviderConfig(id);

/**
 * Mirror Pi's complete catalog, not just extension registrations. Requests for inherited providers
 * go through the host's public registry: OAuth, ambient auth, runtime keys and models.json remain
 * Pi's responsibility. Worker-only registrations still use the isolated runtime and win by id.
 * No extension reload, credential persistence, private SDK fields or global registry mutation.
 */
export class InheritedProviders {
  private readonly inherited = new Map<string, { source: Registration; installed: Registration }>();
  private host?: ModelRegistry;
  private view?: ModelRuntime;
  private target?: ModelRuntime;

  sync(runtime: ModelRuntime, host: ModelRegistry): ModelRuntime {
    this.host = host;
    const ids = new Set([
      ...host.getRegisteredProviderIds(),
      ...(["chat", "image", "classifier"] as const).flatMap(type => host.getModelsOfType(type).map(model => model.provider)),
    ]);
    for (const [id, previous] of this.inherited) {
      if (registration(runtime, id) !== previous.installed) {
        this.inherited.delete(id);
      } else if (!ids.has(id)) {
        runtime.unregisterProvider(id);
        this.inherited.delete(id);
      }
    }
    for (const id of ids) {
      // A composed provider includes builtin catalogs and models.json overlays, including providers
      // with no registerProvider call. Never register it back into the host when an SDK shares it.
      const source = host.getProvider(id);
      if (!source || source === runtime.getProvider(id)) continue;
      const previous = this.inherited.get(id);
      if (previous?.source === source) continue;
      if (!previous && registration(runtime, id)) continue;
      if (previous) runtime.unregisterProvider(id);
      // The host owns discovery/refresh. Refreshing its provider from a second runtime can overwrite
      // its live catalog with the worker's cache/credentials. Only mirror its synchronous catalog.
      runtime.registerNativeProvider({
        id: source.id, name: source.name, auth: source.auth, baseUrl: source.baseUrl, headers: source.headers,
        getModels: source.getModels.bind(source), getAllModels: source.getAllModels?.bind(source),
        filterModels: source.filterModels?.bind(source), filterAllModels: source.filterAllModels?.bind(source),
        stream: source.stream.bind(source), streamSimple: source.streamSimple.bind(source),
        generateImages: source.generateImages?.bind(source), classify: source.classify?.bind(source),
        fetchDeferred: source.fetchDeferred?.bind(source), cancelDeferred: source.cancelDeferred?.bind(source),
      });
      this.inherited.set(id, { source, installed: registration(runtime, id)! });
    }
    if (this.target !== runtime) {
      this.target = runtime;
      this.view = this.createView(runtime);
    }
    return this.view!;
  }

  private createView(runtime: ModelRuntime): ModelRuntime {
    const owns = (id: string) => {
      const entry = this.inherited.get(id);
      return !!entry && registration(runtime, id) === entry.installed;
    };
    const getAuth: ModelRuntime["getAuth"] = async (providerOrModel: string | AnyModel, options = {}): Promise<AuthResult | undefined> => {
      options.signal?.throwIfAborted();
      const id = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
      if (!owns(id)) return typeof providerOrModel === "string" ? runtime.getAuth(providerOrModel, options) : runtime.getAuth(providerOrModel, options);
      // This supplies SDK auth/status checks and compaction. The actual request is delegated below
      // and resolves all model-specific headers, credential refresh and request overrides in Pi.
      const auth = await abortable(this.host!.getProviderAuth(id), options.signal);
      options.signal?.throwIfAborted();
      return auth;
    };
    const stream: ModelRuntime["stream"] = (model, context, options) =>
      owns(model.provider) ? this.host!.stream(model, context, options) : runtime.stream(model, context, options);
    const streamSimple: ModelRuntime["streamSimple"] = (model, context, options) =>
      owns(model.provider) ? this.host!.streamSimple(model, context, options) : runtime.streamSimple(model, context, options);
    const catalog: ModelRuntime["getModelsOfType"] = (type, id) => {
      if (id) return owns(id) ? this.host!.getModelsOfType(type, id) : runtime.getModelsOfType(type, id);
      return [...this.host!.getModelsOfType(type).filter(model => owns(model.provider)), ...runtime.getModelsOfType(type).filter(model => !owns(model.provider))];
    };
    const isUsingOAuth = (id: string) => {
      const model = this.host!.getModelsOfType("chat", id)[0];
      return owns(id) && model ? this.host!.isUsingOAuth(model) : runtime.isUsingOAuth(id);
    };
    const available: ModelRuntime["getAvailableOfType"] = async (type, id, options) => {
      if (id) return owns(id) ? this.host!.getAvailableOfType(type, id, options) : runtime.getAvailableOfType(type, id, options);
      const [host, local] = await Promise.all([this.host!.getAvailableOfType(type, undefined, options), runtime.getAvailableOfType(type, undefined, options)]);
      return [...host.filter(model => owns(model.provider)), ...local.filter(model => !owns(model.provider))];
    };
    const methods: Partial<ModelRuntime> = {
      getModel: (id, model) => owns(id) ? this.host!.find(id, model) : runtime.getModel(id, model),
      getModelOfType: (type, id, model) => owns(id) ? this.host!.getModelOfType(type, id, model) : runtime.getModelOfType(type, id, model),
      getModelsOfType: catalog,
      getModels: id => catalog("chat", id),
      getAllModels: id => (["chat", "image", "classifier"] as const).flatMap(type => catalog(type, id)),
      getProvider: id => owns(id) ? this.host!.getProvider(id) : runtime.getProvider(id),
      getProviders: () => runtime.getProviders().flatMap(provider => {
        const current = owns(provider.id) ? this.host!.getProvider(provider.id) : provider;
        return current ? [current] : [];
      }),
      getAuth,
      hasConfiguredAuth: id => owns(id) ? this.host!.getProviderAuthStatus(id).configured : runtime.hasConfiguredAuth(id),
      getProviderAuthStatus: id => owns(id) ? this.host!.getProviderAuthStatus(id) : runtime.getProviderAuthStatus(id),
      isUsingOAuth,
      isUsingSubscription: id => owns(id) ? isUsingOAuth(id) && this.host!.getProvider(id)?.auth.oauth?.isSubscription === true : runtime.isUsingSubscription(id),
      getAvailableSnapshot: () => [...this.host!.getAvailable().filter(model => owns(model.provider)), ...runtime.getAvailableSnapshot().filter(model => !owns(model.provider))],
      getAvailableOfType: available,
      getAvailable: async (id, options) => [...await available("chat", id, options)],
      getAllAvailable: async (id, options) => (await Promise.all((["chat", "image", "classifier"] as const).map(type => available(type, id, options)))).flat(),
      checkAuth: async (id, options) => {
        if (!owns(id)) return runtime.checkAuth(id, options);
        options?.signal?.throwIfAborted();
        const auth = await abortable(this.host!.getProviderAuth(id), options?.signal);
        options?.signal?.throwIfAborted();
        return auth ? { type: isUsingOAuth(id) ? "oauth" : "api_key", source: auth.source } : undefined;
      },
      stream,
      streamSimple,
      complete: (model, context, options) => stream(model, context, options).result(),
      completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
      generateImages: (model, context, options) => owns(model.provider) ? this.host!.generateImages(model, context, options) : runtime.generateImages(model, context, options),
      classify: (model, context, options) => owns(model.provider) ? this.host!.classify(model, context, options) : runtime.classify(model, context, options),
    };
    // Keep a stable runtime identity for the pool, advisors, sub-workers and reused sessions. Bind
    // unhandled public methods to their real instance; do not access ModelRuntime's private state.
    return new Proxy(runtime, {
      get(target, key) {
        const value = Object.hasOwn(methods, key) ? Reflect.get(methods, key) : Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
