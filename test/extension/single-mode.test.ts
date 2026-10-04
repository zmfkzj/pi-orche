import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { delegationRules, guardToolCall } from "../../src/extension/mode.js";
import { createHarness, tool } from "./harness.js";

// Literal output captured from git HEAD (188eb4ec4fdf1d773989e5987423c727a5d8a3f9) before this change.
// Do not derive these snapshots from the implementation under test.
const PRE_CHANGE_RULES = {
  auto: "orche mode: auto. You cannot edit files in this session: edit, write and ast_rewrite are disabled; explicit shell mutations and unverified shell syntax are blocked. You keep the conversation, inspection (read, grep, find, ls, ast_search, diagnostics, simple static Bash) and trusted project checks. Delegate every change and every multi-file investigation with one of two tools, chosen per request:\norche_task (single): one persistent worker with a role you choose (explore | answer | implement | verify | game-asset | video). Use game-asset for creating/modifying game art/audio/model assets, and video for producing/editing video. Use it for one cohesive unit with a clear write set, a read-only investigation or question, a verification pass, and for follow-ups to work a live worker already did (pass its id in `worker`; it keeps its context).\nGit: workers never commit or push on their own, and this session cannot run commits itself. Only when the user explicitly asked in this conversation to commit or push, pass `git` ({commit:true} or {push:true, remote?, branch?}) to an implement, game-asset or video orche_task; explore, answer and verify reject it. The grant covers that assignment only, so scope the commit to the task's files where possible (pass `files` and name the paths in `request`) and check the commits listed in the result before reporting.\norche_run (multi): coordinator, parallel workers and an independent verifier. REQUIRED when any of these holds: the change spans two or more independent write sets or units with separate acceptance; the cause of a defect is unknown and needs parallel hypotheses; the change needs independent verification (user-visible behaviour, risky or wide changes, anything the user wants verified); the user asks for orchestration; an orche_task worker reported blocked or a failed verification twice on the same unit. When the scope is unclear, prefer multi; never split a multi-sized job into several orche_task calls to avoid it.\nJudgment before Production: when cause or scope is unclear, start with explore or answer, then implement with the same worker (reuse) or escalate to orche_run with the findings in `context`. Analysis-only requests never change files.\nReuse: follow-ups of the same work go to the worker that did it; state what changed since; start a new worker when the premises changed materially; never claim a reuse that did not happen (unknown ids are errors; workers are gone after a reload).\nSupervision: a worker's report is not acceptance. Read the key evidence it cites, run the trusted project checks yourself or dispatch a verify worker, and report unverified items as unverified.\nWorkers do not see this conversation. Write `request` as: Goal; Scope and non-goals; Decided and open; Inputs and dependencies; Acceptance and verification; Return. Put background in `context`. Pass references, not copies: repository paths with line ranges or symbol names, reproduction commands, artifact and run-record paths. Paste only short decisive snippets a worker cannot reproduce (an exact error line or user-provided text); never whole files, diffs or long logs.\nAfter a failed orche_run, do not start another orche_run for the same request (even if multi criteria hold). Send remaining issues to handed-over workers via orche_task: implement for fixes, verify for re-checks; pass the reported id in `worker` to reuse context.\norche runs do not see this conversation. Make `request` self-contained: the goal, the decisions made so far, the relevant files and findings from this conversation, constraints, and acceptance criteria (what must be true and how to check it). Put background that is not the instruction itself in `context`. Pass references, not copies: repository paths with line ranges or symbol names, reproduction commands, artifact and run-record paths. Paste only short decisive snippets a worker cannot reproduce (an exact error line or user-provided text); never whole files, diffs or long logs. When orche_run returns, report its result to the user; do not redo its work.",
  multi: "orche mode: multi. You cannot edit files in this session: edit, write and ast_rewrite are disabled; explicit shell mutations and unverified shell syntax are blocked. Delegate every change with the orche_run tool. orche_task is disabled in this mode; switch with /orche mode auto or single to use one delegated worker, or /orche mode direct to make changes directly. You keep the conversation, inspection (read, grep, find, ls, ast_search, diagnostics, simple static Bash such as git status), trusted project checks that may create generated files or execute project configuration, and composing the delegation request. PowerShell is unsupported in multi.\norche runs do not see this conversation. Make `request` self-contained: the goal, the decisions made so far, the relevant files and findings from this conversation, constraints, and acceptance criteria (what must be true and how to check it). Put background that is not the instruction itself in `context`. Pass references, not copies: repository paths with line ranges or symbol names, reproduction commands, artifact and run-record paths. Paste only short decisive snippets a worker cannot reproduce (an exact error line or user-provided text); never whole files, diffs or long logs. When orche_run returns, report its result to the user; do not redo its work.",
  direct: "orche mode: direct. Delegation tools are disabled; make changes directly with your own tools. You may edit user-requested paths outside the cwd/workspace, including absolute paths and ../ paths. Delegated workers' workspace confinement does not restrict this main direct session; their scope remains unchanged. Existing OS permissions and other policies still apply; direct mode does not grant elevated OS privileges or bypass those restrictions.",
} as const;

const SINGLE_RUN_GUARD = 'Blocked by orche mode "single": orche_run is disabled in mode single; continue with orche_task (reuse a worker for follow-ups).';

describe("single mode does the work", () => {
  it.each(["multi", "direct"] as const)("keeps %s rules byte-identical to pre-change HEAD", mode => {
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
      "even when it is large, multi-sized or risky",
      "Do not split the task into explore/implement/verify phases",
      "never send an explore before an implement for the same request",
      "Never stop to ask the user to switch modes in order to proceed",
      "never end a turn without attempting the requested change because of its size or risk",
      "The worker owns the whole task end to end",
      "problems and user follow-ups go to the SAME worker (pass its id in `worker`)",
      "Read the report and its key evidence, run the trusted project checks yourself",
      "Send a separate verify assignment only when the user explicitly asks for independent verification",
      "This workflow is the same with and without a UI",
    ]) expect(rules).toContain(instruction);
    // Role listings and prohibitions are not instructions to dispatch exploration or verification.
    const withoutProhibitions = rules
      .replace("Never stop to ask the user to switch modes in order to proceed", "")
      .replaceAll("Do not split the task into explore/implement/verify phases, and never send an explore before an implement for the same request.", "")
      .replace("Send a separate verify assignment only when the user explicitly asks for independent verification", "");
    expect(withoutProhibitions).not.toMatch(/ask the user to switch|prefer multi|never split|Multi criteria:|Judgment before Production|start with explore|explore first|explore before|dispatch.*verify/);
    expect(rules).toContain("creates a Task DAG with task_plan and executes nodes sequentially without main intervention");
    expect(delegationRules("single")).toBe(rules);
  });

  it("permits multi advice only once in the final report after the work is done", () => {
    expect(delegationRules("single")).toContain("Multi is optional advice only: mention it at most once, in the final report after the work is done");
    expect(delegationRules("single")).toContain("never as a reason to stop");
  });

  it("guards orche_run with continuation rather than a switch instruction", () => {
    expect(guardToolCall("single", "orche_run", {})).toBe(SINGLE_RUN_GUARD);
    expect(guardToolCall("single", "orche_task", {})).toBeUndefined();
  });

  it("continues with orche_task after an attempted disabled orche_run", async () => {
    const h = await createHarness({
      mainMode: "single", mode: "print",
      mainSteps: [tool("orche_run", { request: "Change the greeting" }), tool("orche_task", { role: "implement", request: "Write greeting.txt", files: ["greeting.txt"] }), reply("done")],
      orcheSteps: [tool("write", { path: "greeting.txt", content: "changed\n" }), tool("report_result", { kind: "implement", summary: "Changed greeting", data: { status: "done" } })],
    });
    try {
      h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "orche_run"]);
      await h.session.prompt("Change the greeting even though the job looks risky");
      const results = h.session.messages.filter(message => message.role === "toolResult");
      expect(results[0]).toMatchObject({ isError: true, content: [{ type: "text", text: SINGLE_RUN_GUARD }] });
      expect(results[1]).toMatchObject({ isError: false, details: { worker: "W1" } });
      expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("changed\n");
      expect(h.orche.faux.getPendingResponseCount()).toBe(0);
    } finally { await h.dispose(); }
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
