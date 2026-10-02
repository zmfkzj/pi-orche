import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage as reply,
  fauxToolCall as call,
} from "@earendil-works/pi-ai";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { createSession } from "../../src/pi/session-factory.js";
import {
  BASH_HEARTBEAT_INTERVAL_MS,
  bashHeartbeatOf,
  createBashHeartbeatTool,
  type BashHeartbeat,
  type BashHeartbeatToolOptions,
} from "../../src/tools/bash.js";
import { createOrcheTools } from "../../src/tools/index.js";
import { fauxRuntime } from "../helpers/faux.js";

const linux = process.platform === "linux";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orche-bash-"));
  dirs.push(dir);
  return dir;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

type PartialResult = { content: Array<{ type: string; text?: string }>; details: unknown };
interface Outcome {
  result?: { content: unknown; details: unknown; isError?: boolean; structuredContent?: Record<string, unknown> };
  error?: string;
  partials: PartialResult[];
  heartbeats: BashHeartbeat[];
  callbackIds: string[];
}

/** Runs one command through a bash tool definition like Pi's agent loop does and records everything it emits. */
async function run(tool: ToolDefinition, params: { command: string; timeout?: number }, signal?: AbortSignal, watch?: (partial: PartialResult) => void): Promise<Outcome> {
  const partials: PartialResult[] = [];
  const out: Outcome = { partials, heartbeats: [], callbackIds: [] };
  try {
    out.result = (await tool.execute("call-1", params as never, signal, partial => {
      partials.push(partial as PartialResult);
      watch?.(partial as PartialResult);
    }, undefined as never)) as Outcome["result"];
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
  }
  for (const partial of partials) {
    const heartbeat = bashHeartbeatOf(partial.details);
    if (heartbeat) out.heartbeats.push(heartbeat);
  }
  return out;
}

function heartbeatTool(cwd: string, options: Omit<BashHeartbeatToolOptions, "cwd"> = {}): { tool: ToolDefinition; samples: BashHeartbeat[]; ids: string[] } {
  const samples: BashHeartbeat[] = [];
  const ids: string[] = [];
  const tool = createBashHeartbeatTool({
    cwd,
    intervalMs: 100,
    onHeartbeat: (sample, id) => {
      samples.push(sample);
      ids.push(id);
    },
    ...options,
  });
  return { tool, samples, ids };
}

/** A shell loop that runs until the test creates `file` (the test decides when a command ends, not a clock). */
const gate = (file: string) => `while [ ! -e ${JSON.stringify(file)} ]; do sleep 0.05; done`;
/** A silent CPU-bound process that runs until `file` exists. */
const busyUntil = (file: string) => `${JSON.stringify(process.execPath)} -e 'const fs = require("fs"); while (!fs.existsSync(process.argv[1]));' ${JSON.stringify(file)}`;

/** Starts `command(file)`, waits until `enough()`, releases the command and returns its outcome. */
async function released(tool: ToolDefinition, cwd: string, command: (file: string) => string, enough: () => boolean): Promise<Outcome> {
  const file = join(cwd, "release");
  const pending = run(tool, { command: command(file) });
  try {
    await until(enough);
  } finally {
    await writeFile(file, "");
  }
  return pending;
}

describe("bash heartbeat tool: samples", () => {
  it.skipIf(!linux)("a silent CPU-busy command yields progressing heartbeats with growing cpuMs", async () => {
    const cwd = await workspace();
    const { tool, samples, ids } = heartbeatTool(cwd);
    const out = await released(tool, cwd, busyUntil, () => samples.length >= 5);
    expect(out.error).toBeUndefined();
    expect(out.result?.isError).toBeFalsy();
    expect(out.heartbeats.map(h => h.seq)).toEqual(samples.map(h => h.seq));
    expect(ids.every(id => id === "call-1")).toBe(true);
    expect(samples.map(h => h.seq)).toEqual(samples.map((_, i) => i + 1));
    for (const h of samples) {
      expect(h.type).toBe("bash_heartbeat");
      expect(h.procAvailable).toBe(true);
      expect(h.outputBytes).toBe(0);
      expect(h.newOutput).toBe(false);
      expect(h.processes).toBeGreaterThanOrEqual(1);
      expect(h.cpuMs).toBeTypeOf("number");
      expect(h.at).toBeGreaterThan(1_600_000_000_000);
    }
    const cpu = samples.map(h => h.cpuMs!);
    for (let i = 1; i < cpu.length; i++) expect(cpu[i]!).toBeGreaterThanOrEqual(cpu[i - 1]!);
    expect(cpu.at(-1)! - cpu[0]!).toBeGreaterThanOrEqual(50);
    // silent, yet progressing: every sample after the first window saw the CPU move
    expect(samples.filter(h => h.progressing).length).toBeGreaterThanOrEqual(samples.length - 1);
    expect(samples.slice(1).every(h => h.cpuMs! > 0)).toBe(true);
    expect(samples[1]!.elapsedMs).toBeGreaterThan(samples[0]!.elapsedMs);
  });

  it.skipIf(!linux)("a silent idle command (sleep) is alive but not progressing", async () => {
    const { tool, samples } = heartbeatTool(await workspace());
    const controller = new AbortController();
    const pending = run(tool, { command: "sleep 30" }, controller.signal);
    await until(() => samples.length >= 5);
    controller.abort();
    await pending;
    for (const h of samples) {
      expect(h.procAvailable).toBe(true);
      expect(h.processes).toBeGreaterThanOrEqual(1);
      expect(h.outputBytes).toBe(0);
      expect(h.newOutput).toBe(false);
      expect(h.progressing).toBe(false);
    }
    // nothing at all moved: CPU and I/O are flat
    expect(new Set(samples.map(h => h.cpuMs)).size).toBe(1);
    if (samples[0]!.ioBytes !== undefined) expect(new Set(samples.map(h => h.ioBytes)).size).toBe(1);
  });

  it("a command that prints periodically is progressing through its output", async () => {
    const cwd = await workspace();
    const { tool, samples } = heartbeatTool(cwd);
    const out = await released(tool, cwd, file => `while [ ! -e ${JSON.stringify(file)} ]; do echo tick; sleep 0.25; done`, () => samples.length >= 8);
    expect(out.result?.isError).toBeFalsy();
    const fresh = samples.filter(h => h.newOutput);
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    for (const h of fresh) expect(h.progressing).toBe(true);
    const bytes = samples.map(h => h.outputBytes);
    for (let i = 1; i < bytes.length; i++) expect(bytes[i]!).toBeGreaterThanOrEqual(bytes[i - 1]!);
    expect(bytes.at(-1)!).toBeGreaterThan(0);
    expect(bytes.at(-1)! % "tick\n".length).toBe(0);
    // newOutput is exactly "outputBytes grew since the previous sample"
    for (let i = 1; i < samples.length; i++) expect(samples[i]!.newOutput).toBe(samples[i]!.outputBytes > samples[i - 1]!.outputBytes);
  });

  it("output-only progress works where /proc is unreadable: procAvailable false, proc fields omitted", async () => {
    const cwd = await workspace();
    const { tool, samples } = heartbeatTool(cwd, { procRoot: "/nonexistent-proc-root" });
    await released(tool, cwd, file => `while [ ! -e ${JSON.stringify(file)} ]; do echo tick; sleep 0.35; done`, () => samples.length >= 8);
    for (const h of samples) {
      expect(h.procAvailable).toBe(false);
      expect(Object.keys(h).sort()).toEqual(["at", "elapsedMs", "newOutput", "outputBytes", "procAvailable", "progressing", "seq", "type"]);
      expect(h.progressing).toBe(h.newOutput);
    }
    expect(samples.some(h => h.newOutput)).toBe(true);
    expect(samples.some(h => !h.progressing)).toBe(true);
  });

  it.skipIf(!linux)("finds the shell by scanning /proc when the diagnostics channel is not used", async () => {
    const cwd = await workspace();
    const { tool, samples } = heartbeatTool(cwd, { pidSource: "scan" });
    await released(tool, cwd, busyUntil, () => samples.length >= 4);
    expect(samples.every(h => h.procAvailable)).toBe(true);
    expect(samples.at(-1)!.cpuMs! - samples[0]!.cpuMs!).toBeGreaterThanOrEqual(30);
    expect(samples.filter(h => h.progressing).length).toBeGreaterThanOrEqual(samples.length - 1);
  });

  it.skipIf(!linux)("counts the whole process tree: a shell with two busy children", async () => {
    const cwd = await workspace();
    const { tool, samples } = heartbeatTool(cwd);
    await released(tool, cwd, file => `${busyUntil(file)} & ${busyUntil(file)} & wait`, () => samples.some(h => (h.processes ?? 0) >= 3 && (h.cpuMs ?? 0) > 50));
    expect(Math.max(...samples.map(h => h.processes ?? 0))).toBeGreaterThanOrEqual(3);
  });
});

describe("bash heartbeat tool: delivery", () => {
  it("sends the heartbeat as a partial update on top of the last partial Pi emitted, and to onHeartbeat", async () => {
    const cwd = await workspace();
    const { tool, samples } = heartbeatTool(cwd);
    const out = await released(tool, cwd, file => `echo hello; ${gate(file)}`, () => samples.length >= 3);
    // Pi's own first partial passes through untouched
    expect(out.partials[0]).toEqual({ content: [], details: undefined });
    const beats = out.partials.filter(p => bashHeartbeatOf(p.details));
    expect(beats.map(p => bashHeartbeatOf(p.details))).toEqual(samples);
    // content keeps what Pi last showed: the output so far
    expect(beats.at(-1)!.content).toEqual([{ type: "text", text: "hello\n" }]);
    expect(Object.keys(beats.at(-1)!.details as object)).toContain("heartbeat");
    // Pi's partials carry no heartbeat
    expect(out.partials.filter(p => !bashHeartbeatOf(p.details)).every(p => !(p.details && "heartbeat" in (p.details as object)))).toBe(true);
    // the final result does not
    expect(JSON.stringify(out.result)).not.toContain("heartbeat");
    expect(out.result?.content).toEqual([{ type: "text", text: "hello\n" }]);
  });

  it("keeps the details of the last partial next to the heartbeat", async () => {
    const cwd = await workspace();
    const { tool, samples } = heartbeatTool(cwd);
    const out = await released(tool, cwd, file => `seq 1 5000; ${gate(file)}`, () => samples.length >= 2);
    const beat = out.partials.filter(p => bashHeartbeatOf(p.details)).at(-1)!;
    const details = beat.details as { truncation?: { truncated: boolean }; fullOutputPath?: string; heartbeat: BashHeartbeat };
    expect(details.truncation?.truncated).toBe(true);
    expect(details.fullOutputPath).toBeTypeOf("string");
    expect(details.heartbeat.outputBytes).toBe(Array.from({ length: 5000 }, (_, i) => `${i + 1}\n`).join("").length);
  });

  it("works without an onUpdate callback (callback only)", async () => {
    const cwd = await workspace();
    const { tool, samples } = heartbeatTool(cwd);
    const file = join(cwd, "release");
    const pending = tool.execute("call-2", { command: `${gate(file)}; echo done` } as never, undefined, undefined, undefined as never);
    try {
      await until(() => samples.length >= 2);
    } finally {
      await writeFile(file, "");
    }
    expect(((await pending).content[0] as { text: string }).text).toBe("done\n");
  });

  it("bashHeartbeatOf only accepts a well-formed heartbeat", () => {
    const sample: BashHeartbeat = { type: "bash_heartbeat", seq: 1, at: 1, elapsedMs: 2, outputBytes: 0, newOutput: false, procAvailable: false, progressing: false };
    expect(bashHeartbeatOf({ heartbeat: sample })).toEqual(sample);
    expect(bashHeartbeatOf({ truncation: undefined, heartbeat: { ...sample, cpuMs: 5, ioBytes: 6, processes: 1 } })?.cpuMs).toBe(5);
    expect(bashHeartbeatOf(undefined)).toBeUndefined();
    expect(bashHeartbeatOf(null)).toBeUndefined();
    expect(bashHeartbeatOf("heartbeat")).toBeUndefined();
    expect(bashHeartbeatOf({})).toBeUndefined();
    expect(bashHeartbeatOf({ heartbeat: { ...sample, type: "other" } })).toBeUndefined();
    expect(bashHeartbeatOf({ heartbeat: { ...sample, seq: "1" } })).toBeUndefined();
    expect(bashHeartbeatOf({ heartbeat: { ...sample, progressing: 1 } })).toBeUndefined();
    expect(bashHeartbeatOf({ heartbeat: { ...sample, cpuMs: "5" } })).toBeUndefined();
  });

  it("defaults to a 15 s interval", () => {
    expect(BASH_HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });

  it("a command that ends before the first interval produces no heartbeat and no stray timers", async () => {
    const { tool, samples } = heartbeatTool(await workspace(), { intervalMs: 300 });
    const out = await run(tool, { command: "echo quick" });
    await sleep(700);
    expect(samples).toEqual([]);
    expect(out.heartbeats).toEqual([]);
    expect(out.result?.content).toEqual([{ type: "text", text: "quick\n" }]);
  });

  it("an onHeartbeat that throws does not disturb the command", async () => {
    const cwd = await workspace();
    let calls = 0;
    const tool = createBashHeartbeatTool({ cwd, intervalMs: 100, onHeartbeat: () => { calls++; throw new Error("observer"); } });
    const out = await released(tool, cwd, file => `${gate(file)}; echo ok`, () => calls >= 2);
    expect(out.error).toBeUndefined();
    expect(out.result?.content).toEqual([{ type: "text", text: "ok\n" }]);
    expect(out.heartbeats.length).toBeGreaterThanOrEqual(2);
  });
});

describe("bash heartbeat tool: timers", () => {
  it("stops sampling when the command is aborted", async () => {
    const { tool, samples } = heartbeatTool(await workspace());
    const controller = new AbortController();
    const pending = run(tool, { command: "sleep 30" }, controller.signal);
    await until(() => samples.length >= 2);
    controller.abort();
    const out = await pending;
    expect(out.error).toContain("Command aborted");
    const count = out.heartbeats.length;
    expect(count).toBeGreaterThanOrEqual(2);
    await sleep(500);
    expect(samples.length).toBe(count);
    expect(out.partials.filter(p => bashHeartbeatOf(p.details)).length).toBe(count);
  });

  it("stops sampling when the command times out, with Pi's timeout semantics", async () => {
    const { tool, samples } = heartbeatTool(await workspace());
    const started = Date.now();
    const out = await run(tool, { command: "sleep 30", timeout: 0.8 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.error).toBe("Command timed out after 0.8 seconds");
    const count = samples.length;
    expect(count).toBeGreaterThanOrEqual(1);
    await sleep(500);
    expect(samples.length).toBe(count);
  });

  it("stops sampling when the command cannot start", async () => {
    const { tool, samples } = heartbeatTool(await workspace());
    const out = await run(tool, { command: "echo x", timeout: -1 });
    expect(out.error).toBe("Invalid timeout: must be a finite number of seconds");
    await sleep(300);
    expect(samples).toEqual([]);
  });

  it("an already aborted signal never starts sampling", async () => {
    const { tool, samples } = heartbeatTool(await workspace());
    const controller = new AbortController();
    controller.abort();
    const out = await run(tool, { command: "sleep 5" }, controller.signal);
    expect(out.error).toContain("aborted");
    await sleep(300);
    expect(samples).toEqual([]);
  });
});

/** Pi's temp file for truncated output has a random name. */
const stable = (value: unknown) => JSON.stringify(value).replace(/pi-bash-[0-9a-f]+\.log/g, "pi-bash-<random>.log");

describe("bash heartbeat tool: identical to Pi's bash", () => {
  const strip = (outcome: Outcome) => {
    const { structuredContent, ...result } = outcome.result ?? ({} as NonNullable<Outcome["result"]>);
    const { wall_time_seconds, ...structured } = structuredContent ?? {};
    void wall_time_seconds;
    return { result, structured, error: outcome.error };
  };
  // [name, tool input, a marker that must be in Pi's own answer (so the comparison is not about two empty results)]
  const commands: Array<[string, { command: string; timeout?: number }, string]> = [
    ["a sample command", { command: "echo hello; printf 'no newline'" }, "no newline"],
    ["a command without output", { command: "true" }, "(no output)"],
    ["truncated large output (lines)", { command: "seq 1 6000" }, "[Showing lines 4001-6000 of 6000. Full output: "],
    ["truncated large output (bytes, one long line)", { command: "head -c 200000 /dev/zero | tr '\\0' 'x'" }, "of line 1 (line is 195.3KB). Full output: "],
    ["a non-zero exit", { command: "echo out; exit 3" }, "Command exited with code 3"],
    ["a non-zero exit without output", { command: "exit 7" }, "(no output)\n\nCommand exited with code 7"],
    ["a truncated non-zero exit", { command: "seq 1 4000; exit 2" }, "Full output: "],
    ["a command killed by a signal", { command: "kill -TERM $$" }, "Command exited with code 143"],
    ["a timeout", { command: "echo partial; sleep 30", timeout: 0.4 }, "partial\n\n\nCommand timed out after 0.4 seconds"],
    ["a timeout with truncated output", { command: "seq 1 4000; sleep 30", timeout: 0.6 }, "Full output: "],
  ];

  for (const [name, params, marker] of commands) {
    it(`gives the same result for ${name}`, async () => {
      const cwd = await workspace();
      const plain = await run(createBashToolDefinition(cwd) as unknown as ToolDefinition, params);
      const wrapped = await run(heartbeatTool(cwd, { intervalMs: 50 }).tool, params);
      const text = (o: Outcome) => (o.result?.content as Array<{ text: string }> | undefined)?.map(c => c.text).join("") ?? o.error;
      expect(text(plain)).toContain(marker);
      expect(stable(strip(wrapped))).toBe(stable(strip(plain)));
      expect(wrapped.result === undefined).toBe(plain.result === undefined);
      if (plain.result) expect(wrapped.result!.isError).toBe(plain.result.isError);
      // byte-identical model-facing text
      expect(text(wrapped)?.replace(/pi-bash-[0-9a-f]+\.log/, "")).toBe(text(plain)?.replace(/pi-bash-[0-9a-f]+\.log/, ""));
    });
  }

  it("gives the same error for an aborted command", async () => {
    const cwd = await workspace();
    const outcomes: Outcome[] = [];
    for (const tool of [createBashToolDefinition(cwd) as unknown as ToolDefinition, heartbeatTool(cwd).tool]) {
      const controller = new AbortController();
      const partials: unknown[] = [];
      const pending = run(tool, { command: "echo before; sleep 30" }, controller.signal, partial => partials.push(partial));
      await until(() => partials.some(p => JSON.stringify(p).includes("before")));
      controller.abort();
      outcomes.push(await pending);
    }
    expect(outcomes[1]!.error).toBe(outcomes[0]!.error);
    expect(outcomes[1]!.error).toBe("before\n\n\nCommand aborted");
  });

  it("reports a missing working directory like Pi", async () => {
    const cwd = join(await workspace(), "missing");
    const plain = await run(createBashToolDefinition(cwd) as unknown as ToolDefinition, { command: "echo x" });
    const wrapped = await run(heartbeatTool(cwd).tool, { command: "echo x" });
    expect(wrapped.error).toBe(plain.error);
    expect(wrapped.error).toContain("Working directory does not exist");
  });

  it("is the same tool as Pi's from the model's side: name, label, description, schemas, prompt text", async () => {
    const cwd = await workspace();
    const plain = createBashToolDefinition(cwd);
    const wrapped = heartbeatTool(cwd).tool as unknown as ReturnType<typeof createBashToolDefinition>;
    expect(wrapped.name).toBe("bash");
    for (const key of ["name", "label", "description", "promptSnippet", "promptGuidelines", "constrainedSampling"] as const) {
      expect(wrapped[key]).toEqual(plain[key]);
    }
    expect(JSON.stringify(wrapped.parameters)).toBe(JSON.stringify(plain.parameters));
    expect(JSON.stringify(wrapped.outputSchema)).toBe(JSON.stringify(plain.outputSchema));
    expect(wrapped.renderCall).toBeTypeOf("function");
    expect(wrapped.renderResult).toBeTypeOf("function");
  });

  it("keeps Pi's other options working: command prefix and spawn hook", async () => {
    const cwd = await workspace();
    const options = { commandPrefix: "export PREFIXED=yes", spawnHook: (ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({ ...ctx, env: { ...ctx.env, HOOKED: "1" } }) };
    const params = { command: 'echo "$PREFIXED $HOOKED"' };
    const plain = await run(createBashToolDefinition(cwd, options) as unknown as ToolDefinition, params);
    const wrapped = await run(heartbeatTool(cwd, options).tool, params);
    expect((wrapped.result!.content as Array<{ text: string }>)[0]!.text).toBe("yes 1\n");
    expect(stable(strip(wrapped))).toBe(stable(strip(plain)));
  });
});

describe("registration", () => {
  it("createOrcheTools adds the heartbeat bash only when asked (the main Pi session keeps Pi's own)", () => {
    expect(createOrcheTools({ cwd: process.cwd() }).map(t => t.name)).not.toContain("bash");
    const tools = createOrcheTools({ cwd: process.cwd(), bashHeartbeat: { intervalMs: 1000 } });
    expect(tools.filter(t => t.name === "bash")).toHaveLength(1);
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["read", "edit", "find", "ast_search", "ast_rewrite", "diagnostics"]));
    expect(createOrcheTools({ cwd: process.cwd(), bashHeartbeat: {} }).some(t => t.name === "bash")).toBe(true);
  });
});

describe("through a real session", () => {
  const beatOf = (event: { type: string; partialResult?: { details?: unknown } }) => (event.type === "tool_execution_update" ? bashHeartbeatOf(event.partialResult?.details) : undefined);

  /** The model runs `command(file)` once; the command is released after `beats` heartbeats were seen. */
  async function drive(sessionOptions: { bashHeartbeat?: { intervalMs?: number } }, command: (file: string) => string, beats: number) {
    const f = await fauxRuntime();
    const cwd = await workspace();
    const file = join(cwd, "release");
    f.faux.setResponses([
      reply([call("bash", { command: command(file) }, { id: "bash-1" })], { stopReason: "toolUse" }),
      reply("done"),
    ]);
    const session = await createSession({ route: f.route, cwd, tools: ["bash"], instructions: "test", modelRuntime: f.runtime, ...sessionOptions });
    const events: Array<{ type: string; toolCallId?: string; partialResult?: { content: unknown; details: unknown }; result?: { content: unknown; details: unknown }; isError?: boolean }> = [];
    let seen = 0;
    session.subscribe(event => {
      if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;
      events.push(event as never);
      if (beatOf(event as never) && ++seen === beats) void writeFile(file, "");
    });
    try {
      if (beats === 0) await writeFile(file, "");
      await session.prompt("go");
      const toolResult = (session.messages as Array<{ role: string; content?: Array<{ text?: string }> }>).find(m => m.role === "toolResult");
      return { events, text: toolResult?.content?.map(c => c.text).join("") };
    } finally {
      session.dispose();
    }
  }

  it("the SDK forwards the partial updates as tool_execution_update events carrying details.heartbeat", async () => {
    const { events, text } = await drive({ bashHeartbeat: { intervalMs: 100 } }, file => `echo started; ${gate(file)}`, 3);
    const updates = events.filter(e => e.type === "tool_execution_update");
    const beats = updates.map(beatOf as never).filter((h): h is BashHeartbeat => h !== undefined);
    expect(beats.length).toBeGreaterThanOrEqual(3);
    expect(beats.map(h => h.seq)).toEqual(beats.map((_, i) => i + 1));
    expect(updates.every(e => e.toolCallId === "bash-1")).toBe(true);
    // heartbeats arrive between tool start and tool end, and the final result is Pi's
    const order = events.map(e => e.type);
    expect(order[0]).toBe("tool_execution_start");
    expect(order.at(-1)).toBe("tool_execution_end");
    const end = events.at(-1)!;
    expect(JSON.stringify(end.result)).not.toContain("heartbeat");
    expect(text).toBe("started\n");
  });

  it("sessions without the option still get the heartbeat tool (15 s default: none inside a short command)", async () => {
    const { events, text } = await drive({}, () => "echo short", 0);
    expect(events.filter(e => beatOf(e))).toEqual([]);
    expect(text).toBe("short\n");
  });

  it("AgentManager.spawn forwards bashHeartbeat to its session's bash", async () => {
    const f = await fauxRuntime();
    const cwd = await workspace();
    const file = join(cwd, "release");
    f.faux.setResponses([
      reply([call("bash", { command: gate(file) }, { id: "bash-2" })], { stopReason: "toolUse" }),
      reply("done"),
    ]);
    const manager = new AgentManager(f.runtime);
    try {
      await manager.spawn({ id: "w", role: "worker", route: f.route, modelRuntime: f.runtime, cwd, instructions: "x", bashHeartbeat: { intervalMs: 100 } });
      const beats: BashHeartbeat[] = [];
      manager.session("w").subscribe(event => {
        const h = beatOf(event as never);
        if (h) {
          beats.push(h);
          if (beats.length === 2) void writeFile(file, "");
        }
      });
      await manager.session("w").prompt("go");
      expect(beats.length).toBeGreaterThanOrEqual(2);
    } finally {
      await manager.dispose();
    }
  });
});
