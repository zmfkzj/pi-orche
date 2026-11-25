import { afterEach, describe, expect, it } from "vitest";
import { orcheTaskParameters } from "../../src/extension/workers.js";
import { WORK_TYPE_RULE } from "../../src/single/work-types.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * How main is told to use pi-gui (gui: true) and pi-session-bus through workers: positive triggers instead of "only when ...
 * omit it otherwise", every role may click and type on its private desktop, and investigations still go to answer.
 */
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
});

describe("orche guidance for GUI and session-bus work", () => {
  it("the gui parameter names positive triggers and lets read-only roles interact", () => {
    const gui = (orcheTaskParameters.properties.gui as { description?: string }).description ?? "";
    expect(gui).toContain("Pass it whenever the worker must see or operate a GUI: launching a desktop or Electron app, screenshots as evidence, checking a rendered UI or visual change, reproducing a bug by clicking");
    expect(gui).toContain("Every role can click and type there");
    expect(gui).toContain("a GUI investigation stays answer + gui: true");
    expect(gui).not.toContain("observe-only");
    expect(gui).not.toContain("Set it only when");
    expect(gui).not.toContain("interaction needs role implement");
  });

  it("orche_task's guidelines give GUI triggers, drop the observe-only claim, and describe the workers' own session tools", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], mode: "tui", mainMode: "single" });
    open.push(h);
    const guidelines = (h.session.getToolDefinition("orche_task")?.promptGuidelines ?? []).join("\n");
    expect(guidelines).toContain("Pass `gui: true` (needs pi-gui) whenever the worker must see or operate a GUI");
    expect(guidelines).toContain("Leave it off for work on files, commands and public pages.");
    expect(guidelines).toContain("an investigation that needs clicks stays answer + gui: true");
    expect(guidelines).not.toContain("Omit it otherwise");
    expect(guidelines).not.toContain("observe-only");
    expect(guidelines).not.toContain("needs `gui: true` with a writing role");
    expect(guidelines).toContain("every orche_task worker has its own session_list and session_send: it sends as your session, labelled with its worker id, answers peer notes routed to it itself");
  });

  it("investigations still go to answer (GUI investigations are not forced to implement)", () => {
    expect(WORK_TYPE_RULE).toContain("investigation: orche_task role answer.");
    expect(WORK_TYPE_RULE).not.toMatch(/gui/i);
  });
});
