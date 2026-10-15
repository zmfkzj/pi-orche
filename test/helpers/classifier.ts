import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One classify() call the fake saw. */
export interface ClassifierCall { provider: string; id: string; context: ClassifierContext; signal?: AbortSignal }
/** What the fake answers: a verdict, a whole result, or a thrown error; may wait (e.g. on the signal). */
export type ClassifierAnswer = "yes" | "no" | ClassifierResult | Error;
export interface FakeClassifier {
  calls: ClassifierCall[];
  /** Default: every Bash review answers yes. */
  answer: (call: ClassifierCall) => ClassifierAnswer | Promise<ClassifierAnswer>;
  /** Provider/id pairs that resolve to the fake model (default: Jev, `typesafe/jev-latest`). */
  models: Set<string>;
}

/**
 * Test-only stand-in for the Bash safety review's classifier (src/extension/bash-review.ts): `getModelOfType("classifier", ...)`
 * resolves the listed models to a fake catalog entry and `classify` answers from `answer`, without any network. Everything else
 * goes to the runtime's own methods. Installed by the extension harness on its runtimes (default answer yes).
 */
export function createFakeClassifier(fake: Partial<FakeClassifier> = {}): FakeClassifier {
  return { calls: [], answer: () => "yes", models: new Set(["typesafe/jev-latest"]), ...fake };
}
/** Install `state` (one fake can serve several runtimes, e.g. main's and the workers'). */
export function installFakeClassifier(runtime: ModelRuntime, state: FakeClassifier = createFakeClassifier()): FakeClassifier {
  const getModelOfType = runtime.getModelOfType.bind(runtime);
  const classify = runtime.classify.bind(runtime);
  const fakeModel = (provider: string, id: string) => ({ type: "classifier", provider, id, name: `fake ${id}`, api: "fake-classifier", input: ["text"], contextWindow: 100_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  runtime.getModelOfType = ((type: string, provider: string, id: string) =>
    type === "classifier" && state.models.has(`${provider}/${id}`) ? fakeModel(provider, id) : getModelOfType(type as never, provider, id)) as ModelRuntime["getModelOfType"];
  runtime.classify = (async (model, context, options) => {
    if (!state.models.has(`${model.provider}/${model.id}`)) return classify(model, context, options);
    const call: ClassifierCall = { provider: model.provider, id: model.id, context, ...(options?.signal ? { signal: options.signal } : {}) };
    state.calls.push(call);
    const answer = await state.answer(call);
    if (answer instanceof Error) throw answer;
    if (typeof answer !== "string") return answer;
    return {
      api: "fake-classifier", provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      answers: { run: { type: "choice", choice: answer, probabilities: { yes: answer === "yes" ? 0.9 : 0.1, no: answer === "no" ? 0.9 : 0.1 }, confidence: 0.9 } },
    } as ClassifierResult;
  }) as ModelRuntime["classify"];
  return state;
}
