/**
 * Runs as Pi 1.2.0+ starts them (docs/extensions.md "Events and concurrency"): before_agent_start fires for every run that starts
 * while idle, also one a triggerTurn message starts (`messageType: "custom"`), and the session counts as busy while a run starts
 * (compaction check and before_agent_start included). Pi-orche's prompt section, one-shot requests and the notice about interrupted
 * jobs against that. Models are faux providers; Pi sessions are real.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage as reply, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { busyRefusal } from "../../src/extension/index.js";
import { JOB_ENTRY_TYPE, type JobEntry } from "../../src/extension/jobs.js";
import { deferred } from "../helpers/faux.js";
import { createHarness, tool, type Harness } from "./harness.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
});

type Messages = Parameters<typeof getCurrentSystemPrompt>[0];
const SINGLE_HEAD = "orche mode: single.";
const INTERRUPTED = "still running when the previous pi process ended";
const notes = (h: Harness) => h.notifications.map(note => note.message);
const modeStatus = (h: Harness) => h.statuses.filter(status => status.key === "orche-mode").at(-1)?.text;
/** System messages that carry pi-orche's prompt section (Pi's recorded prompt and patches, or one orche added for a request). */
const delegationEntries = (messages: readonly unknown[]) => messages.filter(message => {
  const { role, sections } = message as { role?: string; sections?: Record<string, unknown> };
  return role === "system" && sections !== undefined && "orche-delegation" in sections;
}).length;
const occurrences = (text: string, part: string) => text.split(part).length - 1;
/** A wake like a session-bus peer note: a custom message that starts a run of its own while main is idle. */
const wake = (h: Harness, content = "From another session: please inspect greeting.txt") =>
  h.session.sendCustomMessage({ customType: "peer-note", content, display: true }, { triggerTurn: true });

/** Holds main's first run in its start (before_agent_start, after pi-orche's handler) until `gate` resolves. */
function holdFirstStart() {
  const entered = deferred();
  const gate = deferred();
  let first = true;
  const extension: ExtensionFactory = pi => {
    pi.on("before_agent_start", async () => {
      if (!first) return undefined;
      first = false;
      entered.resolve();
      await gate.promise;
      return undefined;
    });
  };
  return { entered, gate, extension };
}

describe("runs as Pi 1.2.0+ starts them", () => {
  it("a run a triggerTurn message starts gets the section of the mode at its start; its later requests carry it once and pi-orche adds none", async () => {
    const contexts: Messages[] = [];
    const h = await createHarness({
      mainSteps: [
        context => { contexts.push([...context.messages]); return tool("orche_task", { role: "explore", request: "Inspect greeting.txt", wait: true }); },
        context => { contexts.push([...context.messages]); return reply("relayed"); },
      ],
      orcheSteps: [tool("report_result", { kind: "explore", summary: "Inspected" })],
      mainMode: "single", single: { spawn: false },
    });
    open.push(h);
    await wake(h);
    await h.session.agent.waitForIdle();
    expect(contexts).toHaveLength(2);
    const recorded = delegationEntries(h.session.messages);
    expect(recorded).toBe(1);
    for (const messages of contexts) {
      const prompt = getCurrentSystemPrompt(messages);
      expect(occurrences(prompt, "<orche-delegation>")).toBe(1);
      expect(prompt).toContain(SINGLE_HEAD);
      // The section Pi recorded at the run's start is current: no request-local copy (context_with_system) is added.
      expect(delegationEntries(messages)).toBe(recorded);
    }
  });

  it("while main's run is starting the session is busy: a one-shot /orche request is refused and the starting run is unaffected", async () => {
    const hold = holdFirstStart();
    const h = await createHarness({
      mainSteps: [reply("first done")], orcheSteps: [], mainMode: "single",
      models: { "strong-orchestrator": { model: "strong-orch/s1" } }, extraExtensions: [hold.extension],
    });
    open.push(h);
    const first = h.session.prompt("first");
    await hold.entered.promise;
    expect(h.session.isIdle).toBe(false);
    await h.session.prompt("/orche strong second request");
    expect(notes(h).at(-1)).toBe(busyRefusal("strong", "single"));
    hold.gate.resolve();
    await first;
    await h.session.agent.waitForIdle();
    expect(h.main.faux.state.callCount).toBe(1);
    expect(modeStatus(h)).toBe("orche: single");
    expect(JSON.stringify(h.session.messages)).not.toContain("second request");
  });

  it("Esc while a one-shot run is starting: the run ends without an answer, the one-shot ends and a follow-up queued meanwhile goes back", async () => {
    const hold = holdFirstStart();
    const h = await createHarness({
      mainSteps: [reply("NEVER-ANSWERED"), reply("NEVER-ANSWERED")], orcheSteps: [], mainMode: "single",
      models: { "strong-orchestrator": { model: "strong-orch/s1" } }, extraExtensions: [hold.extension],
    });
    open.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    const run = h.session.prompt("/orche strong A: inspect greeting.txt");
    await hold.entered.promise;
    expect(modeStatus(h)).toBe("orche: single (one-turn strong)");
    await h.session.followUp("B: and check it again");
    expect(notes(h).at(-1)).toBe("orche: queued until the one-shot /orche strong request has ended; it then runs as its own turn in the session's mode (single).");
    const aborting = h.session.abort();
    hold.gate.resolve();
    await aborting;
    await run;
    await h.session.agent.waitForIdle();
    expect(JSON.stringify(h.session.messages)).not.toContain("NEVER-ANSWERED");
    expect(JSON.stringify(h.session.messages)).not.toContain("B: and check it again");
    expect(notes(h)).toContain("orche: the one-shot run was aborted; the prompt queued during it was not sent (back in the editor).");
    expect(modeStatus(h)).toBe("orche: single");
    // The session is idle again.
    expect(h.session.isIdle).toBe(true);
  });

  it("the notice about jobs a crash interrupted goes with the next run of either kind, once: here a run a triggerTurn message starts", async () => {
    const contexts: string[] = [];
    const h = await createHarness({
      mode: "tui", mainMode: "single", orcheSteps: [],
      mainSteps: [context => { contexts.push(JSON.stringify(context.messages)); return reply("noted"); }, context => { contexts.push(JSON.stringify(context.messages)); return reply("ok"); }],
    });
    open.push(h);
    h.session.sessionManager.appendCustomEntry(JOB_ENTRY_TYPE, { event: "start", job: "J5", role: "explore", worker: "W4", at: Date.now() - 60_000, request: "look", sessionFile: "/nowhere/W4.jsonl" } satisfies JobEntry);
    await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" } as never);
    await wake(h);
    await h.session.agent.waitForIdle();
    await h.session.prompt("anything else?");
    expect(contexts).toHaveLength(2);
    expect(occurrences(contexts[0]!, INTERRUPTED)).toBe(1);
    // Taken once: the next run (a user prompt) sees it only as history.
    expect(occurrences(contexts[1]!, INTERRUPTED)).toBe(1);
    expect(h.session.messages.filter(message => (message as { customType?: string }).customType === "orche-job-interrupted")).toHaveLength(1);
  });
});
