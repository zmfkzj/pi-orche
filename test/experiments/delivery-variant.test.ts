// Variant selection and role-based effort of the delivery runtime (results/delivery-validation-high/protocol.md §3-§4): the default is
// the completed max study unchanged; DELIVERY_VARIANT=effort-high reads the max study's frozen inputs/pins/provider in place, writes
// only into its own namespace, runs measured turns at high and keeps instruments at max. No model is called.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effortOk, variantOf, verifyCached, withThinking, type Turn, type TurnSpec } from "../../experiments/mdsd-ab/delivery-runtime.js";
import { sha } from "../../experiments/mdsd-ab/run.js";

const REPO = join(__dirname, "../..");
const load = async (variant: string | undefined) => {
  vi.resetModules();
  if (variant === undefined) delete process.env.DELIVERY_VARIANT; else process.env.DELIVERY_VARIANT = variant;
  const runtime = await import("../../experiments/mdsd-ab/delivery-runtime.js"), delivery = await import("../../experiments/mdsd-ab/delivery.js"), evaluation = await import("../../experiments/mdsd-ab/delivery-eval.js");
  return { runtime, delivery, evaluation };
};
afterEach(() => { delete process.env.DELIVERY_VARIANT; vi.resetModules(); });

describe("study variants", () => {
  it("defaults to the completed max study and accepts only the effort-high replication", () => {
    expect(variantOf(undefined)).toEqual({ name: "max", root: "results/delivery-validation", inputs: "results/delivery-validation", measuredEffort: "max", sessionPrefix: "dv", baseline: undefined });
    expect(variantOf("")).toMatchObject({ name: "max", measuredEffort: "max" });
    expect(variantOf("effort-high")).toEqual({ name: "effort-high", root: "results/delivery-validation-high", inputs: "results/delivery-validation", measuredEffort: "high", sessionPrefix: "dvh", baseline: "results/delivery-validation" });
    expect(() => variantOf("ultra")).toThrow(/unknown DELIVERY_VARIANT/);
    expect(() => variantOf("toString")).toThrow(/unknown DELIVERY_VARIANT/);
  });
  it("keeps every path and effort of the max study by default", async () => {
    const { runtime, delivery, evaluation } = await load(undefined);
    expect(runtime.ROOT).toBe(join(REPO, "results/delivery-validation"));
    expect(runtime.INPUT_ROOT).toBe(runtime.ROOT);
    expect(runtime.PINS).toBe(join(REPO, "results/delivery-validation/pins"));
    expect(runtime.PROVIDER).toBe(join(REPO, "results/delivery-validation/runtime/provider"));
    expect([runtime.MEASURED_EFFORT, runtime.INSTRUMENT_EFFORT]).toEqual(["max", "max"]);
    expect(delivery.ledgerDir("dev-r1.Q-r2")).toBe(join(REPO, "results/delivery-validation/inputs/dev-r1.Q-r2"));
    // the verifier masking sentence of the max study, byte for byte
    const text = evaluation.instructions("P1-1", 1, join(REPO, "results/delivery-validation/adjudication/round-1/packets/P1-1"));
    expect(text).toContain("Do not open anything under results/delivery-validation other than this packet directory (in particular not runs/, judgments/, pairwise/, judge-runs/, pairwise-runs/, preflight/, adjudication/ outside this packet, manifest or score files), and no earlier study's judgments, reports or references.");
  });
  it("replication: own namespace for outputs, the max study's frozen inputs/pins/provider read in place, high measured and max instruments", async () => {
    const { runtime, delivery, evaluation } = await load("effort-high");
    expect(runtime.ROOT).toBe(join(REPO, "results/delivery-validation-high"));
    expect(runtime.INPUT_ROOT).toBe(join(REPO, "results/delivery-validation"));
    expect(runtime.PINS).toBe(join(REPO, "results/delivery-validation/pins"));
    expect(runtime.PROVIDER).toBe(join(REPO, "results/delivery-validation/runtime/provider"));
    expect([runtime.MEASURED_EFFORT, runtime.INSTRUMENT_EFFORT]).toEqual(["high", "max"]);
    expect(delivery.ledgerDir("isort-r1.Q-r2")).toBe(join(REPO, "results/delivery-validation/inputs/isort-r1.Q-r2"));
    expect(evaluation.ADJ).toBe(join(REPO, "results/delivery-validation-high/adjudication"));
    const text = evaluation.instructions("P1-1", 1, join(REPO, "results/delivery-validation-high/adjudication/round-1/packets/P1-1"));
    expect(text).toContain("Do not open anything under results/delivery-validation-high other than this packet directory");
    expect(text).toContain("manifest or score files), nothing under results/delivery-validation/ (an earlier study), and no earlier study's judgments, reports or references.");
    // prompts are the max study's (the replication's input freeze refuses otherwise)
    const maxPrompts = (await import("node:fs")).readFileSync(join(REPO, "results/delivery-validation/manifest.json"), "utf8");
    expect(delivery.promptHashes()).toEqual(JSON.parse(maxPrompts).prompts);
  });
});

describe("role-based effort and identity", () => {
  const argv = ["node", "cli.js", "--model", "cliproxyapi/gpt-6-astra", "--thinking", "max", "--mode", "json", "--session-id", "s", "prompt"];
  it("sets the thinking level of the Pi argument vector without touching anything else", () => {
    const high = withThinking(argv, "high");
    expect(high).toEqual(["node", "cli.js", "--model", "cliproxyapi/gpt-6-astra", "--thinking", "high", "--mode", "json", "--session-id", "s", "prompt"]);
    expect(argv[5]).toBe("max");
    expect(withThinking(argv, "max")).toEqual(argv);
    expect(() => withThinking(["node", "cli.js", "prompt"], "high")).toThrow(/no --thinking/);
  });
  it("accepts a turn only when every request, configuration update and transcript level is at its assigned effort", () => {
    const wire = (effort: string, updates?: string[]) => ({ model: "gpt-6-astra", effort, ...(updates ? { updateEfforts: updates } : {}) });
    expect(effortOk([wire("high"), wire("high", ["high"])], ["high"], "high", false)).toBe(true);
    expect(effortOk([wire("high"), wire("max")], ["high"], "high", false)).toBe(false);
    expect(effortOk([wire("high", ["max"])], ["high"], "high", false)).toBe(false);
    expect(effortOk([wire("high")], ["max", "high"], "high", false)).toBe(false);
    expect(effortOk([wire("max")], ["max"], "max", false)).toBe(true);
    // Claude instrument turns: model identity only on the wire (as in the max study); the transcript level still has to match
    expect(effortOk([{ model: "claude-opus-5-5", effort: "max" }], ["max"], "max", true)).toBe(true);
    expect(effortOk([{ model: "claude-opus-5-5" }], ["high"], "max", true)).toBe(false);
  });
  it("never reuses a cached turn recorded with another model or thinking level", () => {
    const spec: TurnSpec = { session: "/tmp/x", record: "/tmp/x", label: "l", number: 1, model: "cliproxyapi/gpt-6-astra", effort: "high", prompt: "p", inputs: { "a.md": "a" }, guard: 1 };
    const cached = { record: "/tmp/x/turn-1", promptSha256: sha("p"), inputHashes: { "a.md": sha("a") }, model: "cliproxyapi/gpt-6-astra", thinking: "max", sourceHashes: {}, outputHashes: {} } as unknown as Turn;
    expect(() => verifyCached(cached, spec)).toThrow(/cached turn ran cliproxyapi\/gpt-6-astra\/max, not cliproxyapi\/gpt-6-astra\/high/);
    expect(() => verifyCached({ ...cached, model: "cliproxyapi/claude-opus-5-5", thinking: "high" } as Turn, spec)).toThrow(/cached turn ran/);
    // same model and level: the check moves on to the runtime-source comparison (which fails here because the fake records none)
    expect(() => verifyCached({ ...cached, thinking: "high" } as Turn, spec)).toThrow(/measured runtime changed/);
  });
});
