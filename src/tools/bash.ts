import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe } from "node:diagnostics_channel";
import { readdirSync, readFileSync } from "node:fs";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type BashToolOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { coerceIntegerArguments } from "./prepare-arguments.js";

/**
 * `bash` with a heartbeat. A shell command that prints nothing (a long build, a test run, `sleep`, a network wait) emits
 * no events between tool start and tool end, so "still working" and "hung" look the same from outside. This tool is
 * Pi's own `bash` (built with `createBashToolDefinition`, so schema, description, output truncation, result text,
 * exit-code and timeout semantics are Pi's, unchanged) whose command execution is observed from the side:
 *
 * - every `intervalMs` while the command runs a {@link BashHeartbeat} sample is recorded: output bytes so far, whether
 *   output appeared since the previous sample and, on Linux, the CPU time and I/O volume of the command's process tree
 *   read from `/proc`;
 * - each sample is delivered as a tool *partial update* (`tool_execution_update`, `partialResult.details.heartbeat`;
 *   read it back with {@link bashHeartbeatOf}) and to the optional `onHeartbeat` callback.
 *
 * Heartbeats are a side channel: they never reach the final result (content and details are exactly what Pi's tool
 * returned), the underlying execution is called with the very same arguments (`timeout`, `signal`, `env`), and every
 * timer dies with the command (completion, error, timeout kill or abort).
 *
 * Process tree. Pi spawns the shell detached (its own process group, `pgid == pid`). The pid is learned exactly from
 * Node's `child_process` diagnostics channel, correlated with the running tool call through AsyncLocalStorage (no env
 * marker or command rewrite that the model could see); where that channel is missing the direct children of this
 * process that are group leaders started after the command are used. The tree is that process plus its descendants
 * plus the rest of its process group (orphans reparented to init stay in the group).
 *
 * Progress signals (`/proc/<pid>/stat`, `/proc/<pid>/io`):
 * - `cpuMs`: utime + stime of the tree, plus cutime + cstime (children already reaped), in ms. The reaped-children
 *   part keeps the sum from dropping when short-lived children exit (a build running many compilers), and the value
 *   is kept monotonic. CPU time cannot be spent by a process that is blocked.
 * - `ioBytes`: rchar + wchar of the tree. A process that exits takes its counter with it, so the last value seen of
 *   every process of the command is retained: the total only grows.
 * Unreadable `/proc` (not Linux, restricted, process already gone) is fail-soft: `procAvailable: false`, the numeric
 * proc fields are omitted and `progressing` falls back to output alone.
 */

/** Default time between two heartbeat samples of a running command. */
export const BASH_HEARTBEAT_INTERVAL_MS = 15_000;

/** One sample of a running bash command; the contract that liveness tracking parses structurally. */
export interface BashHeartbeat {
  type: "bash_heartbeat";
  /** 1, 2, ... per command. */
  seq: number;
  /** Epoch ms of the sample. */
  at: number;
  /** Time since the command started. */
  elapsedMs: number;
  /** Bytes of stdout + stderr produced so far (before Pi's truncation). */
  outputBytes: number;
  /** Output grew since the previous sample. */
  newOutput: boolean;
  /** CPU time of the process tree so far (ms); Linux only. */
  cpuMs?: number;
  /** rchar + wchar of the process tree so far; Linux only, when `/proc/<pid>/io` is readable. */
  ioBytes?: number;
  /** Live processes of the tree. */
  processes?: number;
  /** `/proc` could be read for this sample. */
  procAvailable: boolean;
  /** Output grew, or CPU time grew, or I/O grew since the previous sample (the first one compares with the start). */
  progressing: boolean;
}

export interface BashHeartbeatConfig {
  /** Time between samples (default {@link BASH_HEARTBEAT_INTERVAL_MS}). */
  intervalMs?: number;
  /** Called with every sample and the tool call id, next to the partial update. Errors are swallowed. */
  onHeartbeat?: (sample: BashHeartbeat, toolCallId: string) => void;
}

export interface BashHeartbeatToolOptions extends BashHeartbeatConfig, Omit<BashToolOptions, "operations"> {
  cwd: string;
  /** Command execution to observe (default: Pi's local bash backend). */
  operations?: BashOperations;
  /** Test seam: where `/proc` is. */
  procRoot?: string;
  /** Test seam: `"scan"` skips the diagnostics channel and finds the shell by scanning `/proc`. */
  pidSource?: "auto" | "scan";
}

/** The heartbeat a tool partial result (or its `details`) carries, if it carries one. */
export function bashHeartbeatOf(details: unknown): BashHeartbeat | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { heartbeat?: unknown }).heartbeat;
  if (!value || typeof value !== "object") return undefined;
  const h = value as Record<string, unknown>;
  const num = (key: string) => typeof h[key] === "number" && Number.isFinite(h[key]);
  const bool = (key: string) => typeof h[key] === "boolean";
  const optNum = (key: string) => h[key] === undefined || num(key);
  if (h.type !== "bash_heartbeat") return undefined;
  if (!num("seq") || !num("at") || !num("elapsedMs") || !num("outputBytes")) return undefined;
  if (!bool("newOutput") || !bool("procAvailable") || !bool("progressing")) return undefined;
  if (!optNum("cpuMs") || !optNum("ioBytes") || !optNum("processes")) return undefined;
  return value as BashHeartbeat;
}

// ---------------------------------------------------------------------------------------------------------------------
// /proc
// ---------------------------------------------------------------------------------------------------------------------

/** USER_HZ: clock ticks per second in /proc/<pid>/stat (100 on every mainstream Linux). */
const CLOCK_TICKS_PER_SECOND = 100;
/** `/proc` is read synchronously (several times cheaper than async I/O for hundreds of tiny files); yield this often. */
const YIELD_EVERY = 512;
/** A command whose shell the diagnostics channel has not named after this long is looked for by scanning `/proc`. */
const CHANNEL_GRACE_MS = 1000;

interface ProcEntry {
  pid: number;
  ppid: number;
  pgrp: number;
  state: string;
  /** utime + stime, clock ticks. */
  ticks: number;
  /** cutime + cstime (reaped children), clock ticks. */
  childTicks: number;
  /** Start time, clock ticks since boot. */
  start: number;
}

function parseStat(text: string): ProcEntry | undefined {
  // `pid (comm) state ppid pgrp ...`; comm may contain spaces and parentheses, so split after the last ')'.
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close < open) return undefined;
  const f = text.slice(close + 2).split(" ");
  const n = (index: number) => Number(f[index]);
  const entry: ProcEntry = {
    pid: Number(text.slice(0, open)),
    state: f[0] ?? "",
    ppid: n(1),
    pgrp: n(2),
    ticks: n(11) + n(12),
    childTicks: n(13) + n(14),
    start: n(19),
  };
  return [entry.pid, entry.ppid, entry.pgrp, entry.ticks, entry.childTicks, entry.start].every(Number.isFinite) ? entry : undefined;
}

/** Every process of the system, or undefined when `/proc` cannot be listed. */
async function scanProc(root: string): Promise<Map<number, ProcEntry> | undefined> {
  let names: string[];
  try {
    names = readdirSync(root).filter(name => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  const procs = new Map<number, ProcEntry>();
  for (let i = 0; i < names.length; i++) {
    try {
      const entry = parseStat(readFileSync(`${root}/${names[i]}/stat`, "utf8"));
      if (entry) procs.set(entry.pid, entry);
    } catch { /* gone, or not ours to read */ }
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise(resolve => setImmediate(resolve));
  }
  return procs.size ? procs : undefined;
}

function readIoBytes(root: string, pid: number): number | undefined {
  try {
    const text = readFileSync(`${root}/${pid}/io`, "utf8");
    const rchar = /^rchar:\s*(\d+)/m.exec(text)?.[1];
    const wchar = /^wchar:\s*(\d+)/m.exec(text)?.[1];
    return rchar === undefined || wchar === undefined ? undefined : Number(rchar) + Number(wchar);
  } catch {
    return undefined;
  }
}

interface ProcSample {
  cpuMs: number;
  ioBytes?: number;
  processes: number;
}

/** Cumulative CPU / I/O of one command's process tree. */
class ProcSampler {
  /** Last rchar + wchar seen per live process (`pid:start`). */
  private readonly io = new Map<string, number>();
  /** rchar + wchar of processes that are gone. */
  private retiredIo = 0;
  private sawIo = false;
  private cpuHigh = 0;

  constructor(private readonly root: string) {}

  async sample(rootPid: number): Promise<ProcSample | undefined> {
    const procs = await scanProc(this.root);
    const top = procs?.get(rootPid);
    if (!procs || !top || top.state === "Z" || top.state === "X") return undefined;
    const children = new Map<number, number[]>();
    for (const p of procs.values()) {
      const siblings = children.get(p.ppid);
      if (siblings) siblings.push(p.pid);
      else children.set(p.ppid, [p.pid]);
    }
    const members = new Set<number>([rootPid]);
    // The shell is a group leader: group members that were reparented to init after their parent died still count.
    if (top.pgrp === rootPid) for (const p of procs.values()) if (p.pgrp === rootPid) members.add(p.pid);
    const queue = [...members];
    for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
      for (const child of children.get(pid) ?? []) {
        if (members.has(child)) continue;
        members.add(child);
        queue.push(child);
      }
    }

    let ticks = 0;
    const live: ProcEntry[] = [];
    for (const pid of members) {
      const p = procs.get(pid)!;
      ticks += p.ticks + p.childTicks;
      if (p.state !== "Z") live.push(p);
    }
    this.cpuHigh = Math.max(this.cpuHigh, Math.round((ticks * 1000) / CLOCK_TICKS_PER_SECOND));

    const seen = new Set(live.map(p => `${p.pid}:${p.start}`));
    const values = live.map(p => readIoBytes(this.root, p.pid));
    live.forEach((p, i) => {
      const value = values[i];
      if (value === undefined) return;
      const key = `${p.pid}:${p.start}`;
      this.io.set(key, Math.max(this.io.get(key) ?? 0, value));
      this.sawIo = true;
    });
    for (const [key, value] of this.io) {
      if (seen.has(key)) continue;
      this.retiredIo += value;
      this.io.delete(key);
    }
    let io = this.retiredIo;
    for (const value of this.io.values()) io += value;
    return { cpuMs: this.cpuHigh, ...(this.sawIo ? { ioBytes: io } : {}), processes: live.length };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Running command
// ---------------------------------------------------------------------------------------------------------------------

type BashResult = AgentToolResult<unknown>;

const running = new AsyncLocalStorage<HeartbeatRun>();
/** Shells already attributed to a running command (scan fallback only). */
const claimed = new Set<number>();
let channelInstalled = false;

/**
 * Node publishes every spawned ChildProcess here, synchronously inside `spawn()` (so the AsyncLocalStorage store is the
 * caller's) but before the pid is assigned: keep the object, read `pid` later.
 */
function installChildProcessChannel(): void {
  if (channelInstalled) return;
  channelInstalled = true;
  try {
    subscribe("child_process", message => {
      const run = running.getStore();
      const child = (message as { process?: { pid?: number } } | undefined)?.process;
      if (run?.capturing && run.child === undefined && child && typeof child === "object") run.child = child;
    });
  } catch { /* no channel: the /proc scan finds the shell */ }
}

function sanitizeInterval(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.floor(value), 5), 2_147_483_647) : BASH_HEARTBEAT_INTERVAL_MS;
}

/** One execution of the tool: counts output, samples the process tree and reports heartbeats while the command runs. */
class HeartbeatRun {
  /** The shell's ChildProcess, as published by Node's diagnostics channel. */
  child: { pid?: number } | undefined;
  private pid: number | undefined;
  capturing = false;
  private outputBytes = 0;
  private startedAt = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private sampling = false;
  private abortHandler: (() => void) | undefined;
  private signal: AbortSignal | undefined;
  private claimedPid: number | undefined;
  private prevOutputBytes = 0;
  private prevCpuMs = 0;
  private prevIoBytes = 0;
  private lastPartial: BashResult | undefined;
  private readonly sampler: ProcSampler | undefined;

  constructor(
    private readonly toolCallId: string,
    private readonly options: { intervalMs: number; procRoot: string; scanOnly: boolean; onHeartbeat?: BashHeartbeatConfig["onHeartbeat"]; procEnabled: boolean },
    private readonly onUpdate: ((partial: BashResult) => void) | undefined,
  ) {
    this.sampler = options.procEnabled ? new ProcSampler(options.procRoot) : undefined;
  }

  /** Pi's partial updates pass through untouched (and without one Pi gets none); the last one is the base of every heartbeat partial. */
  updates(): ((partial: BashResult) => void) | undefined {
    const { onUpdate } = this;
    if (!onUpdate) return undefined;
    return partial => {
      this.lastPartial = partial;
      onUpdate(partial);
    };
  }

  /** The observed execution: same arguments, output counted on the way through. */
  async exec(base: BashOperations, command: string, cwd: string, options: Parameters<BashOperations["exec"]>[2]): ReturnType<BashOperations["exec"]> {
    this.start(options.signal);
    try {
      this.capturing = !this.options.scanOnly;
      return await base.exec(command, cwd, {
        ...options,
        onData: data => {
          this.outputBytes += data.length;
          options.onData(data);
        },
      });
    } finally {
      this.capturing = false;
      this.stop();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.timer = this.probeTimer = undefined;
    if (this.signal && this.abortHandler) this.signal.removeEventListener("abort", this.abortHandler);
    this.signal = this.abortHandler = undefined;
    if (this.claimedPid !== undefined) claimed.delete(this.claimedPid);
    this.claimedPid = undefined;
  }

  private start(signal: AbortSignal | undefined): void {
    if (this.startedAt) return;
    this.startedAt = performance.now();
    if (signal) {
      this.signal = signal;
      this.abortHandler = () => this.stop();
      if (signal.aborted) this.stop();
      else signal.addEventListener("abort", this.abortHandler, { once: true });
    }
    if (this.stopped) return;
    const { intervalMs } = this.options;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    // The first sample is compared with the state shortly after the shell started, not with an all-zero process.
    this.probeTimer = setTimeout(() => void this.baseline(), Math.min(250, Math.max(1, Math.floor(intervalMs / 3))));
    this.probeTimer.unref();
  }

  private async readProc(): Promise<ProcSample | undefined> {
    if (!this.sampler) return undefined;
    // The diagnostics channel names the shell within microseconds of the spawn; scanning is for runtimes without it.
    this.pid ??= this.child?.pid;
    if (this.pid === undefined && (this.options.scanOnly || performance.now() - this.startedAt >= CHANNEL_GRACE_MS)) this.pid = await this.scanForShell();
    if (this.pid === undefined) return undefined;
    try {
      return await this.sampler.sample(this.pid);
    } catch {
      return undefined;
    }
  }

  private async baseline(): Promise<void> {
    if (this.stopped || this.sampling || this.seq > 0) return;
    this.sampling = true;
    try {
      const proc = await this.readProc();
      if (this.stopped || this.seq > 0) return;
      this.prevOutputBytes = this.outputBytes;
      if (proc) {
        this.prevCpuMs = proc.cpuMs;
        this.prevIoBytes = proc.ioBytes ?? 0;
      }
    } finally {
      this.sampling = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.sampling) return;
    this.sampling = true;
    try {
      const proc = await this.readProc();
      if (this.stopped) return;
      this.report(proc);
    } catch { /* a failed sample is skipped, never the command */ } finally {
      this.sampling = false;
    }
  }

  private report(proc: ProcSample | undefined): void {
    const outputBytes = this.outputBytes;
    const newOutput = outputBytes > this.prevOutputBytes;
    const cpuGrew = proc !== undefined && proc.cpuMs > this.prevCpuMs;
    const ioGrew = proc?.ioBytes !== undefined && proc.ioBytes > this.prevIoBytes;
    this.prevOutputBytes = outputBytes;
    if (proc) {
      this.prevCpuMs = proc.cpuMs;
      if (proc.ioBytes !== undefined) this.prevIoBytes = proc.ioBytes;
    }
    const sample: BashHeartbeat = {
      type: "bash_heartbeat",
      seq: ++this.seq,
      at: Date.now(),
      elapsedMs: Math.round(performance.now() - this.startedAt),
      outputBytes,
      newOutput,
      ...(proc ? { cpuMs: proc.cpuMs, ...(proc.ioBytes !== undefined ? { ioBytes: proc.ioBytes } : {}), processes: proc.processes } : {}),
      procAvailable: proc !== undefined,
      progressing: newOutput || cpuGrew || ioGrew,
    };
    try { this.options.onHeartbeat?.(sample, this.toolCallId); } catch { /* observer errors never touch the command */ }
    if (!this.onUpdate) return;
    const last = this.lastPartial;
    const details = last?.details && typeof last.details === "object" ? last.details : {};
    try {
      this.onUpdate({
        content: last ? [...last.content] : [{ type: "text", text: "" }],
        details: { ...details, heartbeat: sample },
      });
    } catch { /* ditto */ }
  }

  /** Fallback when the diagnostics channel gave no pid: the group-leader child of this process that started after the command. */
  private async scanForShell(): Promise<number | undefined> {
    const procs = await scanProc(this.options.procRoot);
    if (!procs) return undefined;
    let uptimeMs: number;
    try {
      uptimeMs = Number(readFileSync(`${this.options.procRoot}/uptime`, "utf8").split(" ")[0]) * 1000;
    } catch {
      return undefined;
    }
    if (!Number.isFinite(uptimeMs) || this.stopped) return undefined;
    const startedMs = uptimeMs - (performance.now() - this.startedAt) - 100;
    const found = [...procs.values()]
      .filter(p => p.ppid === process.pid && p.pgrp === p.pid && p.state !== "Z" && !claimed.has(p.pid) && (p.start * 1000) / CLOCK_TICKS_PER_SECOND >= startedMs)
      .sort((a, b) => a.start - b.start)[0];
    if (!found) return undefined;
    claimed.add(found.pid);
    this.claimedPid = found.pid;
    return found.pid;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Pi's `bash` (same name, schema, description, renderers, result) that reports a {@link BashHeartbeat} every
 * `intervalMs` while a command runs. See the module comment for the design.
 */
export function createBashHeartbeatTool(options: BashHeartbeatToolOptions): ToolDefinition {
  const { cwd, intervalMs, onHeartbeat, operations, procRoot, pidSource, ...bashOptions } = options;
  installChildProcessChannel();
  const settings = {
    intervalMs: sanitizeInterval(intervalMs),
    procRoot: procRoot ?? "/proc",
    scanOnly: pidSource === "scan",
    procEnabled: procRoot !== undefined || process.platform === "linux",
    ...(onHeartbeat ? { onHeartbeat } : {}),
  };
  const local = operations ?? createLocalBashOperations(bashOptions.shellPath ? { shellPath: bashOptions.shellPath } : undefined);
  const observed: BashOperations = {
    exec: (command, execCwd, execOptions) => {
      const run = running.getStore();
      return run ? run.exec(local, command, execCwd, execOptions) : local.exec(command, execCwd, execOptions);
    },
  };
  const base = createBashToolDefinition(cwd, { ...bashOptions, operations: observed });
  const execute: typeof base.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
    const run = new HeartbeatRun(toolCallId, settings, onUpdate as ((partial: BashResult) => void) | undefined);
    try {
      return await running.run(run, () => base.execute(toolCallId, params, signal, run.updates() as typeof onUpdate, ctx));
    } finally {
      run.stop();
    }
  };
  // `timeout` (seconds) given as an integer string ("120") is coerced before pi validates it.
  return { ...base, prepareArguments: coerceIntegerArguments(["timeout"], base.prepareArguments), execute } as unknown as ToolDefinition;
}
