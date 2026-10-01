import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { delegationRules, discoverMainMode, guardToolCall } from "../../src/extension/mode.js";
import { parseRouteConfig } from "../../src/orchestration/routing.js";
import { answerScript, createHarness, decision, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

const open: Harness[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of open.splice(0)) await harness.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const created = await createHarness(...args);
  open.push(created);
  return created;
}
const MUTATORS = ["edit", "write", "ast_rewrite"];
const toolResults = (h: Harness) => h.session.messages.filter(message => message.role === "toolResult");
const lastResult = (h: Harness) => JSON.stringify(toolResults(h).at(-1));
const notes = (h: Harness) => h.notifications.map(note => note.message);
const systemOf = (context: { messages: { role: string }[] }) => JSON.stringify(context.messages.find(message => message.role === "system"));

describe("mainMode: tool sets", () => {
  it("defaults to auto: mutators are off, both delegation tools and inspection are on", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [], mainMode: "unset" });
    const active = h.session.getActiveToolNames();
    for (const name of MUTATORS) expect(active).not.toContain(name);
    expect(active).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "ast_search", "diagnostics", "bash", "orche_run", "orche_task"]));
    await h.session.prompt("/orche mode");
    expect(notes(h).at(-1)).toBe("orche mode: auto (default)");
    expect(h.session.getToolDefinition("read")?.description).toContain("LINE#TAG");
  });

  it.each(["auto", "single", "multi", "direct"] as const)("%s applies the complete tool matrix", async mainMode => {
    const h = await harness({ mainSteps: [], orcheSteps: [], mainMode });
    const active = h.session.getActiveToolNames();
    for (const name of MUTATORS) expect(active.includes(name)).toBe(mainMode === "direct");
    expect(active.includes("orche_run")).toBe(mainMode === "auto" || mainMode === "multi");
    expect(active.includes("orche_task")).toBe(mainMode === "auto" || mainMode === "single");
    expect(active).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "ast_search", "diagnostics", "bash"]));
  });

  it("injects mode-dependent delegation rules into the system prompt", async () => {
    const seen: string[] = [];
    const capture = (): FauxResponseStep => context => { seen.push(systemOf(context)); return reply("ok"); };
    const multi = await harness({ mainSteps: [capture()], orcheSteps: [], mainMode: "multi" });
    await multi.session.prompt("hello");
    const auto = await harness({ mainSteps: [capture()], orcheSteps: [], mainMode: "auto" });
    await auto.session.prompt("hello");
    const single = await harness({ mainSteps: [capture()], orcheSteps: [], mainMode: "single" });
    await single.session.prompt("hello");
    expect(seen[0]).toContain("You cannot edit files in this session");
    expect(seen[0]).toContain("delegate every change with the orche_run tool".replace("delegate", "Delegate"));
    expect(seen[0]).toContain("self-contained");
    expect(seen[1]).toContain("two or more independent write sets");
    expect(seen[1]).toContain("REQUIRED");
    expect(seen[1]).toContain("parallel hypotheses");
    expect(seen[2]).toContain("orche_run is disabled in mode single");
    expect(seen[2]).toContain("/orche mode auto or multi");
  });
});

// Guard specimens are pure string data; none of these commands are executed.
describe("mainMode: shell guard diagnostics", () => {
  it("rejects PowerShell in every delegation mode, without using Bash grammar", () => {
    const error = guardToolCall("multi", "powershell", { command: "ls" });
    expect(error).toContain("PowerShell is unsupported");
    expect(error).toContain("dedicated PowerShell parser");
    expect(error).not.toContain("explicitly requests mutation");
    for (const mode of ["auto", "single", "multi"] as const) {
      expect(guardToolCall(mode, "powershell", { command: "Set-Content file value" })).toContain(`Blocked by orche mode "${mode}"`);
      expect(guardToolCall(mode, "bash", { command: "touch file" })).toContain("explicitly requests mutation");
    }
    expect(guardToolCall("direct", "powershell", { command: "Set-Content file value" })).toBeUndefined();
    expect(guardToolCall("direct", "bash", { command: "touch file" })).toBeUndefined();
  });
  it.each([undefined, null, 42, {}, [], "", " \t\n"])("rejects malformed command %j", command => {
    expect(guardToolCall("multi", "bash", { command })).toContain("command must be a non-blank string");
  });
  it("rejects missing command", () => {
    expect(guardToolCall("multi", "bash", {})).toContain("invalid command");
  });
  it("distinguishes mutation from unverified syntax and offers safe alternatives", () => {
    const mutation = guardToolCall("multi", "bash", { command: "touch file" });
    const unsupported = guardToolCall("multi", "bash", { command: "ls *.ts" });
    expect(mutation).toContain("explicitly requests mutation");
    expect(mutation).toContain("Do not retry it directly: delegate");
    expect(unsupported).toContain("could not be verified");
    expect(unsupported).not.toContain("explicitly requests mutation");
    for (const error of [mutation, unsupported]) {
      expect(error).toContain("read with offset/limit, grep, simple static Bash");
      expect(error).toContain("delegate with orche_run");
      expect(error).toContain("may create generated files");
    }
    expect(guardToolCall("multi", "bash", { command: "npm test" })).toBeUndefined();
    expect(delegationRules("multi")).toContain("trusted project checks that may create generated files");
  });
});

describe("mainMode: multi guard", () => {
  it("blocks edit, write and ast_rewrite even when something re-activates them; the files stay untouched", async () => {
    const h = await harness({
      mainSteps: [
        tool("edit", { path: "greeting.txt", edits: [{ op: "replace", at: "1#0123456789abcdef", text: "changed" }] }),
        tool("write", { path: "new.txt", content: "x" }),
        tool("ast_rewrite", { pattern: "foo($A)", replacement: "bar($A)", dryRun: true }),
        reply("ok"),
      ],
      orcheSteps: [],
      mainMode: "multi",
    });
    h.session.setActiveToolsByName([...h.session.getActiveToolNames(), ...MUTATORS]);
    await h.session.prompt("change the greeting");
    const results = toolResults(h);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain('Blocked by orche mode \\"multi\\"');
      expect(JSON.stringify(result)).toContain("orche_run");
    }
    expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("hello world\n");
    expect(await readdir(h.cwd)).toEqual(["greeting.txt"]);
  });

  it("lets read-only shell run and blocks mutating shell with a delegation reason", async () => {
    const h = await harness({
      mainSteps: [
        tool("bash", { command: "ls" }),
        tool("bash", { command: "echo hacked > out.txt" }),
        tool("bash", { command: "GIT_EXTERNAL_DIFF=./evil.sh git diff" }),
        tool("bash", { command: "sed -i s/hello/bye/ greeting.txt" }),
        reply("done"),
      ],
      orcheSteps: [],
      mainMode: "multi",
    });
    await h.session.prompt("inspect");
    const [ls, redirect, env, sed] = toolResults(h);
    expect(ls).toMatchObject({ isError: false });
    expect(JSON.stringify(ls)).toContain("greeting.txt");
    for (const [result, why] of [[redirect, "output redirection"], [env, "environment assignment GIT_EXTERNAL_DIFF"], [sed, "command sed"]] as const) {
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain(why);
      expect(JSON.stringify(result)).toContain("orche_run");
    }
    expect(await readdir(h.cwd)).toEqual(["greeting.txt"]);
    expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("hello world\n");
  });

  it("the model delegates with orche_run and the orchestration runs; context reaches the problem", async () => {
    let classification = "";
    let mainContext = "";
    const h = await harness({
      mainSteps: [
        tool("orche_run", { request: "Change the greeting to 'bye world'. Acceptance: greeting.txt reads bye world.", context: "CONTEXT_MARKER: we agreed on the wording earlier." }),
        context => { mainContext = JSON.stringify(context.messages.findLast(message => message.role === "toolResult")); return reply("delegated"); },
      ],
      orcheSteps: [
        context => {
          classification = JSON.stringify(context.messages.findLast(message => message.role === "user"));
          return decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "explanation" });
        },
        ...answerScript("ORCHE_DID_IT").slice(1),
      ],
      mainMode: "multi",
    });
    await h.session.prompt("please change the greeting");
    expect(mainContext).toContain("ORCHE_DID_IT");
    expect(classification).toContain("Change the greeting to 'bye world'");
    expect(classification).toContain("Context from the requesting session");
    expect(classification).toContain("CONTEXT_MARKER");
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
  });

  it("direct mode blocks orche_run if something re-activates it", async () => {
    const h = await harness({ mainSteps: [tool("orche_run", { request: "do it" }), reply("ok")], orcheSteps: answerScript("MUST_NOT_RUN"), mainMode: "direct" });
    h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "orche_run"]);
    await h.session.prompt("go");
    expect(lastResult(h)).toContain('Blocked by orche mode \\"direct\\"');
    expect(h.orche.faux.state.callCount).toBe(0);
  });
});

describe("/orche mode", () => {
  it("prints the mode and its source, switches it, applies the tool set and survives a reload of the session", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [], mainMode: "multi" });
    await h.session.prompt("/orche mode");
    expect(notes(h).at(-1)).toMatch(/^orche mode: multi \(config .*orche\.config\.json\)$/);

    await h.session.prompt("/orche mode direct");
    expect(notes(h).at(-1)).toBe("orche mode: direct (saved in this session)");
    expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(MUTATORS));
    expect(h.session.getActiveToolNames()).not.toContain("orche_run");
    await h.session.prompt("/orche mode");
    expect(notes(h).at(-1)).toBe("orche mode: direct (set with /orche mode in this session)");
    expect(h.session.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "orche-mode")).toBe(true);

    await h.session.prompt("/orche mode auto");
    await h.session.prompt("/orche mode multi");
    await h.session.reload();
    await h.session.prompt("/orche mode");
    expect(notes(h).at(-1)).toBe("orche mode: multi (set with /orche mode in this session)");
    for (const name of MUTATORS) expect(h.session.getActiveToolNames()).not.toContain(name);

    await h.session.prompt("/orche mode auto");
    await h.session.reload();
    expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["orche_run", "orche_task"]));
    for (const name of MUTATORS) expect(h.session.getActiveToolNames()).not.toContain(name);
  });

  it("rejects unknown modes with the usage text and changes nothing", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [], mainMode: "multi" });
    await h.session.prompt("/orche mode turbo");
    expect(notes(h)).toEqual([expect.stringContaining("/orche mode [auto|single|multi|direct]")]);
    for (const name of MUTATORS) expect(h.session.getActiveToolNames()).not.toContain(name);
  });
});

describe("/orche direct is a one-turn override", () => {
  it("in multi: edits are allowed and orche_run is off for that turn, then the multi tool set returns", async () => {
    let duringTurn: string[] = [];
    const h = await harness({
      mainSteps: [
        context => {
          duringTurn = h.session.getActiveToolNames();
          return tool("write", { path: "direct.txt", content: "direct edit" });
        },
        reply("edited"),
      ],
      orcheSteps: answerScript("MUST_NOT_RUN"),
      mainMode: "multi",
    });
    await h.session.prompt("/orche direct create direct.txt");
    expect(duringTurn).toEqual(expect.arrayContaining(MUTATORS));
    expect(duringTurn).not.toContain("orche_run");
    expect(await readFile(join(h.cwd, "direct.txt"), "utf8")).toBe("direct edit");
    expect(h.orche.faux.state.callCount).toBe(0);
    // restored after settle: later prompts are multi again
    for (const name of MUTATORS) expect(h.session.getActiveToolNames()).not.toContain(name);
    expect(h.session.getActiveToolNames()).toContain("orche_run");
    h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "write"]);
    h.main.faux.setResponses([tool("write", { path: "second.txt", content: "x" }), reply("blocked")]);
    await h.session.prompt("now try again without the override");
    expect(lastResult(h)).toContain('Blocked by orche mode \\"multi\\"');
    expect(await readdir(h.cwd)).not.toContain("second.txt");
  });

  it("is restored when the turn is aborted", async () => {
    const entered = deferred();
    const h = await harness({
      mainSteps: [async (_context, options) => {
        entered.resolve();
        await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
        return reply("aborted");
      }],
      orcheSteps: [],
      mainMode: "multi",
    });
    const turn = h.session.prompt("/orche direct long job");
    await entered.promise;
    expect(h.session.getActiveToolNames()).toContain("write");
    await h.session.abort();
    await turn;
    for (const name of MUTATORS) expect(h.session.getActiveToolNames()).not.toContain(name);
    expect(h.session.getActiveToolNames()).toContain("orche_run");
  });

  it("is restored when the turn ends in a model error", async () => {
    const h = await harness({
      mainSteps: [reply("", { stopReason: "error", errorMessage: "400 invalid request" })],
      orcheSteps: [],
      mainMode: "multi",
    });
    await h.session.prompt("/orche direct anything");
    for (const name of MUTATORS) expect(h.session.getActiveToolNames()).not.toContain(name);
    expect(h.session.getActiveToolNames()).toContain("orche_run");
  });

  it("is refused while the agent is busy in multi (no queued turn that could not edit); the busy turn is unaffected", async () => {
    const gate = deferred();
    const entered = deferred();
    const h = await harness({
      mainSteps: [async () => { entered.resolve(); await gate.promise; return reply("first done"); }],
      orcheSteps: [],
      mainMode: "multi",
    });
    const first = h.session.prompt("first request");
    await entered.promise;
    await h.session.prompt("/orche direct second request");
    expect(notes(h).join("\n")).toContain("refused");
    expect(notes(h).join("\n")).toContain("/orche mode direct");
    for (const name of MUTATORS) expect(h.session.getActiveToolNames()).not.toContain(name);
    gate.resolve();
    await first;
    expect(h.main.faux.state.callCount).toBe(1);
  });
});

describe("mainMode config discovery", () => {
  async function layout(files: { project?: unknown; user?: unknown }) {
    const root = await mkdtemp(join(tmpdir(), "orche-mode-"));
    roots.push(root);
    const cwd = join(root, "work");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    if (files.project !== undefined) await writeFile(join(cwd, ".pi", "orche.config.json"), JSON.stringify(files.project));
    if (files.user !== undefined) await writeFile(join(agentDir, "orche.config.json"), JSON.stringify(files.user));
    return { cwd, agentDir };
  }
  const cfg = (extra: object) => ({ routes: {}, ...extra });

  it("reads mainMode from the same selected file as the routes: trusted project, then user, else none", async () => {
    const both = await layout({ project: cfg({ mainMode: "single" }), user: cfg({ mainMode: "auto" }) });
    expect(await discoverMainMode({ ...both, projectTrusted: true })).toMatchObject({ mode: "single" });
    expect(await discoverMainMode({ ...both, projectTrusted: false })).toMatchObject({ mode: "auto" });
    const projectWithoutKey = await layout({ project: cfg({}), user: cfg({ mainMode: "auto" }) });
    expect(await discoverMainMode({ ...projectWithoutKey, projectTrusted: true })).toEqual({ path: expect.stringContaining(".pi"), });
    const none = await layout({});
    expect(await discoverMainMode({ ...none, projectTrusted: true })).toEqual({});
  });

  it("reports an invalid value instead of guessing, and the config parser names the field", async () => {
    const bad = await layout({ user: cfg({ mainMode: "turbo" }) });
    const found = await discoverMainMode({ ...bad, projectTrusted: true });
    expect(found.mode).toBeUndefined();
    expect(found.error).toContain("config.mainMode: expected auto, single, multi, direct");
    expect(() => parseRouteConfig({ routes: {}, mainMode: 3 })).toThrow("config.mainMode");
    for (const mainMode of ["auto", "single", "multi", "direct"] as const) expect(parseRouteConfig({ routes: {}, mainMode }).mainMode).toBe(mainMode);
    // Pi's "max" thinking level is a valid route setting (the user config uses it); unknown levels are still rejected.
    expect(parseRouteConfig({ routes: { analyst: { model: "p/m", thinking: "max" } } }).routes.analyst?.thinking).toBe("max");
    expect(() => parseRouteConfig({ routes: { analyst: { model: "p/m", thinking: "ultra" } } })).toThrow("thinking");
  });

  it("an invalid config file leaves the safe default (auto) and tells the user", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [], writeUserConfig: false });
    const { agentDir } = h;
    await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, mainMode: "turbo" }));
    await h.session.reload();
    expect(notes(h).join("\n")).toContain("using the default mode auto");
    for (const name of MUTATORS) expect(h.session.getActiveToolNames()).not.toContain(name);
  });
});


describe("single-worker mode and one-turn override", () => {
  it("/orche single selects one delegated worker, then restores multi", async () => {
    let during: string[] = [];
    let system = "";
    const h = await harness({
      mainMode: "multi",
      mainSteps: [context => {
        during = h.session.getActiveToolNames();
        system = systemOf(context);
        return tool("orche_task", { role: "explore", request: "Inspect greeting.txt without changing files" });
      }, reply("supervised")],
      orcheSteps: [tool("report_result", { kind: "explore", summary: "Greeting inspected" })],
    });
    await h.session.prompt("/orche single inspect the greeting");
    expect(during).toContain("orche_task");
    expect(during).not.toContain("orche_run");
    for (const name of MUTATORS) expect(during).not.toContain(name);
    expect(system).toContain("orche mode: single");
    expect(lastResult(h)).toContain("Greeting inspected");
    expect(h.session.getActiveToolNames()).toContain("orche_run");
    expect(h.session.getActiveToolNames()).not.toContain("orche_task");
  });

  it.each(["auto", "single", "multi", "direct"] as const)("/orche single busy rules in %s", async mainMode => {
    const entered = deferred();
    const gate = deferred();
    const h = await harness({ mainMode, orcheSteps: [], mainSteps: [async () => {
      entered.resolve(); await gate.promise; return reply("first done");
    }, reply("follow-up done")] });
    const first = h.session.prompt("first");
    await entered.promise;
    await h.session.prompt("/orche single follow-up");
    const compatible = mainMode === "auto" || mainMode === "single";
    expect(notes(h).at(-1)).toContain(compatible ? "queued" : "refused");
    gate.resolve();
    await first;
    await h.session.agent.waitForIdle();
    expect(h.main.faux.state.callCount).toBe(compatible ? 2 : 1);
  });

  it.each(["auto", "single", "multi", "direct"] as const)("/orche direct busy rules in %s", async mainMode => {
    const entered = deferred();
    const gate = deferred();
    const h = await harness({ mainMode, orcheSteps: [], mainSteps: [async () => {
      entered.resolve(); await gate.promise; return reply("first done");
    }, reply("follow-up done")] });
    const first = h.session.prompt("first");
    await entered.promise;
    await h.session.prompt("/orche direct follow-up");
    expect(notes(h).at(-1)).toContain(mainMode === "direct" ? "queued" : "refused");
    gate.resolve();
    await first;
    await h.session.agent.waitForIdle();
    expect(h.main.faux.state.callCount).toBe(mainMode === "direct" ? 2 : 1);
  });

  it.each([
    ["single", "orche_run", "orche_task"],
    ["multi", "orche_task", "orche_run"],
    ["direct", "orche_task", "make the change directly"],
    ["direct", "orche_run", "make the change directly"],
  ] as const)("%s guards unavailable %s", (mode, name, advice) => {
    expect(guardToolCall(mode, name, {})).toContain(`Blocked by orche mode "${mode}"`);
    expect(guardToolCall(mode, name, {})).toContain(advice);
  });

  it.each(["auto", "single", "multi", "direct"] as const)("%s policy is byte-stable", mode => {
    expect(delegationRules(mode)).toBe(delegationRules(mode));
  });

  it("auto policy requires multi actively and keeps reuse and supervision explicit", () => {
    const rules = delegationRules("auto");
    for (const criterion of ["two or more independent write sets", "parallel hypotheses", "independent verification", "user asks for orchestration", "failed verification twice", "never split a multi-sized job", "never claim a reuse that did not happen", "workers are gone after a reload", "a worker's report is not acceptance", "report unverified items as unverified", "Goal; Scope and non-goals; Decided and open; Inputs and dependencies; Acceptance and verification; Return"])
      expect(rules).toContain(criterion);
  });
});
