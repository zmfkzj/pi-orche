import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { delegationRules } from "../../src/extension/mode.js";
import { createHarness, tool } from "./harness.js";

// Literal output captured from git HEAD (188eb4ec4fdf1d773989e5987423c727a5d8a3f9) before this change.
// Do not derive these snapshots from the implementation under test.
const PRE_CHANGE_RULES = {
  direct: "orche mode: direct. Delegation tools are disabled; make changes directly with your own tools. You may edit user-requested paths outside the cwd/workspace, including absolute paths and ../ paths. Delegated workers' workspace confinement does not restrict this main direct session; their scope remains unchanged. Existing OS permissions and other policies still apply; direct mode does not grant elevated OS privileges or bypass those restrictions.",
} as const;


describe("single mode does the work", () => {
  it.each(["direct"] as const)("keeps %s rules byte-identical to pre-change HEAD", mode => {
    expect(delegationRules(mode)).toBe(PRE_CHANGE_RULES[mode]);
  });

  it("requires requirements refinement and one end-to-end assignment without stopping for a mode switch", () => {
    const rules = delegationRules("single");
    for (const instruction of [
      "refine the requirements with the user: goal, constraints and acceptance criteria",
      "Inspect only what is needed to state the task precisely",
      "Do not explore or implement the codebase yourself",
      "Ask the user only about decisions you cannot reasonably make",
      "without a UI, make a reasonable assumption and state it in the request and final report",
      "ONE orche_task in ONE end-to-end assignment",
      "role implement for changes, answer for read-only questions",
      "even when it is large or risky",
      "Do not split the task into explore/implement/verify phases",
      "never send an explore before an implement for the same request",
      "Never stop to ask the user to switch modes in order to proceed",
      "never end a turn without attempting the requested change because of its size or risk",
      "The worker owns the whole task end to end",
      "problems and user follow-ups go to the SAME worker (pass its id in `worker`)",
      "Read the report: its checklist, the checks it names and the readings it chose; do not re-read the changed code or re-run the project checks to verify it yourself",
      "Send a separate verify assignment only when the user",
      "This workflow is the same with and without a UI",
    ]) expect(rules).toContain(instruction);
    // Role listings and prohibitions are not instructions to dispatch exploration or verification.
    const withoutProhibitions = rules
      .replace("Never stop to ask the user to switch modes in order to proceed", "")
      .replaceAll("Do not split the task into explore/implement/verify phases, and never send an explore before an implement for the same request.", "")
      .replace(/Send a separate verify assignment only when the user[^.]*\./, "");
    expect(withoutProhibitions).not.toMatch(/ask the user to switch|prefer multi|never split|Multi criteria:|Judgment before Production|start with explore|explore first|explore before|dispatch.*verify/);
    expect(rules).toContain("creates a Task DAG with task_plan and executes nodes sequentially without main intervention");
    expect(delegationRules("single")).toBe(rules);
  });

  it.each(["print", "tui"] as const)("delegates once end to end, accepts with main-run checks and finishes in %s", async mode => {
    const h = await createHarness({
      mainMode: "single", mode,
      mainSteps: [
        context => {
          const system = JSON.stringify(context.messages.find(message => message.role === "system"));
          expect(system).toContain("ONE orche_task in ONE end-to-end assignment");
          expect(system).not.toContain("Judgment before Production");
          return tool("orche_task", {
            role: "implement",
            request: "Goal: change greeting.txt to fixed and add extra.txt. Acceptance: greeting.test.cjs passes. Assumption: extra.txt is plain text. Return evidence and checks.",
            files: ["greeting.txt", "extra.txt", "greeting.test.cjs"],
          });
        },
        context => {
          expect(JSON.stringify(context.messages.findLast(message => message.role === "toolResult"))).toContain("Worker checks passed");
          return tool("read", { path: "greeting.test.cjs" });
        },
        tool("bash", { command: "node --test greeting.test.cjs" }),
        reply("Both units completed; worker and main checks passed. Assumption: extra.txt is plain text."),
      ],
      orcheSteps: [
        context => {
          expect(JSON.stringify(context.messages)).toContain("Own the task end to end");
          return tool("read", { path: "greeting.txt" });
        },
        tool("write", { path: "greeting.txt", content: "first attempt\n" }),
        tool("write", { path: "extra.txt", content: "second unit\n" }),
        tool("write", { path: "greeting.test.cjs", content: "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { readFileSync } = require('node:fs');\ntest('greeting', () => assert.equal(readFileSync('greeting.txt', 'utf8'), 'fixed\\n'));\n" }),
        tool("bash", { command: "node --test greeting.test.cjs" }),
        context => {
          expect(JSON.stringify(context.messages.findLast(message => message.role === "toolResult"))).toContain("fail");
          return tool("write", { path: "greeting.txt", content: "fixed\n" });
        },
        tool("bash", { command: "node --test greeting.test.cjs" }),
        context => {
          expect(JSON.stringify(context.messages.findLast(message => message.role === "toolResult"))).toContain("pass 1");
          return tool("report_result", { kind: "implement", summary: "Both units completed. Worker checks passed: node --test greeting.test.cjs; evidence greeting.test.cjs:4.", data: { status: "done", evidence: ["node --test greeting.test.cjs: passed"] } });
        },
      ],
    });
    try {
      await h.session.prompt("Implement a large, risky multi-module change with separate acceptance for two units");
      const results = h.session.messages.filter(message => message.role === "toolResult");
      const assignments = results.filter(result => result.toolName === "orche_task");
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({ isError: false, details: { worker: "W1", role: "implement" } });
      expect(results.map(result => result.toolName)).toEqual(["orche_task", "read", "bash"]);
      expect(results.at(-1)).toMatchObject({ isError: false });
      expect(JSON.stringify(results.at(-1))).toContain("pass 1");
      expect(JSON.stringify(results)).not.toContain("consider orche_run");
      expect(h.session.getLastAssistantText()).toContain("Both units completed");
      expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("fixed\n");
      expect(await readFile(join(h.cwd, "extra.txt"), "utf8")).toBe("second unit\n");
      expect(h.main.faux.getPendingResponseCount()).toBe(0);
      expect(h.orche.faux.getPendingResponseCount()).toBe(0);
      expect(h.notifications.some(note => /switch.*mode/.test(note.message))).toBe(false);
    } finally { await h.dispose(); }
  });

  it("sends problems and later user follow-ups to the same worker with retained context", async () => {
    const h = await createHarness({
      mainMode: "single",
      mainSteps: [
        tool("orche_task", { role: "implement", request: "Change greeting.txt", files: ["greeting.txt"] }),
        tool("orche_task", { role: "implement", worker: "W1", request: "Problem: greeting must say fixed", files: ["greeting.txt"] }),
        reply("Fixed"),
        tool("orche_task", { role: "implement", worker: "W1", request: "User follow-up: add extra.txt", files: ["extra.txt"] }),
        reply("Follow-up completed"),
      ],
      orcheSteps: [
        tool("report_result", { kind: "implement", summary: "Blocked", data: { status: "blocked", reason: "wording unclear" } }),
        context => {
          const history = JSON.stringify(context.messages);
          expect(history).toContain("Change greeting.txt");
          expect(history).toContain("Problem: greeting must say fixed");
          return tool("write", { path: "greeting.txt", content: "fixed\n" });
        },
        tool("report_result", { kind: "implement", summary: "Fixed", data: { status: "done" } }),
        context => {
          expect(JSON.stringify(context.messages)).toContain("Problem: greeting must say fixed");
          return tool("write", { path: "extra.txt", content: "follow-up\n" });
        },
        tool("report_result", { kind: "implement", summary: "Follow-up", data: { status: "done" } }),
      ],
    });
    try {
      await h.session.prompt("Change the greeting");
      await h.session.prompt("Add extra.txt too");
      const results = h.session.messages.filter(message => message.role === "toolResult");
      expect(results).toHaveLength(3);
      for (const result of results) expect(result).toMatchObject({ toolName: "orche_task", isError: false, details: { worker: "W1", role: "implement" } });
      expect(JSON.stringify(results[0])).toContain("Note: follow up with the same worker — wording unclear");
      expect(await readFile(join(h.cwd, "extra.txt"), "utf8")).toBe("follow-up\n");
      expect(h.main.faux.getPendingResponseCount()).toBe(0);
      expect(h.orche.faux.getPendingResponseCount()).toBe(0);
    } finally { await h.dispose(); }
  });
});
