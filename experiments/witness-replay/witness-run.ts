/**
 * Mechanical execution of a retained witness (experiments/witness-replay/README.md "Witness execution"). A result refers to the
 * exact candidate and the unchanged witness:
 *   - the witness bytes are hashed and must equal the frozen sha256 (else the run is `tampered` and never a pass);
 *   - the candidate is the workspace's content digest at the moment of the run; it is copied (symlinks kept as symlinks) and the
 *     copy must have the same digest; the copy is mounted read-only, so the candidate cannot change while it is checked;
 *   - it runs in the bubblewrap sandbox (no network, no home, no repository) with an allowlisted environment, the task's original
 *     read-only virtualenv and `PYTHONPATH` = the copy's project root, from an empty directory;
 *   - import-root hazards (sitecustomize/usercustomize/.pth files where the copy is first on sys.path) make the run untrusted;
 *   - only the LAST `WITNESS_RESULT` line counts, and it must carry this run's nonce; its exit code must agree with it.
 * Statuses: pass | fail | untrusted | tampered | error. Only `pass` passes; everything else fails closed.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runSandboxed, type Bind } from "./sandbox.js";

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const fileSha256 = (path: string): string => sha256(readFileSync(path));
/** Where the reproducer is mounted (read-only) in every sandbox: the model's session and the harness's own runs use the same path. */
export const WITNESS_MOUNT = "/opt/witness/reproducer.py";

/** Never part of a candidate: VCS data, orche spill, dependency installs, caches, harness wrappers. */
export const CANDIDATE_SKIP = /(^|\/)(\.git|\.orche|node_modules|__pycache__|\.pytest_cache|\.hypothesis|\.mypy_cache|\.ruff_cache|\.bench-bin|\.tox)$/;
const SKIP_FILE = /\.py[co]$/;

/** Sorted entries of a tree (files with sha256 and exec bit, symlinks with their target), CANDIDATE_SKIP apart. */
export function treeEntries(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (CANDIDATE_SKIP.test(rel)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out.push(`l\0${rel}\0${readlinkSync(path)}`);
      else if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && !SKIP_FILE.test(entry.name)) out.push(`f\0${rel}\0${(stat.mode & 0o111) ? "x" : "-"}\0${fileSha256(path)}`);
    }
  };
  walk(root);
  return out;
}

/** Content digest of a candidate tree (what a witness result refers to). */
export const treeDigest = (root: string): string => sha256(treeEntries(root).join("\n"));

/** Copy a candidate tree (CANDIDATE_SKIP and compiled files apart; symlinks copied as links, never followed). */
export async function copyCandidate(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, verbatimSymlinks: true, filter: path => { const rel = relative(from, path); return !(rel && (CANDIDATE_SKIP.test(rel) || SKIP_FILE.test(rel))); } });
}

/** Files that would run code on interpreter start from the candidate's import root (they can patch anything a witness observes). */
export function importRootHazards(projectRoot: string): string[] {
  if (!existsSync(projectRoot)) return [`import root missing: ${projectRoot}`];
  return readdirSync(projectRoot).filter(name => name === "sitecustomize.py" || name === "usercustomize.py" || name.endsWith(".pth") || name === "sitecustomize" || name === "usercustomize").map(name => `${name} at the import root`);
}

/**
 * Candidate files that name the witness protocol (WITNESS_NONCE / WITNESS_RESULT). Recorded, not a gate: code imported by the
 * witness runs in its process and could read the nonce and print a forged line, which no in-process check can exclude; a copy of
 * the public reproducer left in the workspace names it too and is harmless. Evaluation reports these files for inspection.
 */
export function protocolReferences(root: string): string[] {
  return treeEntries(root).filter(entry => entry.startsWith("f\0")).map(entry => entry.split("\0")[1]!).filter(rel => {
    const path = join(root, rel);
    if (lstatSync(path).size > 2_000_000) return false;
    return /WITNESS_(NONCE|RESULT)/.test(readFileSync(path, "latin1"));
  });
}

export type WitnessStatus = "pass" | "fail" | "untrusted" | "tampered" | "error";

export interface WitnessRecord {
  witness: string; status: WitnessStatus; reason?: string; at: string; ms: number;
  witnessSha256: string; expectedSha256: string; candidateDigest: string; copyDigest?: string;
  venv: string; pythonPath: string; hazards: string[]; protocolRefs?: string[]; nonce: string;
  exit: number | null; signal: NodeJS.Signals | null; guardFired: boolean;
  result?: { passed?: boolean; trusted?: boolean; problems?: string[]; cases?: { id: string; passed: boolean }[] } & Record<string, unknown>;
  output: string;
}

/** The last WITNESS_RESULT line of an output (or undefined). */
export function lastResultLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split("\n").filter(line => line.startsWith("WITNESS_RESULT "));
  const last = lines.at(-1);
  if (!last) return undefined;
  try { return JSON.parse(last.slice("WITNESS_RESULT ".length)); } catch { return undefined; }
}

/** Status of a finished run from its exit and output (pure; tests pin every branch). */
export function statusOf(run: { code: number | null; guardFired: boolean }, text: string, nonce: string): { status: WitnessStatus; reason?: string; result?: WitnessRecord["result"] } {
  if (run.guardFired) return { status: "error", reason: "timeout" };
  const result = lastResultLine(text) as WitnessRecord["result"] | undefined;
  if (!result) return { status: "error", reason: `no WITNESS_RESULT line (exit ${run.code})` };
  if (result.nonce !== nonce) return { status: "error", reason: "result line does not carry this run's nonce (stale or forged output)", result };
  if (run.code === 0 && result.passed === true && result.trusted === true) return { status: "pass", result };
  if (run.code === 1 && result.passed === false && result.trusted === true) return { status: "fail", result };
  if (run.code === 2 || result.trusted === false) return { status: "untrusted", reason: (result.problems ?? []).join("; ") || "untrusted", result };
  return { status: "error", reason: `exit ${run.code} disagrees with the result line`, result };
}

export interface WitnessRunInput {
  /** Name recorded with the result (e.g. hf-4056 or hf-4056-heldout). */
  name: string;
  /** The protected witness file and its frozen sha256. */
  file: string; expectedSha256: string;
  /** The candidate tree (a workspace; read only, never changed). */
  candidate: string;
  /** The task's original read-only virtualenv and the project's import sub-path (`.` or e.g. `src`). */
  venv: string; pythonPath: string;
  /** Scratch directory for this run (created; the copy and temp files live here and are removed afterwards unless keep). */
  scratch: string;
  guardMs?: number; keep?: boolean;
  /**
   * Native dependency closure outside the venv (audit-native.ts: a JVM and a PySpark install): extra READ-ONLY binds (forced
   * read-only), directories appended to PYTHONPATH after the candidate's root, directories prefixed to PATH and extra variables.
   * The run's own variables (nonce, candidate and dependency roots, PATH, PYTHONPATH, HOME, TMPDIR) cannot be overridden.
   */
  extra?: { binds?: Bind[]; env?: Record<string, string>; pythonPath?: string[]; path?: string[] };
}

/** Run one witness mechanically against one candidate (see the module comment). Never throws for candidate behaviour. */
export async function runWitness(input: WitnessRunInput): Promise<WitnessRecord> {
  const at = new Date().toISOString();
  const nonce = randomBytes(12).toString("hex");
  const base = { witness: input.name, at, expectedSha256: input.expectedSha256, venv: input.venv, pythonPath: input.pythonPath, nonce, exit: null, signal: null, guardFired: false } as const;
  const witnessSha256 = existsSync(input.file) ? fileSha256(input.file) : "missing";
  const candidateDigest = treeDigest(input.candidate);
  if (witnessSha256 !== input.expectedSha256) return { ...base, status: "tampered", reason: `witness sha256 ${witnessSha256} != frozen ${input.expectedSha256}`, ms: 0, witnessSha256, candidateDigest, hazards: [], output: "" };
  await mkdir(input.scratch, { recursive: true });
  const dir = await mkdtemp(join(input.scratch, `${input.name}-`));
  try {
    const copy = join(dir, "candidate");
    await copyCandidate(input.candidate, copy);
    const copyDigest = treeDigest(copy);
    const root = input.pythonPath === "." ? copy : join(copy, input.pythonPath);
    const hazards = importRootHazards(root);
    const protocolRefs = protocolReferences(copy);
    if (copyDigest !== candidateDigest) return { ...base, status: "error", reason: "candidate copy differs from the candidate", ms: 0, witnessSha256, candidateDigest, copyDigest, hazards, output: "" };
    const tmp = join(dir, "tmp"), home = join(dir, "home"), cwd = join(dir, "cwd");
    for (const path of [tmp, home, cwd]) await mkdir(path, { recursive: true });
    const witnessCopy = join(dir, "witness.py");
    await writeFile(witnessCopy, readFileSync(input.file));
    if (fileSha256(witnessCopy) !== input.expectedSha256) return { ...base, status: "tampered", reason: "witness copy hash mismatch", ms: 0, witnessSha256, candidateDigest, copyDigest, hazards, output: "" };
    const binds: Bind[] = [
      { from: copy }, { from: input.venv }, { from: witnessCopy, to: WITNESS_MOUNT },
      { from: tmp, rw: true }, { from: home, rw: true }, { from: cwd, rw: true },
      ...(input.extra?.binds ?? []).map(bind => ({ ...bind, rw: false })),
    ];
    const env = {
      ...(input.extra?.env ?? {}),
      PATH: [...(input.extra?.path ?? []), "/usr/bin", "/bin"].join(":"), HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONPATH: [root, ...(input.extra?.pythonPath ?? [])].join(":"),
      PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONHASHSEED: "0", WITNESS_CANDIDATE_ROOT: copy, WITNESS_DEP_ROOT: input.venv, WITNESS_NONCE: nonce,
    };
    const run = await runSandboxed({ binds, env, cwd, command: [join(input.venv, "bin/python"), "-s", "-B", WITNESS_MOUNT] }, { guardMs: input.guardMs ?? 300_000 });
    const verdict = statusOf(run, run.text, nonce);
    const status: WitnessStatus = verdict.status === "pass" && hazards.length ? "untrusted" : verdict.status;
    const reason = verdict.status === "pass" && hazards.length ? hazards.join("; ") : verdict.reason;
    return { ...base, status, ...(reason ? { reason } : {}), ms: run.ms, witnessSha256, candidateDigest, copyDigest, hazards, protocolRefs, exit: run.code, signal: run.signal, guardFired: run.guardFired, ...(verdict.result ? { result: verdict.result } : {}), output: run.text.slice(-12_000) };
  } finally {
    if (!input.keep) await rm(dir, { recursive: true, force: true });
  }
}
