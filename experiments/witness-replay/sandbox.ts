/**
 * The bubblewrap sandbox of the witness-replay pilot (experiments/witness-replay/README.md "Isolation"): everything model-written
 * (the Pi session and its tools, the witness and checks that import candidate code) runs with
 *   - no network namespace of its own reaching out (`--unshare-net`: only the sandbox's loopback; the model's one way out is the
 *     unit proxy's unix socket, bound in by the caller),
 *   - the host filesystem read-only, with /home, /tmp, /var/tmp, /run, /opt, /mnt, /media and /srv replaced by empty tmpfs (no
 *     repository, fixtures, hidden tests, earlier results, credentials or other scratch directories), then only the listed paths
 *     bound back (read-only unless `rw`),
 *   - its own pid namespace (every process the session started dies with it) and a cleared environment (only `env`).
 * Pure argument building (`bwrapArgs`) is unit-tested; `runSandboxed` runs it with a hard guard.
 */
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

export const BWRAP = process.env.WITNESS_REPLAY_BWRAP ?? "/usr/bin/bwrap";
/** Host directories hidden behind an empty tmpfs before anything is bound back. */
export const HIDDEN_ROOTS = ["/home", "/tmp", "/var/tmp", "/run", "/opt", "/mnt", "/media", "/srv", "/root"];

export interface Bind { from: string; to?: string; rw?: boolean }
export interface SandboxSpec { binds: readonly Bind[]; env: Readonly<Record<string, string>>; cwd: string; command: readonly string[]; network?: false }

/** The bwrap command line of a spec (the command last, after `--`). */
export function bwrapArgs(spec: SandboxSpec): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--ro-bind", "/", "/"];
  for (const root of HIDDEN_ROOTS) args.push("--tmpfs", root);
  args.push("--dev", "/dev", "--proc", "/proc");
  for (const bind of spec.binds) {
    if (!bind.from.startsWith("/") || (bind.to !== undefined && !bind.to.startsWith("/"))) throw new Error(`sandbox bind needs absolute paths: ${JSON.stringify(bind)}`);
    args.push(bind.rw ? "--bind" : "--ro-bind", bind.from, bind.to ?? bind.from);
  }
  args.push("--clearenv");
  for (const [name, value] of Object.entries(spec.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad environment name ${name}`);
    args.push("--setenv", name, value);
  }
  args.push("--chdir", spec.cwd, "--", ...spec.command);
  return args;
}

export interface SandboxRun { code: number | null; signal: NodeJS.Signals | null; guardFired: boolean; ms: number; text: string }

/**
 * Run a spec under bwrap in its own process group; stdout/stderr go to the given files (append) and, up to `keep` bytes from the
 * end, into `text`. The guard kills the whole group (bwrap's pid namespace takes every sandboxed process with it).
 */
export function runSandboxed(spec: SandboxSpec, options: { guardMs: number; stdout?: string; stderr?: string; keep?: number; onSpawn?: (pid: number) => void }): Promise<SandboxRun> {
  const keep = options.keep ?? 256 * 1024;
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(BWRAP, bwrapArgs(spec), { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    let text = "";
    let guardFired = false;
    let chain: Promise<unknown> = Promise.resolve();
    const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { /* gone */ } };
    const add = (chunk: Buffer, file?: string) => {
      text += String(chunk);
      if (text.length > keep * 2) text = text.slice(-keep);
      if (file) chain = chain.then(() => appendFile(file, chunk));
    };
    if (child.pid) options.onSpawn?.(child.pid);
    child.stdout!.on("data", chunk => add(chunk, options.stdout));
    child.stderr!.on("data", chunk => add(chunk, options.stderr ?? options.stdout));
    const timer = setTimeout(() => { guardFired = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 5_000).unref(); }, options.guardMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      kill("SIGKILL");
      void chain.then(() => resolve({ code, signal, guardFired, ms: Date.now() - started, text: text.slice(-keep) }));
    });
    child.once("error", error => { clearTimeout(timer); resolve({ code: -1, signal: null, guardFired, ms: Date.now() - started, text: `spawn error: ${String(error)}` }); });
  });
}
