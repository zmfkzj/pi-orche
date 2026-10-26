/**
 * Process and environment helpers of the P2 build (experiments/swe-pool/build.ts). They reproduce what
 * experiments/advisor-reviewer/setup-swe.ts and tasks.ts do, with explicit paths instead of tasks.ts's SWE_DIR / SWE_CACHE constants:
 * - `sh`: setup-swe.ts's `execSync(command, { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30 min })` (via /bin/sh), made
 *   asynchronous so that several records can be set up at once, with every command and its output in the record's log;
 * - `pythonWrappers` / `runSweTests`: tasks.ts's, with the virtualenv passed in (byte-identical wrapper scripts and test command);
 * - process groups: every command runs in its own process group, which is killed when the command ends or times out, so no test or
 *   build leaves a process behind.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statfsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class Log {
  constructor(readonly file: string) {}
  write(text: string): void { appendFileSync(this.file, text.endsWith("\n") ? text : `${text}\n`); }
  note(text: string): void { this.write(`[${new Date().toISOString()}] ${text}`); }
}

const LOG_OUTPUT_CAP = 4 * 1024 * 1024;
const capped = (text: string): string => (text.length > LOG_OUTPUT_CAP ? `[... ${text.length - LOG_OUTPUT_CAP} characters omitted ...]\n${text.slice(-LOG_OUTPUT_CAP)}` : text);

/** A failed command: the message is execSync's ("Command failed: <command>\n<stderr>"); the parts are kept for the record's reason. */
export class CommandError extends Error {
  constructor(readonly command: string, readonly code: number | null, readonly signal: string | null, readonly stderr: string, readonly timedOut: boolean) {
    super(`${timedOut ? "Command timed out" : "Command failed"}: ${command}${stderr ? `\n${stderr}` : ""}`);
  }
}

const killGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* the group is gone */ }
};

/** Children of this process that may still run: process groups (detached commands) and plain pids. */
const activeGroups = new Set<number>(), activePids = new Set<number>();

/** Kill every command still running (on an interruption of the build: nothing is left behind). */
export function killActive(): void {
  for (const pid of activeGroups) { killGroup(pid, "SIGCONT"); killGroup(pid, "SIGKILL"); }
  for (const pid of activePids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  activeGroups.clear();
  activePids.clear();
}

/** /proc/meminfo MemAvailable in bytes (Infinity where unavailable). */
export function memAvailable(): number {
  try {
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return match ? Number(match[1]) * 1024 : Infinity;
  } catch { return Infinity; }
}

/** Free bytes for an unprivileged user on the file system of `path`. */
export function diskAvailable(path: string): number {
  try { const stats = statfsSync(path); return stats.bavail * stats.bsize; } catch { return Infinity; }
}

/**
 * Keeps concurrent installs from exhausting memory (an out-of-memory kill would be a spurious failure of a record): when MemAvailable
 * drops below `low` and more than one governed command runs, the newest one's process group is paused (SIGSTOP); paused groups resume
 * oldest first (SIGCONT) once MemAvailable is above `high`. Paused time does not count against a command's timeout. Scheduling only:
 * no command, input or output changes.
 */
export class MemoryGovernor {
  private groups: { pid: number; label: string; pausedAt?: number; pausedMs: number }[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private readonly low: number, private readonly high: number, private readonly onEvent: (text: string) => void, private readonly available: () => number = memAvailable) {}
  start(intervalMs = 2000): void { this.timer = setInterval(() => this.tick(), intervalMs); }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const group of this.groups) if (group.pausedAt !== undefined) { killGroup(group.pid, "SIGCONT"); group.pausedAt = undefined; }
  }
  add(pid: number, label: string): void { this.groups.push({ pid, label, pausedMs: 0 }); }
  remove(pid: number): void {
    const group = this.groups.find(item => item.pid === pid);
    if (group?.pausedAt !== undefined) killGroup(pid, "SIGCONT");
    this.groups = this.groups.filter(item => item.pid !== pid);
  }
  pausedMs(pid: number): number {
    const group = this.groups.find(item => item.pid === pid);
    return group ? group.pausedMs + (group.pausedAt === undefined ? 0 : Date.now() - group.pausedAt) : 0;
  }
  paused(): string[] { return this.groups.filter(group => group.pausedAt !== undefined).map(group => group.label); }
  tick(): void {
    const available = this.available();
    const running = this.groups.filter(group => group.pausedAt === undefined);
    if (available < this.low && running.length > 1) {
      const newest = running[running.length - 1]!;
      killGroup(newest.pid, "SIGSTOP");
      newest.pausedAt = Date.now();
      this.onEvent(`memory governor: MemAvailable ${(available / 2 ** 30).toFixed(1)} GiB < ${(this.low / 2 ** 30).toFixed(1)} GiB; paused ${newest.label}`);
    } else if (available > this.high) {
      const oldest = this.groups.find(group => group.pausedAt !== undefined);
      if (!oldest) return;
      killGroup(oldest.pid, "SIGCONT");
      oldest.pausedMs += Date.now() - oldest.pausedAt!;
      oldest.pausedAt = undefined;
      this.onEvent(`memory governor: MemAvailable ${(available / 2 ** 30).toFixed(1)} GiB; resumed ${oldest.label}`);
    }
  }
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  governor?: MemoryGovernor;
  label?: string;
}

/** Run `file args` in its own process group; resolves with stdout and stderr, rejects with a CommandError on a non-zero exit. */
export function run(file: string, args: readonly string[], cwd: string, log: Log, options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const shown = file === "/bin/sh" && args[0] === "-c" ? args[1]! : [file, ...args].join(" ");
  const timeoutMs = options.timeoutMs ?? 1_800_000;
  log.note(`$ ${shown}\n  (cwd ${cwd})`);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    if (child.pid) activeGroups.add(child.pid);
    if (child.pid && options.governor) options.governor.add(child.pid, `${options.label ?? ""} ${shown.slice(0, 80)}`.trim());
    const timer = setInterval(() => {
      if (Date.now() - started - (child.pid ? options.governor?.pausedMs(child.pid) ?? 0 : 0) <= timeoutMs) return;
      timedOut = true;
      killGroup(child.pid, "SIGCONT");
      killGroup(child.pid, "SIGKILL");
    }, Math.min(5_000, timeoutMs));
    const finish = (error: CommandError | undefined) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (child.pid) { options.governor?.remove(child.pid); killGroup(child.pid, "SIGKILL"); activeGroups.delete(child.pid); }
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    child.stdout.on("data", chunk => { if (stdout.length < 256 * 1024 * 1024) stdout += String(chunk); });
    child.stderr.on("data", chunk => { if (stderr.length < 256 * 1024 * 1024) stderr += String(chunk); });
    // The command is over when its first process exits: what it left running in its group (a daemon holding the pipe) is killed.
    child.once("exit", () => killGroup(child.pid, "SIGKILL"));
    child.once("error", error => {
      if (settled) return;
      log.note(`spawn error: ${String(error)}`);
      finish(new CommandError(shown, null, null, String(error), false));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      const output = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`;
      log.write(`${output ? `${capped(output).trimEnd()}\n` : ""}  [${timedOut ? "TIMEOUT" : `exit ${code ?? signal}`}, ${((Date.now() - started) / 1000).toFixed(1)}s]`);
      finish(code === 0 && !timedOut ? undefined : new CommandError(shown, code, signal, stderr.trim(), timedOut));
    });
  });
}

/** setup-swe.ts `sh`: /bin/sh -c command (stdin closed); its stdout. */
export async function sh(command: string, cwd: string, log: Log, options: RunOptions = {}): Promise<string> {
  return (await run("/bin/sh", ["-c", command], cwd, log, options)).stdout;
}

/** `git archive <commit>` of `clone` extracted into `dest` (setup-swe.ts: git archive | tar -x -C dest). */
export async function gitArchive(clone: string, commit: string, dest: string, log: Log): Promise<void> {
  log.note(`$ git archive ${commit} | tar -x -C ${dest}\n  (cwd ${clone})`);
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const git = spawn("git", ["archive", commit], { cwd: clone, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    for (const pid of [git.pid, tar.pid]) if (pid) activePids.add(pid);
    let gitErr = "", tarErr = "", pending = 2, gitCode: number | null = null, tarCode: number | null = null;
    git.stderr.on("data", chunk => { gitErr += String(chunk); });
    tar.stderr.on("data", chunk => { tarErr += String(chunk); });
    tar.stdin.on("error", () => { /* tar ended early: its exit status reports it */ });
    git.stdout.pipe(tar.stdin);
    const done = () => {
      if (--pending > 0) return;
      log.write(`${`${gitErr}${tarErr}`.trimEnd()}${gitErr || tarErr ? "\n" : ""}  [git exit ${gitCode}, tar exit ${tarCode}, ${((Date.now() - started) / 1000).toFixed(1)}s]`);
      if (gitCode === 0 && tarCode === 0) resolve();
      else reject(new CommandError(`git archive ${commit} | tar -x -C ${dest}`, gitCode || tarCode, null, `${gitErr}${tarErr}`.trim(), false));
    };
    git.once("close", code => { gitCode = code; if (git.pid) activePids.delete(git.pid); done(); });
    tar.once("close", code => { tarCode = code; if (tar.pid) activePids.delete(tar.pid); done(); });
    git.once("error", error => { gitErr += String(error); });
    tar.once("error", error => { tarErr += String(error); });
  });
}

/**
 * tasks.ts `pythonWrappers` with the virtualenv given: `python`, `python3`, `pytest` in `binDir` run `venv` with `root` (its package
 * dir) first on sys.path, and a `pip` that refuses. The script texts are tasks.ts's.
 */
export async function pythonWrappers(venv: string, pythonPath: string | undefined, root: string, binDir: string): Promise<void> {
  const path = pythonPath && pythonPath !== "." ? join(root, pythonPath) : root;
  await mkdir(binDir, { recursive: true });
  const python = `#!/bin/sh\nexport PYTHONPATH="${path}\${PYTHONPATH:+:\$PYTHONPATH}"\nexport PYTHONDONTWRITEBYTECODE=1\nexec "${venv}/bin/python" "$@"\n`;
  for (const name of ["python", "python3"]) await writeFile(join(binDir, name), python);
  await writeFile(join(binDir, "pytest"), `#!/bin/sh\nexec "${join(binDir, "python")}" -m pytest "$@"\n`);
  await writeFile(join(binDir, "pip"), `#!/bin/sh\necho "pip is disabled in this environment: dependencies are preinstalled and there is no network." >&2\nexit 1\n`);
  for (const name of ["python", "python3", "pytest", "pip"]) await chmod(join(binDir, name), 0o755);
}

/** The `-rA` summary statuses by pytest node id (tasks.ts `runSweTests` parsing). */
export function parseStatuses(text: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S.*?)(?:\s+-\s+.*)?$/.exec(line.trim());
    if (match && match[2]!.includes("::")) statuses.set(match[2]!.trim(), match[1]!);
  }
  return statuses;
}

/** tasks.ts `runSweTests` with the virtualenv given: the task's test command in `dir` (wrappers in `binDir`), 15 min limit. */
export async function runSweTests(manifest: { testCmd: string; pythonPath?: string }, venv: string, dir: string, binDir: string, log: Log, timeoutMs = 900_000): Promise<{ statuses: Map<string, string>; exit: number | null; tail: string }> {
  await pythonWrappers(venv, manifest.pythonPath, dir, binDir);
  const command = manifest.testCmd.replace(/^pytest\b/, `"${join(binDir, "pytest")}"`);
  log.note(`$ bash -c ${JSON.stringify(command)}\n  (cwd ${dir})`);
  const started = Date.now();
  const output = await new Promise<{ code: number | null; text: string; timedOut: boolean }>(resolve => {
    const child = spawn("bash", ["-c", command], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PYTHONHASHSEED: "0" } });
    if (child.pid) activeGroups.add(child.pid);
    let text = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid, "SIGKILL"); }, timeoutMs);
    child.stdout.on("data", chunk => { text += String(chunk); });
    child.stderr.on("data", chunk => { text += String(chunk); });
    // The tests are over when the test command exits: anything they left running in its group is killed (statuses are unaffected).
    child.once("exit", () => killGroup(child.pid, "SIGKILL"));
    child.once("error", error => { text += `\nspawn error: ${String(error)}`; });
    child.once("close", code => { clearTimeout(timer); if (child.pid) { killGroup(child.pid, "SIGKILL"); activeGroups.delete(child.pid); } resolve({ code, text, timedOut }); });
  });
  log.write(`${capped(output.text).trimEnd()}\n  [${output.timedOut ? "TIMEOUT" : `exit ${output.code}`}, ${((Date.now() - started) / 1000).toFixed(1)}s]`);
  return { statuses: parseStatuses(output.text), exit: output.code, tail: output.text.slice(-3000) };
}

/** rm -rf that also removes trees a build or a test left without write permission. */
export async function removeTree(path: string): Promise<void> {
  try { await rm(path, { recursive: true, force: true }); return; } catch { /* permissions: fall through */ }
  await new Promise<void>(resolve => { const child = spawn("chmod", ["-R", "u+rwX", path], { stdio: "ignore" }); child.once("close", () => resolve()); child.once("error", () => resolve()); });
  await rm(path, { recursive: true, force: true });
}

const NETWORK = [
  /Could not resolve host/i, /Temporary failure in name resolution/i, /Name or service not known/i, /Network is unreachable/i,
  /Failed to connect to/i, /Connection (?:timed out|reset|refused)/i, /Operation timed out/i, /unable to access 'https?:/i,
  /early EOF/i, /RPC failed/i, /remote end hung up unexpectedly/i, /gnutls_handshake|SSL_ERROR|SSL_connect|TLS connection/i,
  /curl: \((?:5|6|7|18|28|35|52|55|56)\)/, /ConnectTimeoutError|ReadTimeoutError|NewConnectionError|ProtocolError|ConnectionResetError/,
  /Max retries exceeded/i, /Read timed out/i, /IncompleteRead/, /Connection broken/i, /RemoteDisconnected/, /ChunkedEncodingError/,
  /HTTP error 5\d\d|50[234] (?:Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)/i,
];

/** A failure caused by the network (git fetch, pip downloads, curl): the one kind of failure the build retries, once. */
export const isNetworkFailure = (text: string): boolean => NETWORK.some(pattern => pattern.test(text));
