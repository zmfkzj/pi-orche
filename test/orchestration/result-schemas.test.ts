import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";

describe.each(["game-asset", "video"])("%s result schema", kind => {
  const contract = orchestrationResultSchemas[kind]!;
  const output = { path: "assets/deliverable.svg", type: "image/svg+xml", spec: "32x32 SVG icon" };

  it("accepts complete and blocked reports", () => {
    expect(contract.optional).not.toBe(true);
    expect(Value.Check(contract.schema, { status: "done", outputs: [output], evidence: ["validated output"] })).toBe(true);
    expect(Value.Check(contract.schema, { status: "blocked", reason: "ffmpeg unavailable", outputs: [], evidence: ["command -v ffmpeg: not found"] })).toBe(true);
  });

  it.each([
    undefined,
    {},
    { status: "done" },
    { outputs: [] },
    { status: "unknown", outputs: [] },
    { status: "done", reason: 42, outputs: [] },
    { status: "done", outputs: "asset.png" },
    { status: "done", outputs: [{ path: "asset.png", type: "image/png" }] },
    { status: "done", outputs: [{ ...output, path: "" }] },
    { status: "done", outputs: [{ ...output, type: 42 }] },
    { status: "done", outputs: [{ ...output, spec: {} }] },
  ])("rejects malformed data %j", data => {
    expect(Value.Check(contract.schema, data)).toBe(false);
  });
});
