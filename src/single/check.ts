/**
 * The Verifier of an implement result (docs/specialist-orchestration.md 5.3) and the deterministic recheck after a fix. The
 * Verifier is a one-shot session that did not write the change: it runs the project's checks and small probe scripts against the
 * contract and reports a requirement trace and at most six findings. A blocking finding needs executed evidence (a probe or check
 * that fails, re-runnable as `probe`) or a direct contradiction of the quoted request. Probes live only in the task's scratch
 * directory `.orche/scratch/<task>/` with `.probe.` in the name (outside the workspace audit and every test glob). After the
 * Primary's fix round, orche re-runs the probes and checks itself: no second Verifier call.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { classifyBash } from "../extension/bash-policy.js";

export const CHECK_LIMITS = { findings: 6, trace: 40, checks: 10, recheckTimeoutMs: 180_000, recheckOutputChars: 600 } as const;
const text = (max: number) => Type.String({ minLength: 1, maxLength: max });
export const checkSchema = Type.Object({
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")], { description: "fail exactly when there is a blocking finding." }),
  trace: Type.Array(Type.Object({
    id: Type.String({ pattern: "^R[1-9][0-9]*$" }),
    status: Type.Union([Type.Literal("covered"), Type.Literal("partial"), Type.Literal("missing")], { description: "covered: a passing test or probe shows the acceptance; partial: only part of it; missing: nothing shows it, or it fails." }),
    evidence: text(400),
  }), { maxItems: CHECK_LIMITS.trace }),
  findings: Type.Array(Type.Object({
    id: Type.String({ pattern: "^F[1-9][0-9]*$" }),
    severity: Type.Union([Type.Literal("blocking"), Type.Literal("minor")]),
    kind: Type.Union([Type.Literal("executed"), Type.Literal("static")], { description: "executed: shown by running a probe or check; static: shown by reading only." }),
    requirement: Type.Optional(Type.String({ pattern: "^R[1-9][0-9]*$" })),
    claim: text(500),
    evidence: text(800),
    probe: Type.Optional(Type.String({ minLength: 1, maxLength: 400, description: "Command that exits non-zero while the defect exists and 0 once it is fixed (required for an executed blocking finding)." })),
    quote: Type.Optional(Type.String({ minLength: 1, maxLength: 400, description: "The request's words the change contradicts (required for a static blocking finding)." })),
  }), { maxItems: CHECK_LIMITS.findings }),
  checks: Type.Array(Type.Object({ command: text(400), exitCode: Type.Integer(), summary: text(300) }), { maxItems: CHECK_LIMITS.checks, description: "The project's test, lint or typecheck shell commands you ran for this change, exactly as run, with their exit codes: no probes, no inspection commands (git, cat, ls) and no tool calls." }),
});
export type Check = Static<typeof checkSchema>;
export type Finding = Check["findings"][number];

export function checkReport(check: Check, scratch: string): string | undefined {
  const ids = check.findings.map(item => item.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) return `Duplicate finding id ${duplicate}.`;
  for (const item of check.findings) {
    if (item.severity !== "blocking") continue;
    if (item.kind === "executed" && !item.probe) return `${item.id}: an executed blocking finding needs probe, the command that fails while the defect exists.`;
    if (item.kind === "static" && !item.quote) return `${item.id}: a static blocking finding needs quote, the request's words it contradicts; otherwise make it minor or show it with a probe.`;
    if (item.probe && !allowedCommand(item.probe, scratch)) return `${item.id}: probe ${JSON.stringify(item.probe)} is not a command orche can re-run: run a probe file inside ${scratch}/ with node, python3, bun, deno, tsx or sh, or a supported project check.`;
  }
  const blocking = check.findings.some(item => item.severity === "blocking");
  if (blocking !== (check.verdict === "fail")) return blocking ? "verdict must be fail when a finding is blocking." : "verdict must be pass when no finding is blocking.";
  return undefined;
}

export const SCRATCH_ROOT = ".orche/scratch";
/** The task's scratch directory, relative to the cwd (POSIX). */
export const scratchDir = (task: string): string => `${SCRATCH_ROOT}/${task}`;

const PROBE_NAME = /\.probe\.[A-Za-z0-9]+$/;
const INTERPRETERS = new Set(["node", "python3", "python", "bun", "deno", "tsx", "sh", "bash"]);
const SIMPLE_ARG = /^[A-Za-z0-9_./:=,@%+-]+$/;

/** A write the Verifier may make: a `.probe.` file inside its scratch directory. */
export function probePathError(cwd: string, scratch: string, path: unknown): string | undefined {
  if (typeof path !== "string" || !path.trim()) return "Verifier writes need a path.";
  const target = resolve(cwd, path);
  const rel = relative(resolve(cwd, scratch), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return `The Verifier may write only probe files inside ${scratch}/ (got ${path}); never edit the change under review.`;
  if (!PROBE_NAME.test(basename(target)) && !rel.includes(`${sep}fixtures${sep}`) && !rel.startsWith(`fixtures${sep}`)) return `Probe file names must contain ".probe." (e.g. ${scratch}/retry.probe.mjs); helper data goes in ${scratch}/fixtures/.`;
  return undefined;
}

/** A probe run: `[cd <dir> && ]<interpreter> [tsx] <scratch>/<name>.probe.<ext> [simple args]`. */
function isProbeRun(command: string, scratch: string): boolean {
  let rest = command.trim();
  const cd = /^cd\s+([A-Za-z0-9_./-]+)\s*&&\s*/.exec(rest);
  if (cd) rest = rest.slice(cd[0].length);
  const words = rest.split(/\s+/);
  if (words.some(word => !SIMPLE_ARG.test(word))) return false;
  let index = 0;
  if (words[0] === "npx" && words[1] === "--no-install" && words[2] === "tsx") index = 2;
  if (words[index] === "deno" && words[index + 1] === "run") index++;
  if (!INTERPRETERS.has(words[index] ?? "") && words[index] !== "run") return false;
  const file = words.slice(index + 1).find(word => !word.startsWith("-"));
  if (!file || !PROBE_NAME.test(file)) return false;
  const base = cd ? cd[1]! : ".";
  const rel = relative(resolve("/w", scratch), resolve("/w", base, file));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep);
}

/** Commands the Verifier (and the recheck) may run: the main session's trusted-check shell policy, plus probe runs. */
export function allowedCommand(command: string, scratch: string): boolean {
  return classifyBash(command).allowed || isProbeRun(command, scratch);
}

/** Tool guard of the Verifier session: read-only tools, probe writes in the scratch directory, guarded shell. */
export function verifierGuard(cwd: string, scratch: string) {
  return (toolName: string, input: Record<string, unknown>): string | undefined => {
    if (toolName === "write" || toolName === "edit") return probePathError(cwd, scratch, input.path);
    if (toolName === "ast_rewrite") return "The Verifier never rewrites code; write a probe file instead.";
    if (toolName === "bash") {
      const command = typeof input.command === "string" ? input.command : "";
      if (allowedCommand(command, scratch)) return undefined;
      const verdict = classifyBash(command);
      return `Blocked for the Verifier: ${verdict.allowed ? "" : verdict.reason}. Allowed: inspection commands, the project's checks (e.g. npm test, node --test, pytest, cargo test, go test, npx --no-install vitest run) and probe runs such as \`node ${scratch}/name.probe.mjs\`.`;
    }
    return undefined;
  };
}

export const VERIFIER_INSTRUCTIONS = `You are the Verifier of a code change you did not write. Your job is to find out whether it really meets the contract, by execution rather than by reading alone: run the project's checks, and write small probe scripts for requirements and edge cases the tests do not show. Probe files go only in the scratch directory given in the prompt, with ".probe." in the name; never edit any other file. A probe exits 0 when the behaviour is correct and non-zero while a defect exists, so it can be re-run after a fix. The readings chosen for ambiguous wording are decided: verify against them; if you believe one contradicts the request, report that as a minor finding. Report a finding as blocking only with executed evidence (a failing probe or check) or a direct contradiction of the request's quoted words; at most six findings, no style remarks, no restating what passed. Finish by calling report_check exactly once; do not answer in plain text. Write in the language of the request.`;

export interface VerifierInput {
  task: string;
  scratch: string;
  /** The user's original request, verbatim. */
  original?: string;
  /** The hand-off the Primary got (the Framer's contract and the main session's request). */
  handoff: string;
  checklist?: readonly { id: string; status: string; evidence: string; verifiedBy?: string }[];
  ambiguities?: readonly { id?: string; readings: string[]; chosen: string }[];
  files: readonly { path: string; added: number; removed: number }[];
  /** Workspace-relative path of the diff file. */
  diffFile: string;
  diffTruncated: boolean;
  verifyCommands: readonly string[];
}

export function verifierPrompt(input: VerifierInput): string {
  return [
    `Verify the change made for task ${input.task}.`,
    "",
    "## What was asked (the implementer's hand-off, verbatim)",
    input.handoff.trim(),
    ...(input.original && !input.handoff.includes(input.original.trim()) ? ["", "## The user's original request", input.original.trim()] : []),
    "",
    "## The change",
    `Files: ${input.files.map(file => `${file.path} (+${file.added} -${file.removed})`).join(", ") || "none"}.`,
    `Diff: ${input.diffFile}${input.diffTruncated ? " (truncated; read the files for the rest)" : ""}.`,
    ...(input.checklist?.length ? ["", "## The implementer's claims (self-reported; verify, do not trust)", ...input.checklist.map(item => `- ${item.id} ${item.status}: ${item.evidence}${item.verifiedBy ? ` (verified by: ${item.verifiedBy})` : ""}`)] : []),
    ...(input.ambiguities?.length ? ["", "## Readings the implementer chose for ambiguous wording", ...input.ambiguities.map(item => `- ${item.id ?? "?"}: "${item.chosen}" over ${item.readings.filter(reading => reading !== item.chosen).map(reading => `"${reading}"`).join(", ")}`)] : []),
    "",
    "## How",
    `- Run the project's relevant checks from the directory they belong to${input.verifyCommands.length ? ` (configured: ${input.verifyCommands.map(command => `\`${command}\``).join(", ")})` : ""} and report those shell commands in checks; orche re-runs the passing ones after a fix.`,
    `- For each requirement, find the test or probe that shows its acceptance (trace). Write probes for what the tests do not show, especially edge requirements: ${input.scratch}/<name>.probe.<ext>, run with node, python3, bun, deno, npx --no-install tsx or sh (e.g. \`node ${input.scratch}/retry.probe.mjs\`). Import the project's code by relative path from the probe file.`,
    "- A blocking finding names its requirement, its evidence and probe: the exact command to re-run (it must fail now). Keep probes small and deterministic.",
  ].join("\n");
}

/** Write the diff for the Verifier into the scratch directory; returns its workspace-relative path. */
export async function writeScratchDiff(cwd: string, scratch: string, round: number, diff: string): Promise<string> {
  const dir = join(cwd, scratch);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Like .orche/artifacts: out of git status and out of rg/fd searches (the workspace audit skips .orche anyway).
  for (const name of [".gitignore", ".ignore"]) await writeFile(join(cwd, SCRATCH_ROOT, name), "*\n", { flag: "wx" }).catch(() => undefined);
  const file = `${scratch}/change-${round}.diff`;
  await writeFile(join(cwd, file), diff, { mode: 0o600 });
  return file;
}

export interface CommandResult { command: string; exitCode: number | null; output: string; skipped?: string; durationMs: number }

/** Run one re-check command (guarded exactly like the Verifier's own shell). */
export async function runCheckCommand(cwd: string, scratch: string, command: string, signal?: AbortSignal): Promise<CommandResult> {
  const started = Date.now();
  if (!allowedCommand(command, scratch)) return { command, exitCode: null, output: "", skipped: "not an allowed check or probe command", durationMs: 0 };
  return new Promise(done => {
    execFile("bash", ["-c", command], { cwd, timeout: CHECK_LIMITS.recheckTimeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}), env: { ...process.env, CI: "1", NO_COLOR: "1" } }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      const tail = output.length > CHECK_LIMITS.recheckOutputChars ? `…${output.slice(-CHECK_LIMITS.recheckOutputChars)}` : output;
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
      done({ command, exitCode: code, output: tail, durationMs: Date.now() - started });
    });
  });
}

export interface FindingStatus { id: string; status: "fixed" | "open" | "disputed" | "unchecked"; detail: string }
export interface Recheck { findings: FindingStatus[]; checks: CommandResult[] }

/**
 * After the fix round: re-run every blocking finding's probe and every check the Verifier ran that passed before (a check that
 * already failed is not the fix's job unless a finding names it). A finding the Primary disputed keeps its probe result but is
 * reported as disputed when the probe still fails.
 */
export async function recheck(cwd: string, scratch: string, check: Check, disputed: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<Recheck> {
  const findings: FindingStatus[] = [];
  for (const finding of check.findings.filter(item => item.severity === "blocking")) {
    if (!finding.probe) { findings.push({ id: finding.id, status: disputed.has(finding.id) ? "disputed" : "unchecked", detail: disputed.get(finding.id) ?? "no probe to re-run" }); continue; }
    const result = await runCheckCommand(cwd, scratch, finding.probe, signal);
    if (result.skipped) findings.push({ id: finding.id, status: "unchecked", detail: result.skipped });
    else if (result.exitCode === 0) findings.push({ id: finding.id, status: "fixed", detail: `probe exits 0` });
    else findings.push({ id: finding.id, status: disputed.has(finding.id) ? "disputed" : "open", detail: `probe exits ${result.exitCode ?? "killed"}${disputed.has(finding.id) ? `; the implementer disputes it: ${disputed.get(finding.id)}` : ""}${result.output ? `: ${result.output.split("\n").slice(-3).join(" ").slice(0, 300)}` : ""}` });
  }
  const checks: CommandResult[] = [];
  for (const item of check.checks.filter(entry => entry.exitCode === 0)) checks.push(await runCheckCommand(cwd, scratch, item.command, signal));
  return { findings, checks };
}

export function fixPrompt(task: string, check: Check, scratch: string): string {
  const blocking = check.findings.filter(item => item.severity === "blocking");
  return [
    `Assignment: implement (fix round for task ${task}). An independent Verifier checked your change and found blocking problems. Fix them without undoing anything else, keep or add regression tests, rerun the project's checks, and finish with report_result again, with the complete checklist (every requirement id of the contract) and the same rules as before. Its summary replaces your previous one: describe the whole change, not only this fix.`,
    ...blocking.map(item => `- ${item.id}${item.requirement ? ` (${item.requirement})` : ""}: ${item.claim}\n  Evidence: ${item.evidence}${item.probe ? `\n  Re-run: \`${item.probe}\` (exits 0 once fixed)` : ""}${item.quote ? `\n  Request: "${item.quote}"` : ""}`),
    `The probe files in ${scratch}/ are the Verifier's: run them, never edit them. If a finding is wrong (the request, the contract or the tests show the current behaviour is right), do not change the code for it; report it in data.disputed as [{"id":"F1","reason":"…"}].`,
  ].join("\n");
}

export function formatCheck(check: Check, recheckResult?: Recheck): string[] {
  const blocking = check.findings.filter(item => item.severity === "blocking");
  const minor = check.findings.filter(item => item.severity === "minor");
  const missing = check.trace.filter(item => item.status !== "covered");
  const lines = [`Verifier: ${check.verdict}${blocking.length ? `, ${blocking.length} blocking` : ""}${minor.length ? `, ${minor.length} minor` : ""}; checks: ${check.checks.map(item => `\`${item.command}\` ${item.exitCode === 0 ? "pass" : `exit ${item.exitCode}`}`).join(", ") || "none run"}${missing.length ? `; not shown: ${missing.map(item => `${item.id} ${item.status}`).join(", ")}` : ""}`];
  const statusOf = (id: string) => recheckResult?.findings.find(item => item.id === id);
  for (const item of check.findings) {
    const status = statusOf(item.id);
    lines.push(`- ${item.id} ${item.severity}${item.requirement ? ` ${item.requirement}` : ""} (${item.kind}): ${item.claim}${status ? ` → ${status.status}: ${status.detail}` : ""}`);
  }
  if (recheckResult?.checks.length) lines.push(`Recheck (orche, no LLM): ${recheckResult.checks.map(item => `\`${item.command}\` ${item.skipped ? `skipped (${item.skipped})` : item.exitCode === 0 ? "pass" : `exit ${item.exitCode ?? "killed"}`}`).join(", ")}`);
  return lines;
}
