import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import type { ManagerEvent } from "../../src/agent/agent-handle.js";
import { LivenessTracker, parseBashHeartbeat, type SessionEventLike, type SessionLiveness } from "../../src/agent/liveness.js";
import { bashHeartbeatOf, type BashHeartbeat } from "../../src/tools/bash.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * End to end: a real worker (AgentManager + real AgentSession + the faux model) runs the real heartbeat `bash` tool, and the
 * liveness API answers "is it still working?" for commands that print nothing. The intervals are shortened through
 * `bashHeartbeat: { intervalMs }` in the spawn options; no timeout or limit is involved.
 */

const linux = process.platform === "linux";
const INTERVAL_MS = 100;
const managers: AgentManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

/** A silent CPU-bound process that runs until `file` exists. */
const busyUntil = (file: string) => `${JSON.stringify(process.execPath)} -e 'const fs = require("fs"); while (!fs.existsSync(process.argv[1]));' ${JSON.stringify(file)}`;
/** Prints a line every 200 ms until `file` exists. */
const tickUntil = (file: string) => `while [ ! -e ${JSON.stringify(file)} ]; do echo tick; sleep 0.2; done`;

type ToolEvent = { type: string; toolCallId?: string; partialResult?: { content?: unknown; details?: unknown } };

/** Spawns worker W1, scripts its model to run `command(file)` in bash and then report, and starts the assignment. */
async function launch(command: (releaseFile: string) => string) {
  const f = await fauxRuntime();
  const cwd = await mkdtemp(join(tmpdir(), "orche-live-bash-"));
  dirs.push(cwd);
  const releaseFile = join(cwd, "release");
  f.faux.setResponses([
    reply([call("bash", { command: command(releaseFile) }, { id: "bash-1" })], { stopReason: "toolUse" }),
    reply([call("report_result", { kind: "explore", summary: "done" })], { stopReason: "toolUse" }),
  ]);
  const m = new AgentManager(f.runtime);
  managers.push(m);
  await m.spawn({ id: "W1", role: "worker", route: f.route, modelRuntime: f.runtime, cwd, instructions: "x", bashHeartbeat: { intervalMs: INTERVAL_MS } });

  /** Every heartbeat the worker's bash tool emitted, as the agent event stream carried it. */
  const beats: BashHeartbeat[] = [];
  /** Heartbeats the liveness parser reads differently from how the tool built them (none, or the shapes disagree). */
  const parseMismatches: BashHeartbeat[] = [];
  /** A tracker that sees the same events except the heartbeats: what liveness would know without the heartbeat tool. */
  const withoutHeartbeats = new LivenessTracker({ id: "W1", role: "worker" });
  /** The verdict at the instant each plain (non-heartbeat) output update of the tool arrived. */
  const atOutput: SessionLiveness[] = [];
  const stateChanges: Extract<ManagerEvent, { type: "liveness" }>[] = [];
  m.subscribe(event => {
    if (event.type === "liveness") stateChanges.push(event);
  });
  m.session("W1").subscribe(event => {
    const update = event as unknown as ToolEvent;
    const details = update.type === "tool_execution_update" ? update.partialResult?.details : undefined;
    const beat = bashHeartbeatOf(details);
    if (beat) {
      // What the tool sends and what the liveness parser reads must be the same thing.
      if (JSON.stringify(parseBashHeartbeat(details)) !== JSON.stringify(beat)) parseMismatches.push(beat);
      beats.push(beat);
      return;
    }
    withoutHeartbeats.observe(event as unknown as SessionEventLike);
    if (update.type === "tool_execution_update" && JSON.stringify(update.partialResult?.content).includes("tick")) atOutput.push(m.workerLiveness("W1", Date.now(), 1000));
  });

  const assignedAt = Date.now();
  m.assign("W1", "explore", "go");
  return {
    m,
    beats,
    parseMismatches,
    withoutHeartbeats,
    atOutput,
    stateChanges,
    assignedAt,
    elapsed: () => Date.now() - assignedAt,
    release: () => writeFile(releaseFile, ""),
  };
}

describe("worker liveness with the real heartbeat bash tool", () => {
  it.skipIf(!linux)("(a) a silent CPU-busy command is active through a progressing heartbeat", async () => {
    const w = await launch(busyUntil);
    const window = 1200;
    await until(() => w.beats.filter(b => b.progressing).length >= 3 && w.elapsed() > window + 600);

    const now = Date.now();
    const verdict = w.m.liveness(now, window);
    expect(verdict.active).toBe(true);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/^W1 bash running \d+s, cpu\/io activity \d+s ago \(cpu [\d.]+(?:ms|s), \d+ procs?\)$/);
    expect(verdict.sessions).toHaveLength(1);
    const session = verdict.sessions[0]!;
    expect(session).toMatchObject({ id: "W1", role: "worker", state: "tool", active: true });
    expect(now - session.lastSignalAt!).toBeLessThanOrEqual(window);
    expect(w.m.workerLiveness("W1", now, window)).toMatchObject({ active: true, state: "tool" });

    // The command printed nothing and is long past the window: without the heartbeat nothing says it is alive.
    expect(w.beats.every(b => b.outputBytes === 0 && !b.newOutput)).toBe(true);
    const blind = w.withoutHeartbeats.liveness(now, window);
    expect(blind.active).toBe(false);
    expect(blind.sessions[0]!.state).toBe("tool");

    // The samples behind the verdict: /proc readable, CPU time growing, the shell and the node it runs counted.
    expect(w.parseMismatches).toEqual([]);
    expect(w.beats.every(b => b.procAvailable)).toBe(true);
    const cpu = w.beats.map(b => b.cpuMs!);
    for (let i = 1; i < cpu.length; i++) expect(cpu[i]!).toBeGreaterThanOrEqual(cpu[i - 1]!);
    expect(cpu.at(-1)!).toBeGreaterThan(cpu[0]!);
    expect(w.beats.filter(b => b.progressing).length).toBeGreaterThanOrEqual(w.beats.length - 1);

    // Released, the command ends, the worker reports, and nothing is active any more.
    await w.release();
    expect(await w.m.wait("W1", 10_000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(w.m.workerLiveness("W1", Date.now(), window)).toMatchObject({ state: "idle", active: false });
    expect(w.m.liveness(Date.now(), window)).toMatchObject({ active: false, reasons: [] });
  });

  it("(b) a silent idle command (sleep) is alive but not progressing and, after the window, not active", async () => {
    const w = await launch(() => "sleep 30");
    await until(() => w.beats.length >= 3);

    // Just started: the tool start is a recent signal, and the heartbeats say the process is alive but doing nothing.
    const early = w.m.workerLiveness("W1", Date.now(), 60_000);
    expect(early.state).toBe("tool");
    expect(early.active).toBe(true);
    expect(early.detail).toMatch(/^bash running \d+s, no output yet, alive but not progressing/);

    const window = 500;
    await until(() => w.elapsed() > window + 1000);
    const now = Date.now();
    const late = w.m.liveness(now, window);
    expect(late.active).toBe(false);
    expect(late.reasons).toEqual([]);
    expect(late.sessions).toHaveLength(1);
    expect(late.sessions[0]).toMatchObject({ id: "W1", state: "tool", active: false });
    expect(late.sessions[0]!.detail).toMatch(/^bash running \d+s, no output yet, alive but not progressing/);
    // The window is the only thing that decides: with the start inside a large window the same worker counts.
    expect(w.m.liveness(now, 60_000).active).toBe(true);

    // Every sample: alive, silent, nothing moved.
    expect(w.beats.length).toBeGreaterThanOrEqual(5);
    for (const b of w.beats) {
      expect(b.progressing).toBe(false);
      expect(b.newOutput).toBe(false);
      expect(b.outputBytes).toBe(0);
    }
    if (linux) {
      expect(w.beats.every(b => b.procAvailable && (b.processes ?? 0) >= 1)).toBe(true);
      expect(new Set(w.beats.map(b => b.cpuMs)).size).toBe(1);
      expect(late.sessions[0]!.detail).toMatch(/\(cpu \d+ms, \d+ procs?\)$/);
    }

    // Only state changes reach the event stream, not the ~dozen heartbeats.
    expect(w.stateChanges.map(e => e.state)).toEqual(w.stateChanges.map(e => e.state).filter((state, i, all) => state !== all[i - 1]));
    expect(w.stateChanges.length).toBeLessThan(w.beats.length);
    expect(w.stateChanges.at(-1)).toMatchObject({ agentId: "W1", role: "worker", state: "tool", detail: "bash" });

    // Stopping ends the command; the worker is idle again.
    await w.m.stop("W1");
    expect(w.m.workerLiveness("W1", Date.now(), 60_000)).toMatchObject({ state: "idle", active: false });
    expect(w.m.liveness(Date.now(), 60_000).active).toBe(false);
  });

  it("(c) a command that prints periodically is active through its output", async () => {
    const w = await launch(tickUntil);
    const window = 1000;
    await until(() => w.beats.filter(b => b.newOutput).length >= 2 && w.atOutput.length >= 3);

    const verdict = w.m.liveness(Date.now(), window);
    expect(verdict.active).toBe(true);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/^W1 bash running \d+s, (?:output|cpu\/io activity) \d+s ago/);
    expect(verdict.sessions[0]).toMatchObject({ id: "W1", state: "tool", active: true });

    // At the instant each piece of output arrived the session was active, and the reason named that output.
    for (const verdict of w.atOutput) {
      expect(verdict.active).toBe(true);
      expect(verdict.detail).toMatch(/^bash running \d+s, output 0s ago/);
    }
    // The samples that saw output are progressing, and outputBytes only grows (5 bytes per tick).
    const fresh = w.beats.filter(b => b.newOutput);
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    for (const b of fresh) expect(b.progressing).toBe(true);
    const bytes = w.beats.map(b => b.outputBytes);
    for (let i = 1; i < bytes.length; i++) expect(bytes[i]!).toBeGreaterThanOrEqual(bytes[i - 1]!);
    expect(bytes.at(-1)! % "tick\n".length).toBe(0);
    expect(bytes.at(-1)!).toBeGreaterThan(0);

    await w.release();
    expect(await w.m.wait("W1", 10_000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(w.m.workerLiveness("W1", Date.now(), window)).toMatchObject({ state: "idle", active: false });
  });

  it("a worker without an assignment is idle and never active, whatever its tools did before", async () => {
    const w = await launch(tickUntil);
    await until(() => w.beats.length >= 1);
    expect(w.m.liveness(Date.now(), 60_000).active).toBe(true);
    await w.release();
    await w.m.wait("W1", 10_000);
    const after = w.m.liveness(Date.now(), 60_000);
    expect(after).toMatchObject({ active: false, reasons: [] });
    expect(after.sessions).toEqual([expect.objectContaining({ id: "W1", state: "idle", active: false })]);
  });
});
