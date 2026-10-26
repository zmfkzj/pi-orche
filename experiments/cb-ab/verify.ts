/**
 * Deterministic, model-free verification of the round-2 case screening (results/cb-ab/PROTOCOL-R2.md "Case screening" ->
 * "Deterministic verification", "Eligible"); used by screen.ts (`run`, `one`, `verify`).
 *
 *  - The reference patch is split into hunks, indexed in order over the whole patch (the indexes the screener is shown).
 *  - A candidate is VERIFIED when its probe (a standalone Python script, run from the project root of a FRESH copy: exit 0 = correct
 *    behaviour) exits non-zero on the pre-fix snapshot, exits 0 with the full reference fix, and exits non-zero with the reference fix
 *    minus that candidate's hunks. A timeout counts as non-zero. Every probe run happens in a bubblewrap sandbox without network, with
 *    the copy at ~/Code/<projectDir>, the venv read-only and PYTHONPATH = the copy (+ pythonPath).
 *  - E2 = at least two verified candidates. E3 (recorded per verified defect, not required): none of its file basename/stem, function or
 *    class names appears in the issue text (case-insensitive, whole word). Eligible = E1 (the screener's judgement) and E2.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { runGuarded, sha } from "../mdsd-ab/run.js";
import { HOME, display, makeTarget, venvMount, writeJson } from "./env.js";

// ---- the reference patch -----------------------------------------------------------------------------------------------------------

export interface Hunk { index: number; file: string; header: string; lines: string[]; nonTestSource: boolean }
export interface PatchFile { header: string[]; file: string; hunks: Hunk[] }
export interface ParsedPatch { files: PatchFile[]; hunks: Hunk[]; preamble: string[] }

/** D2's non-test Python source: a .py file not under test/tests/testing/docs/doc/examples and not test_*.py, *_test.py or conftest.py. */
export function isNonTestSource(file: string): boolean {
  if (!file.endsWith(".py")) return false;
  const parts = file.split("/");
  const name = parts.at(-1)!;
  if (parts.slice(0, -1).some(part => ["test", "tests", "testing", "docs", "doc", "examples"].includes(part))) return false;
  return !(/^test_.*\.py$/.test(name) || /_test\.py$/.test(name) || name === "conftest.py");
}

const fileOf = (header: readonly string[]): string => {
  const plus = header.find(line => line.startsWith("+++ "));
  const minus = header.find(line => line.startsWith("--- "));
  const strip = (line: string) => line.slice(4).replace(/\r?\n$/, "").replace(/\t.*$/, "").replace(/^[ab]\//, "");
  if (plus && !plus.startsWith("+++ /dev/null")) return strip(plus);
  if (minus && !minus.startsWith("--- /dev/null")) return strip(minus);
  return /^diff --git a\/(\S+) b\/(\S+)/.exec(header[0] ?? "")?.[2] ?? "?";
};

/**
 * Split a unified diff into file sections and hunks. A hunk is exactly its header plus the lines its counts (@@ -a,b +c,d @@) cover,
 * and a trailing "\ No newline" marker, so a removed line that starts with "--" is never taken for a file header. With `diff --git`
 * lines only those start a file; otherwise a "--- " line followed by "+++ " does.
 */
export function parsePatch(text: string): ParsedPatch {
  const lines = text.split(/(?<=\n)/);
  const git = /^diff --git /m.test(text);
  const files: PatchFile[] = [], hunks: Hunk[] = [], preamble: string[] = [];
  let current: PatchFile | undefined, hunk: Hunk | undefined, oldLeft = 0, newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (hunk) {
      // A hunk line starts with ' ', '+', '-' or '\' (an empty line is a context line whose blank was stripped); anything else ends a
      // hunk whose counts were wrong.
      if ((oldLeft > 0 || newLeft > 0) && (/^[ +\-\\]/.test(line) || line === "\n")) {
        hunk.lines.push(line);
        if (line.startsWith("\\")) continue;
        if (line.startsWith("+")) newLeft--; else if (line.startsWith("-")) oldLeft--; else { oldLeft--; newLeft--; }
        continue;
      }
      if (line.startsWith("\\")) { hunk.lines.push(line); continue; }
      hunk = undefined;
    }
    if (git ? line.startsWith("diff --git ") : line.startsWith("--- ") && !!lines[i + 1]?.startsWith("+++ ")) {
      current = { header: [line], file: "?", hunks: [] }; files.push(current);
      continue;
    }
    if (!current) { preamble.push(line); continue; }
    const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (counts) {
      if (current.file === "?") current.file = fileOf(current.header);
      oldLeft = counts[1] === undefined ? 1 : Number(counts[1]); newLeft = counts[2] === undefined ? 1 : Number(counts[2]);
      hunk = { index: hunks.length, file: current.file, header: line.replace(/\n$/, ""), lines: [line], nonTestSource: isNonTestSource(current.file) };
      current.hunks.push(hunk); hunks.push(hunk);
      continue;
    }
    current.header.push(line);
  }
  for (const file of files) if (file.file === "?") file.file = fileOf(file.header);
  return { files, hunks, preamble };
}

/** The patch without the given hunk indexes; a file left without hunks is dropped; a file without hunks (binary, mode) is kept. */
export function patchWithout(text: string, drop: readonly number[]): string {
  const parsed = parsePatch(text);
  const out: string[] = [...parsed.preamble];
  for (const file of parsed.files) {
    if (!file.hunks.length) { out.push(...file.header); continue; }
    const kept = file.hunks.filter(item => !drop.includes(item.index));
    if (!kept.length) continue;
    out.push(...file.header, ...kept.flatMap(item => item.lines));
  }
  return out.join("");
}

/** The hunk listing the screener gets (index, file, header, non-test flag, the hunk's lines). */
export function hunkListing(parsed: ParsedPatch, withBodies = true): string {
  return parsed.hunks.map(item => [`=== hunk ${item.index}: ${item.file} ${item.header}${item.nonTestSource ? " [non-test source]" : ""}`, ...(withBodies ? [item.lines.join("").replace(/\n$/, "")] : [])].join("\n")).join("\n");
}

// ---- E3 --------------------------------------------------------------------------------------------------------------------------

export interface Location { file: string; function?: string; lines?: string }
/** The names E3 checks for one location: the file's basename and stem, and every dotted identifier of its function field. */
export function e3Names(location: Location): string[] {
  const names = new Set<string>();
  const base = basename(String(location.file ?? ""));
  if (base) { names.add(base); const stem = base.replace(/\.[^.]+$/, ""); if (stem && stem !== base) names.add(stem); }
  const fn = String(location.function ?? "").trim().split(/[\s(]/)[0] ?? "";
  for (const part of fn.split(".")) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) names.add(part);
  return [...names];
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** E3 for one defect: met when none of its names occurs in the issue text (case-insensitive whole word). */
export function e3Check(issue: string, locations: readonly Location[]): { met: boolean; named: string[]; checked: string[] } {
  const checked = [...new Set(locations.flatMap(e3Names))];
  const named = checked.filter(name => new RegExp(`(?<![A-Za-z0-9_])${escape(name)}(?![A-Za-z0-9_])`, "i").test(issue));
  return { met: named.length === 0, named, checked };
}

// ---- probe runs ------------------------------------------------------------------------------------------------------------------

export type Condition = "pre" | "fix" | "minus";
export interface ProbeRun { condition: Condition; exit: number | null; signal: string | null; timedOut: boolean; ms: number; log: string; patchSha256?: string; applyError?: string }
export interface ProbeEnv { source: string; venv: string; projectDir: string; pythonPath: string; work: string; timeoutMs?: number }
export const PROBE_TIMEOUT_MS = 120_000;

/** bubblewrap for one probe run: read-only host root, private home, /tmp and namespaces (no network); the copy, the venv and the probes. */
export function probeSandboxArgs(copy: string, venv: string, projectDir: string, probesDir: string): string[] {
  return [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", HOME,
    "--unshare-all", "--die-with-parent", "--new-session",
    "--ro-bind", venv, venvMount(projectDir),
    "--bind", copy, join(HOME, "Code", projectDir),
    "--ro-bind", probesDir, join(HOME, "probes"),
    "--chdir", join(HOME, "Code", projectDir),
  ];
}

/** Apply a patch to a copy (git apply, no enclosing repository); the error text on failure. */
export function applyPatch(copy: string, patch: string): string | undefined {
  try {
    execFileSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: copy, input: patch, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(copy) } });
    return undefined;
  } catch (error: any) { return String(error?.stderr ?? error?.message ?? error).slice(0, 2000); }
}

/** One probe run on a fresh copy (+ patch), logged to `log`. */
export async function runProbe(env: ProbeEnv, probesDir: string, probe: string, condition: Condition, patch: string | undefined, log: string): Promise<ProbeRun> {
  const copy = join(env.work, `${condition}-${basename(probe).replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dirname(copy), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  makeTarget(env.source, copy);
  const header = [`# condition: ${condition}`, `# copy: fresh copy of ${display(env.source)}${patch === undefined ? "" : patch.trim() ? ` + patch sha256 ${sha(patch)}` : " + an empty patch (every hunk left out: the pre-fix code)"}`, `# probe: ${probe}`];
  try {
    // An empty patch (a candidate owning every hunk) leaves the pre-fix code: nothing to apply.
    if (patch !== undefined && patch.trim()) {
      const error = applyPatch(copy, patch);
      if (error) { writeFileSync(log, [...header, `# patch does not apply: ${error}`, ""].join("\n")); return { condition, exit: null, signal: null, timedOut: false, ms: 0, log, patchSha256: sha(patch), applyError: error }; }
    }
    const projectRoot = join(HOME, "Code", env.projectDir);
    const pythonPath = env.pythonPath && env.pythonPath !== "." ? join(projectRoot, env.pythonPath) : projectRoot;
    const python = join(venvMount(env.projectDir), "bin/python");
    const args = [...probeSandboxArgs(copy, env.venv, env.projectDir, probesDir), "--", python, join(HOME, "probes", probe)];
    writeFileSync(log, [...header, `# cwd: ${projectRoot}; PYTHONPATH=${pythonPath} PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 (bubblewrap, no network)`, `$ python ~/probes/${probe}`, ""].join("\n"));
    const run = await runGuarded("bwrap", args, { env: { HOME, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: "/tmp", PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" }, stdout: log, stderr: log, guardMs: env.timeoutMs ?? PROBE_TIMEOUT_MS });
    writeFileSync(log, `${readFileSync(log, "utf8")}\n# exit: ${run.code}${run.signal ? ` (signal ${run.signal})` : ""}${run.guardFired ? " (timeout)" : ""}; ${run.endedAt - run.startedAt} ms\n`);
    return { condition, exit: run.code, signal: run.signal, timedOut: run.guardFired, ms: run.endedAt - run.startedAt, log, ...(patch ? { patchSha256: sha(patch) } : {}) };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

const failed = (run: ProbeRun) => !run.applyError && (run.timedOut || run.exit !== 0);
const passed = (run: ProbeRun) => !run.applyError && !run.timedOut && run.exit === 0;

// ---- candidates ------------------------------------------------------------------------------------------------------------------

export interface Candidate { id: string; title?: string; mechanism: string; locations: Location[]; scenario: string; hunks: number[]; recoverability: string; probe: string }
export interface CandidateResult {
  id: string; verified: boolean; reasons: string[]; hunks: number[]; probe?: string; probeSha256?: string;
  runs: Partial<Record<Condition, Omit<ProbeRun, "log"> & { log: string }>>;
  e3?: { met: boolean; named: string[]; checked: string[] };
  nonTestHunks?: number[];
}

/** The shape checks of one candidate (before any run). */
export function candidateProblems(raw: any, hunkCount: number, probesDir: string): string[] {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") return ["not an object"];
  if (typeof raw.id !== "string" || !/^K\d+$/.test(raw.id)) problems.push(`id ${JSON.stringify(raw.id)} is not K<n>`);
  for (const key of ["mechanism", "scenario", "recoverability"]) if (typeof raw[key] !== "string" || !raw[key].trim()) problems.push(`no ${key}`);
  if (!Array.isArray(raw.locations) || !raw.locations.length || raw.locations.some((item: any) => typeof item?.file !== "string" || !item.file)) problems.push("no locations with a file");
  if (!Array.isArray(raw.hunks) || !raw.hunks.length) problems.push("no hunks");
  else for (const index of raw.hunks) if (!Number.isSafeInteger(index) || index < 0 || index >= hunkCount) problems.push(`hunk ${JSON.stringify(index)} is not an index of the reference patch (0..${hunkCount - 1})`);
  if (typeof raw.probe !== "string" || !raw.probe || raw.probe.includes("..") || raw.probe.startsWith("/")) problems.push(`probe ${JSON.stringify(raw.probe)} is not a file name in probes/`);
  else if (!existsSync(join(probesDir, raw.probe))) problems.push(`probe ${raw.probe} does not exist`);
  return problems;
}

/** Verify one candidate: three probe runs on fresh copies (pre-fix, full fix, fix minus its hunks). */
export async function verifyCandidate(raw: any, reference: string, parsed: ParsedPatch, probesDir: string, env: ProbeEnv, issue: string, logDir: string): Promise<CandidateResult> {
  const id = typeof raw?.id === "string" ? raw.id : "?";
  const problems = candidateProblems(raw, parsed.hunks.length, probesDir);
  const hunks = Array.isArray(raw?.hunks) ? raw.hunks.filter((item: unknown) => Number.isSafeInteger(item)) : [];
  if (problems.length) return { id, verified: false, reasons: problems, hunks, runs: {} };
  const probe = String(raw.probe);
  const result: CandidateResult = { id, verified: false, reasons: [], hunks, probe, probeSha256: sha(readFileSync(join(probesDir, probe))), runs: {}, nonTestHunks: hunks.filter((index: number) => parsed.hunks[index]!.nonTestSource) };
  const conditions: [Condition, string | undefined][] = [["pre", undefined], ["fix", reference], ["minus", patchWithout(reference, hunks)]];
  for (const [condition, patch] of conditions) {
    const run = await runProbe(env, probesDir, probe, condition, patch, join(logDir, `${id}-${condition}.log`));
    result.runs[condition] = { ...run, log: display(run.log) };
  }
  const pre = result.runs.pre!, fix = result.runs.fix!, minus = result.runs.minus!;
  if (!failed(pre)) result.reasons.push(pre.applyError ? "pre-fix copy failed" : "the probe passes on the pre-fix snapshot (must fail)");
  if (!passed(fix)) result.reasons.push(fix.applyError ? "the full reference fix does not apply" : `the probe does not pass with the full reference fix (exit ${fix.exit}${fix.timedOut ? ", timeout" : ""})`);
  if (!failed(minus)) result.reasons.push(minus.applyError ? "the reference fix minus this candidate's hunks does not apply" : "the probe passes with the reference fix minus this candidate's hunks (must fail)");
  result.verified = result.reasons.length === 0;
  if (result.verified) result.e3 = e3Check(issue, raw.locations);
  return result;
}

export interface RecordVerification {
  task: string; verifiedAt: string; referenceSha256: string; hunks: { index: number; file: string; header: string; nonTestSource: boolean }[];
  e1: { met: boolean; reason: string } | null; candidates: CandidateResult[]; verified: string[];
  e2: boolean; eligible: boolean; reasons: string[]; hunkOverlaps: string[];
}

/** Verify every candidate of one screener output and apply E1 ∧ E2. */
export async function verifyScreening(output: any, reference: string, probesDir: string, env: ProbeEnv, issue: string, logDir: string, task: string): Promise<RecordVerification> {
  const parsed = parsePatch(reference);
  const reasons: string[] = [];
  const e1 = output?.e1 && typeof output.e1.met === "boolean" ? { met: output.e1.met as boolean, reason: String(output.e1.reason ?? "") } : null;
  if (!e1) reasons.push("no E1 judgement in the screener output");
  else if (!e1.met) reasons.push(`E1 not met: ${e1.reason}`);
  const raw = Array.isArray(output?.candidates) ? output.candidates : [];
  if (!Array.isArray(output?.candidates)) reasons.push("no candidates array in the screener output");
  const candidates: CandidateResult[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const result = await verifyCandidate(item, reference, parsed, probesDir, env, issue, logDir);
    if (ids.has(result.id)) { result.verified = false; result.reasons.push(`duplicate id ${result.id}`); }
    ids.add(result.id);
    candidates.push(result);
  }
  const verified = candidates.filter(item => item.verified).map(item => item.id);
  const e2 = verified.length >= 2;
  if (!e2) reasons.push(`E2 not met: ${verified.length} verified known defect(s)`);
  const hunkOverlaps: string[] = [];
  for (const [i, a] of candidates.entries()) for (const b of candidates.slice(i + 1)) { const shared = a.hunks.filter(index => b.hunks.includes(index)); if (shared.length) hunkOverlaps.push(`${a.id} and ${b.id} share hunk(s) ${shared.join(",")}`); }
  return {
    task, verifiedAt: new Date().toISOString(), referenceSha256: sha(reference), hunks: parsed.hunks.map(item => ({ index: item.index, file: item.file, header: item.header, nonTestSource: item.nonTestSource })),
    e1, candidates, verified, e2, eligible: !!e1?.met && e2, reasons, hunkOverlaps,
  };
}

/** Write verification.json next to the logs. */
export function writeVerification(dir: string, verification: RecordVerification): void {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "verification.json"), verification);
}

export const resolveDir = (path: string) => resolve(path);
