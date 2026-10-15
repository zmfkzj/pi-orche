import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type AssistantMessage, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import type { ClassifierCall } from "../helpers/classifier.js";
import { createHarness, tool, type Harness } from "./harness.js";

/**
 * The Bash safety review on every Bash route of the extension, with the test-only fake Jev (test/helpers/classifier.ts): main's
 * own bash (tool_call hook), an orche_task worker (its tool guard) and orche_spawn sub-workers (their guard). Marker files show
 * whether the shell ran; the fake's call list shows each invocation was reviewed exactly once.
 */
const open: { dispose(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.dispose();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
const exists = (path: string) => readFile(path, "utf8").then(() => true, () => false);
const commandOf = (call: ClassifierCall) => String(call.context.state.command);
/** Jev stand-in: no for a command naming `denied`, yes otherwise. */
const deniesDenied = (call: ClassifierCall) => commandOf(call).includes("denied") ? "no" as const : "yes" as const;
type Context = Parameters<FauxResponseFactory>[0];
const lastText = (context: Context) => JSON.stringify(context.messages.at(-1));
const toolResults = (h: Harness) => h.session.agent.state.messages.filter(message => message.role === "toolResult") as { toolName: string; isError: boolean; content: { type: string; text?: string }[] }[];

describe("main's own bash", () => {
  it("direct mode: no blocks the shell, the same command again is reviewed again and blocked, the corrected command runs on yes", async () => {
    const h = await createHarness({
      mainMode: "direct", orcheSteps: [],
      mainSteps: [
        tool("bash", { command: "echo bad > denied.txt" }),
        tool("bash", { command: "echo bad > denied.txt" }),
        tool("bash", { command: "echo good > allowed.txt" }),
        tool("bash", { command: "cat greeting.txt" }),
        reply("done"),
      ],
    });
    open.push(h);
    h.classifier.answer = deniesDenied;
    await h.session.prompt("Clean up the notes");
    expect(await exists(join(h.cwd, "denied.txt"))).toBe(false);
    expect(await readFile(join(h.cwd, "allowed.txt"), "utf8")).toBe("good\n");
    // One review per write invocation (the read-only `cat` bypasses it), on Jev, with the user's request as the task.
    expect(h.classifier.calls.map(commandOf)).toEqual(["echo bad > denied.txt", "echo bad > denied.txt", "echo good > allowed.txt"]);
    expect(h.classifier.calls.map(call => `${call.provider}/${call.id}`)).toEqual(Array(3).fill("typesafe/jev-latest"));
    expect(h.classifier.calls[0]!.context.state).toMatchObject({ cwd: h.cwd, task: "Clean up the notes" });
    const results = toolResults(h);
    expect(results.map(result => result.isError)).toEqual([true, true, false, false]);
    expect(results[0]!.content[0]!.text).toContain("Bash safety review (typesafe/jev-latest) answered no: this command was NOT run.");
    expect(results[1]!.content[0]!.text).toContain("answered no");
  });

  it("selection is about writes, not main's permission policy: a project check is reviewed (and a no stops it), a read with a variable is not", async () => {
    const h = await createHarness({
      mainMode: "direct", orcheSteps: [],
      mainSteps: [
        tool("bash", { command: "npm test > npm-ran.txt" }),
        tool("bash", { command: "NAME=greeting; cat \"$NAME.txt\" | grep -c . ; ps -o pid= -p $$ >/dev/null" }),
        reply("done"),
      ],
    });
    open.push(h);
    h.classifier.answer = call => commandOf(call).startsWith("npm") ? "no" : "yes";
    await h.session.prompt("Check the project");
    expect(h.classifier.calls.map(commandOf)).toEqual(["npm test > npm-ran.txt"]);
    expect(await exists(join(h.cwd, "npm-ran.txt"))).toBe(false);
    const results = toolResults(h);
    expect(results[0]!.content[0]!.text).toContain("answered no: this command was NOT run");
    expect(results[1]!.isError).toBe(false);
  });

  it("a review failure blocks the shell without counting as no, and a delegating mode's own refusal comes first (no review)", async () => {
    const h = await createHarness({
      mainMode: "direct", orcheSteps: [],
      mainSteps: [tool("bash", { command: "echo x > failed.txt" }), reply("done")],
    });
    open.push(h);
    h.classifier.answer = () => new Error("TypeSafe unreachable");
    await h.session.prompt("go");
    expect(await exists(join(h.cwd, "failed.txt"))).toBe(false);
    expect(toolResults(h)[0]!.content[0]!.text).toContain("gave no verdict (TypeSafe unreachable): this command was NOT run. This is not a judgment");

    const single = await createHarness({ mainMode: "single", orcheSteps: [], mainSteps: [tool("bash", { command: "echo x > single.txt" }), reply("done")] });
    open.push(single);
    await single.session.prompt("go");
    expect(await exists(join(single.cwd, "single.txt"))).toBe(false);
    expect(single.classifier.calls).toHaveLength(0);
    expect(toolResults(single)[0]!.content[0]!.text).not.toContain("Bash safety review");
  });

  // Dangerous fixtures sit behind `false &&`: the analysis sees the delete, the shell never reaches it, so a failing guard
  // shows up only as a marker file from the harmless `touch` after it. The corrected command deletes an empty test directory.
  it("static check on main: a proven-empty target is blocked before Jev, an unknown (inherited) variable reaches Jev whose answer decides, the corrected command runs", async () => {
    process.env.ORCHE_TEST_INHERITED = "";
    const h = await createHarness({
      mainMode: "direct", orcheSteps: [],
      mainSteps: [
        tool("bash", { command: "R=''; false && rm -rf \"$R/\"*; touch static-ran.txt" }),
        tool("bash", { command: "false && rm -rf \"$ORCHE_TEST_INHERITED/\"*; touch unknown-no.txt" }),
        tool("bash", { command: "false && rm -rf \"$ORCHE_TEST_INHERITED/\"*; touch unknown-yes.txt" }),
        tool("bash", { command: "R=old; find \"$R/\" -maxdepth 0 -delete; touch fixed.txt" }),
        tool("bash", { command: "false && rm -rf ./*; touch warned.txt" }),
        reply("done"),
      ],
    });
    open.push(h);
    try {
      execFileSync("mkdir", [join(h.cwd, "old")]);
      h.classifier.answer = call => /warned|unknown-no/.test(commandOf(call)) ? "no" : "yes";
      await h.session.prompt("Remove the old directory");
    } finally {
      delete process.env.ORCHE_TEST_INHERITED;
    }
    expect(await exists(join(h.cwd, "static-ran.txt"))).toBe(false);
    expect(await exists(join(h.cwd, "unknown-no.txt"))).toBe(false);
    expect(await exists(join(h.cwd, "unknown-yes.txt"))).toBe(true);
    expect(await exists(join(h.cwd, "fixed.txt"))).toBe(true);
    expect(await exists(join(h.cwd, "old"))).toBe(false);
    expect(await exists(join(h.cwd, "warned.txt"))).toBe(false);
    // One Jev call per reviewed invocation that got past the static check: the blocked one never reached Jev.
    expect(h.classifier.calls.map(commandOf)).toEqual([
      "false && rm -rf \"$ORCHE_TEST_INHERITED/\"*; touch unknown-no.txt", "false && rm -rf \"$ORCHE_TEST_INHERITED/\"*; touch unknown-yes.txt",
      "R=old; find \"$R/\" -maxdepth 0 -delete; touch fixed.txt", "false && rm -rf ./*; touch warned.txt",
    ]);
    expect(h.classifier.calls[0]!.context.state.staticFindings).toEqual([expect.stringContaining("if $ORCHE_TEST_INHERITED is empty or unset the target is everything in the filesystem root (its value is not known here")]);
    expect(h.classifier.calls[2]!.context.state.staticFindings).toBeUndefined();
    expect(h.classifier.calls[3]!.context.state.staticFindings).toEqual([`rm ./* targets everything in the whole working directory ${h.cwd}`]);
    const results = toolResults(h);
    expect(results[0]!.content[0]!.text).toContain("Bash safety check (static): this command was NOT run. rm $R/*: $R is assigned an empty value in this command");
    expect(results[1]!.content[0]!.text).toContain("answered no: this command was NOT run");
    expect(results[4]!.content[0]!.text).toContain("The static check noticed: rm ./* targets everything in the whole working directory");
  });

  it("bashReview.enabled false switches the review off", async () => {
    const h = await createHarness({ mainMode: "direct", orcheSteps: [], bashReview: { enabled: false }, mainSteps: [tool("bash", { command: "echo x > denied.txt" }), reply("done")] });
    open.push(h);
    h.classifier.answer = () => "no";
    await h.session.prompt("go");
    expect(await exists(join(h.cwd, "denied.txt"))).toBe(true);
    expect(h.classifier.calls).toHaveLength(0);
  });

  it("a nested bash call another tool makes (ctx.executeTool, as codemode's tools.bash does) is reviewed once by the same hook", async () => {
    // A stand-in for codemode: a tool whose execute() runs bash through Pi's nested tool path (tool_call with parentToolCallId).
    const script: ExtensionFactory = pi => {
      pi.registerTool({
        name: "run_script", label: "Run script", description: "Runs one shell command through the bash tool.",
        parameters: Type.Object({ command: Type.String() }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const nested = await ctx.executeTool("bash", { command: params.command });
            return { content: [{ type: "text", text: `nested: ${JSON.stringify(nested)}` }], details: {} };
          } catch (error) {
            return { content: [{ type: "text", text: `nested failed: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
          }
        },
      });
    };
    const h = await createHarness({
      mainMode: "direct", orcheSteps: [], extraExtensions: [script],
      mainSteps: [tool("run_script", { command: "echo bad > denied.txt" }), tool("run_script", { command: "echo ok > nested.txt" }), reply("done")],
    });
    open.push(h);
    h.classifier.answer = deniesDenied;
    await h.session.prompt("go");
    expect(await exists(join(h.cwd, "denied.txt"))).toBe(false);
    expect(await readFile(join(h.cwd, "nested.txt"), "utf8")).toBe("ok\n");
    expect(h.classifier.calls.map(commandOf)).toEqual(["echo bad > denied.txt", "echo ok > nested.txt"]);
    expect(toolResults(h)[0]!.content[0]!.text).toContain("answered no: this command was NOT run");
  });
});

async function workerFixture(steps: FauxResponseStep[], bashReview?: Record<string, unknown>) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, ...(bashReview ? { bashReview } : {}) });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const pool = new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir });
  open.push(pool);
  const execute = (args: Partial<TaskParameters> = {}, signal?: AbortSignal) => pool.execute({ role: "implement", request: "Write the notes file", cwd: h.cwd, projectTrusted: false, ...args, ...(signal ? { signal } : {}) });
  return { h, pool, execute };
}
const done = tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } });

describe("an orche_task worker's bash", () => {
  it("the static check also guards worker bash, before Jev and after the existing write-scope guard", async () => {
    const { h, execute } = await workerFixture([
      tool("bash", { command: "false && rm -rf ~; touch static-ran.txt" }),
      tool("bash", { command: "touch fixed.txt" }),
      done,
    ]);
    await execute();
    expect(await exists(join(h.cwd, "static-ran.txt"))).toBe(false);
    expect(await exists(join(h.cwd, "fixed.txt"))).toBe(true);
    expect(h.classifier.calls.map(commandOf)).toEqual(["touch fixed.txt"]);
  });

  it("is reviewed once per call after the existing guards: no blocks, the corrected command runs, an outside literal write is still refused first", async () => {
    const outside = join(tmpdir(), `orche-review-outside-${process.pid}.txt`);
    const seen: string[] = [];
    const { h, execute } = await workerFixture([
      tool("bash", { command: "echo bad > denied.txt" }),
      context => { seen.push(lastText(context)); return tool("bash", { command: "echo good > notes.txt" }); },
      context => { seen.push(lastText(context)); return tool("bash", { command: `echo x > ${outside}` }); },
      context => { seen.push(lastText(context)); return done; },
    ]);
    h.classifier.answer = deniesDenied;
    const result = await execute();
    expect(result.details.status).toBe("done");
    expect(await exists(join(h.cwd, "denied.txt"))).toBe(false);
    expect(await readFile(join(h.cwd, "notes.txt"), "utf8")).toBe("good\n");
    expect(await exists(outside)).toBe(false);
    expect(seen[0]).toContain("answered no: this command was NOT run");
    expect(seen[2]).toContain("outside the workspace");
    // The outside write never reached the review: the existing guard refused it first.
    expect(h.classifier.calls.map(commandOf)).toEqual(["echo bad > denied.txt", "echo good > notes.txt"]);
    expect(h.classifier.calls[0]!.context.state).toMatchObject({ cwd: h.cwd, task: expect.stringContaining("Write the notes file") });
    expect(h.classifier.calls[0]!.context.state.extraWriteRoots).toEqual([expect.stringContaining("W1")]);
  });

  it("a reused worker's review is told its current assignment, not the previous one", async () => {
    const { h, execute } = await workerFixture([
      tool("bash", { command: "echo 1 > first.txt" }), done,
      tool("bash", { command: "echo 2 > second.txt" }), done,
    ]);
    await execute({ request: "First assignment" });
    await execute({ worker: "W1", request: "Second assignment" });
    expect(h.classifier.calls.map(call => [commandOf(call), String(call.context.state.task).includes("First assignment"), String(call.context.state.task).includes("Second assignment")]))
      .toEqual([["echo 1 > first.txt", true, false], ["echo 2 > second.txt", false, true]]);
  });

  it("a timeout blocks the shell (bashReview.timeoutMs) and the worker can retry", async () => {
    let afterTimeout: { text: string; ran: boolean } | undefined;
    const { h, execute } = await workerFixture([
      tool("bash", { command: "echo t > timed.txt" }),
      async context => { afterTimeout = { text: lastText(context), ran: await exists(join(h.cwd, "timed.txt")) }; return tool("bash", { command: "echo t > timed.txt" }); },
      done,
    ], { timeoutMs: 1000 });
    let first = true;
    h.classifier.answer = () => first ? (first = false, new Promise(() => undefined)) : "yes";
    await execute();
    expect(afterTimeout).toEqual({ text: expect.stringContaining("gave no verdict (no verdict within 1000ms): this command was NOT run"), ran: false });
    expect(h.classifier.calls).toHaveLength(2);
    expect(await readFile(join(h.cwd, "timed.txt"), "utf8")).toBe("t\n");
  });

  it("cancelling the task while Jev is deciding never runs the command, even when a yes arrives afterwards", async () => {
    const { h, execute } = await workerFixture([tool("bash", { command: "echo c > cancelled.txt" }), done]);
    h.classifier.answer = call => new Promise(resolve => call.signal?.addEventListener("abort", () => resolve("yes"), { once: true }));
    const abort = new AbortController();
    const running = execute({}, abort.signal);
    await vi.waitFor(() => expect(h.classifier.calls).toHaveLength(1));
    abort.abort();
    await running.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.classifier.calls[0]!.signal?.aborted).toBe(true);
    expect(await exists(join(h.cwd, "cancelled.txt"))).toBe(false);
  });
});

describe("orche_spawn sub-workers' bash", () => {
  it("each sub-worker call is reviewed once with its own request; no blocks it and the corrected command runs", async () => {
    const marks = await mkdtemp(join(tmpdir(), "orche-review-marks-"));
    dirs.push(marks);
    const firstUser = (context: Context) => JSON.stringify(context.messages.find(message => message.role === "user"));
    const subOf = (context: Context) => /You are sub-worker (W\d+\.\d+)/.exec(firstUser(context))?.[1];
    const turnOf = (context: Context) => context.messages.filter(message => message.role === "assistant").length;
    const respond: FauxResponseFactory = async context => {
      const sub = subOf(context);
      if (sub) {
        const turn = turnOf(context);
        if (turn === 0) return tool("bash", { command: `echo bad > ${join(marks, `${sub}-denied.txt`)}` }) as AssistantMessage;
        if (turn === 1) return tool("bash", { command: `echo good > ${join(marks, `${sub}-ok.txt`)}` }) as AssistantMessage;
        return tool("report_result", { kind: "answer", summary: `${sub} answered`, data: { evidence: [`${sub}-ok.txt`] } }) as AssistantMessage;
      }
      if (turnOf(context) === 0) return tool(SPAWN_TOOL, { reason: "parallelism", workers: [{ name: "first", role: "answer", request: "Answer question one." }, { name: "second", role: "answer", request: "Answer question two." }] }) as AssistantMessage;
      return tool("report_result", { kind: "answer", summary: "Both answered", data: { evidence: ["W1.1", "W1.2"], split: { decision: "split", criteria: ["parallelism"], reason: "two independent questions" } } }) as AssistantMessage;
    };
    const { h, pool } = await workerFixture(Array.from({ length: 10 }, () => respond));
    h.classifier.answer = deniesDenied;
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "single" }));
    const result = await pool.execute({ role: "answer", request: "Answer two questions.", cwd: h.cwd, projectTrusted: false, mainMode: "single" });
    expect(result.details.spawned?.map(worker => worker.status)).toEqual(["done", "done"]);
    for (const sub of ["W1.1", "W1.2"]) {
      expect(await exists(join(marks, `${sub}-denied.txt`))).toBe(false);
      expect(await readFile(join(marks, `${sub}-ok.txt`), "utf8")).toBe("good\n");
    }
    // Four bash calls, four reviews: none twice (the orchestrator's guard does not see its sub-workers' calls).
    expect(h.classifier.calls).toHaveLength(4);
    expect(h.classifier.calls.map(call => call.context.state.task).sort()).toEqual(["Answer question one.", "Answer question one.", "Answer question two.", "Answer question two."]);
  });
});
