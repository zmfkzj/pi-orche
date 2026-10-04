import { describe, expect, it } from "vitest";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { delegationRules } from "../../src/extension/mode.js";
import { createHarness } from "./harness.js";

describe("delegation by reference", () => {
  it("keeps single rules byte-stable and asks for references, not copies", () => {
    const mode = "single" as const;
    const rules = delegationRules(mode);
    expect(delegationRules(mode)).toBe(rules);
    expect(rules).toContain("Pass references, not copies");
    expect(rules).toContain("line ranges or symbol names");
    expect(rules).toContain("reproduction commands, artifact and run-record paths");
    expect(rules).toContain("an exact error line or user-provided text");
    expect(rules).toContain("never whole files, diffs or long logs");
    expect(delegationRules("direct")).not.toContain("Pass references");
  });

  it("exposes reference-only delegation guidance in tool descriptions and request/context schemas", async () => {
    const h = await createHarness({ mainSteps: [reply("Inspected")], orcheSteps: [] });
    try {
      await h.session.prompt("Inspect guidance");
      expect(h.session.getToolDefinition("orche_run")).toBeUndefined();
      for (const name of ["orche_task"]) {
        const tool = h.session.getToolDefinition(name);
        expect(tool?.description).toContain("Pass references, not copies");
        expect(tool?.description).toContain("never whole files, diffs or long logs");
        const parameters = tool?.parameters as { properties: Record<string, { description?: string }> };
        expect(parameters.properties.request?.description).toContain("Pass references, not copies");
        expect(parameters.properties.context?.description).toContain("Pass references, not copies");
        expect(parameters.properties.context?.description).not.toContain("file excerpts");
      }
    } finally { await h.dispose(); }
  });
});
