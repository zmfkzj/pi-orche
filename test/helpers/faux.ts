import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  InMemoryCredentialStore,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
let serial = 0;
export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}
export async function fauxRuntime(responses: FauxResponseStep[] = []) {
  const faux = fauxProvider({ provider: `orche-faux-${++serial}` });
  faux.setResponses(responses);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  return {
    runtime,
    faux,
    route: {
      role: "test",
      model: `${faux.provider.id}/${faux.getModel().id}`,
      thinking: "off" as const,
    },
  };
}
