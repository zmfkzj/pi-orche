/**
 * Bash safety review: a small accident-prevention belt, NOT a sandbox. Before a Bash tool invocation that writes or plausibly
 * mutates something ({@link bashMayWrite}, bash-mutation.ts) runs, a classifier model (Jev by default, `typesafe/jev-latest`)
 * answers one binary question: run it, yes or no.
 *
 * - yes: the invocation goes on to execution (the existing guards already ran before the review).
 * - no: it never reaches the shell; the agent gets an instruction to rewrite it and submit the corrected command, which is
 *   reviewed again. There is no denial counter and no automatic override.
 * - no verdict (unknown model, provider/network error, timeout, cancellation, empty or malformed answer): it does not run
 *   either, reported as a failed review, never as a yes and never as a no.
 *
 * Coverage is best effort. Which invocations are reviewed is a heuristic reading of the command text, independent of main's
 * permission policy (bash-policy.ts): recognised reads skip the review, everything else (writes, writing options, unknown
 * programs, build/test/package scripts, text it cannot follow) is reviewed. The reviewer sees only the command string and a little
 * context (cwd, home, task, extra write roots); it cannot see what scripts, Makefiles, package scripts, git hooks or other
 * programs the command starts will do, and other tools (edit/write, MCP, GUI) are not reviewed here.
 */
import { homedir } from "node:os";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { bashMayWrite } from "./bash-mutation.js";

/** `bashReview` in orche.config.json, with defaults applied. */
export interface BashReviewSettings {
  /** Default true. */
  enabled: boolean;
  /** `provider/id` of a classifier model. Default `typesafe/jev-latest` (Jev). */
  model: string;
  /** No verdict within this many milliseconds is a failed review (the command does not run). Default 15000. */
  timeoutMs: number;
}
export const DEFAULT_BASH_REVIEW_MODEL = "typesafe/jev-latest";
export const DEFAULT_BASH_REVIEW: Readonly<BashReviewSettings> = { enabled: true, model: DEFAULT_BASH_REVIEW_MODEL, timeoutMs: 15_000 };
export const BASH_REVIEW_TIMEOUT_RANGE = { min: 1000, max: 120_000 } as const;

type ClassifierModelArg = Parameters<ModelRuntime["classify"]>[0];
/** What the review needs from Pi's model layer: main's `ctx.modelRegistry` and a session's `ModelRuntime` both fit. */
export interface ClassifierAccess {
  find(provider: string, id: string): ClassifierModelArg | undefined;
  classify(model: ClassifierModelArg, context: ClassifierContext, options: { signal: AbortSignal }): Promise<ClassifierResult>;
}
export const registryAccess = (registry: Pick<ModelRegistry, "findOfType" | "classify">): ClassifierAccess => ({
  find: (provider, id) => registry.findOfType("classifier", provider, id),
  classify: (model, context, options) => registry.classify(model, context, options),
});
export const runtimeAccess = (runtime: Pick<ModelRuntime, "getModelOfType" | "classify">): ClassifierAccess => ({
  find: (provider, id) => runtime.getModelOfType("classifier", provider, id),
  classify: (model, context, options) => runtime.classify(model, context, options),
});

/** True when the command writes or plausibly mutates something (bash-mutation.ts); recognised reads are not reviewed. */
export function needsBashReview(command: unknown): command is string {
  return typeof command === "string" && command.trim() !== "" && bashMayWrite(command);
}

export interface BashReviewRequest {
  command: string;
  cwd: string;
  /** The intended task (user prompt or assignment request); clipped and redacted before it is sent. */
  task?: string;
  /** Directories outside cwd the agent was explicitly allowed to write. */
  writeRoots?: readonly string[];
}
export type BashReviewVerdict =
  | { verdict: "yes" }
  | { verdict: "no" }
  | { verdict: "failed"; reason: string; cancelled?: boolean };

const SECRET_NAME = "[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*";
const REDACTIONS: [RegExp, string][] = [
  // NAME=value assignments and exports of secret-looking variables.
  [new RegExp(`\\b(${SECRET_NAME})=("[^"]*"|'[^']*'|[^\\s;|&]+)`, "gi"), "$1=[REDACTED]"],
  // --token=x / --password x style options.
  [/(--?(?:password|passwd|token|secret|api-?key|access-?key)(?:=|\s+))("[^"]*"|'[^']*'|[^\s;|&]+)/gi, "$1[REDACTED]"],
  // Authorization headers.
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]"],
  // user:password@ in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@"],
];
/** Masks secret-looking values (variables, options, auth headers, URL credentials) before text leaves the process. Best effort. */
export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters not shown]` : text;

/** The one binary question; Jev answers `choice` questions with exactly one of the criteria keys. */
const RUN_QUESTION = {
  type: "choice" as const,
  instructions: [
    "An AI coding agent is about to run `command` with bash in `cwd` (home directory `home`) while working on `task`.",
    "This is an accident check, not a sandbox: answer yes unless running the command as written is likely to cause unintended, hard-to-undo damage.",
    "Ordinary development work is yes, including writes outside cwd, git commit and push, package installs, builds, network access, ssh, sudo, docker and deployment that fit the task.",
    "Answer no for mistakes such as recursive or forced deletes, moves, chmod/chown or overwrites whose target is or could become /, ~ or the whole home directory, a parent directory or a whole project;",
    "targets built from a variable or substitution that may be empty or unset (for example rm -rf \"$DIR/\"* with DIR unset); overly broad globs; wrong or mistyped absolute paths;",
    "or destructive effects the task does not ask for.",
  ].join(" "),
  criteria: {
    yes: "Run it: no likely accidental destructive or overly broad effect",
    no: "Do not run it: likely accidental destructive, overly broad or unintended effect",
  },
};

function reviewState(request: BashReviewRequest): ClassifierContext["state"] {
  return {
    command: clip(redactSecrets(request.command), 8000),
    cwd: request.cwd,
    home: homedir(),
    ...(request.task?.trim() ? { task: clip(redactSecrets(request.task.trim()), 2000) } : {}),
    ...(request.writeRoots?.length ? { extraWriteRoots: [...request.writeRoots] } : {}),
  };
}

/** Provider error texts reach the agent only as one short, redacted line. */
const failed = (reason: string, cancelled = false): BashReviewVerdict => ({ verdict: "failed", reason: redactSecrets(reason.replace(/\s+/g, " ").trim()).slice(0, 200) || "unknown error", ...(cancelled ? { cancelled } : {}) });

/** Ask the classifier once. Never throws; anything but a clean yes/no answer is `failed`. */
export async function reviewBashCommand(request: BashReviewRequest, settings: BashReviewSettings, access: ClassifierAccess, signal?: AbortSignal): Promise<BashReviewVerdict> {
  if (signal?.aborted) return failed("cancelled", true);
  const slash = settings.model.indexOf("/");
  let model: ClassifierModelArg | undefined;
  try { model = slash > 0 ? access.find(settings.model.slice(0, slash), settings.model.slice(slash + 1)) : undefined; } catch { model = undefined; }
  if (!model) return failed(`classifier model ${settings.model} is not in the model catalog`);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("timeout")), settings.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let result: ClassifierResult;
  try {
    // Raced against the abort as well, so a provider that ignores the signal cannot hold the command past the timeout.
    result = await new Promise<ClassifierResult>((resolve, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      if (combined.aborted) return onAbort();
      combined.addEventListener("abort", onAbort, { once: true });
      access.classify(model!, { state: reviewState(request), questions: { run: RUN_QUESTION } }, { signal: combined })
        .then(resolve, reject).finally(() => combined.removeEventListener("abort", onAbort));
    });
  } catch (error) {
    if (signal?.aborted) return failed("cancelled", true);
    if (timeout.signal.aborted) return failed(`no verdict within ${settings.timeoutMs}ms`);
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
  if (signal?.aborted) return failed("cancelled", true);
  if (result.stopReason !== "stop") return result.stopReason === "aborted" && timeout.signal.aborted ? failed(`no verdict within ${settings.timeoutMs}ms`) : failed(result.errorMessage?.trim() || `classifier stopped: ${result.stopReason}`);
  const answer = result.answers?.run;
  if (answer?.type !== "choice" || (answer.choice !== "yes" && answer.choice !== "no")) return failed(`malformed verdict ${JSON.stringify(answer ?? null).slice(0, 200)}`);
  return { verdict: answer.choice };
}

/** The tool-call block reason of a verdict; undefined for yes. */
export function bashReviewBlockReason(verdict: BashReviewVerdict, settings: BashReviewSettings): string | undefined {
  if (verdict.verdict === "yes") return undefined;
  if (verdict.verdict === "no") {
    return `Bash safety review (${settings.model}) answered no: this command was NOT run. The reviewer judged it likely to cause accidental damage beyond what the task needs `
      + "(for example a delete, move or overwrite whose target could expand to /, ~, a whole project or an empty path, a too-broad glob, or a mistyped absolute path). "
      + "Rewrite the command so every write target is explicit and only as broad as the task needs (literal paths, ${VAR:?} guards for variables, narrower globs, a listing or dry run first), "
      + "then run the corrected command: it is reviewed again and runs on yes. Do not resubmit it unchanged or disguised, and do not route the same effect through another tool. "
      + "If the task truly needs exactly this effect, report that to the user instead; there is no override.";
  }
  if (verdict.cancelled) return "Bash safety review was cancelled: this command was NOT run.";
  return `Bash safety review (${settings.model}) gave no verdict (${verdict.reason}): this command was NOT run. This is not a judgment that the command is unsafe. `
    + `Run the same command again to retry the review; if it keeps failing, stop and tell the user (check the ${settings.model} credentials, or bashReview in orche.config.json).`;
}

export interface BashReviewGuard {
  settings: BashReviewSettings | undefined;
  /** Resolved only when a review is needed. */
  access: () => ClassifierAccess | undefined;
  cwd: string;
  task?: string | undefined;
  writeRoots?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
}
/**
 * The review step of a tool-call guard: undefined (go on) for every tool but bash, a disabled review, or a known read-only
 * command; otherwise the classifier decides and anything but yes is the block reason.
 */
export async function guardBashReview(toolName: string, input: Record<string, unknown>, guard: BashReviewGuard): Promise<string | undefined> {
  const settings = guard.settings;
  if (toolName !== "bash" || !settings?.enabled || !needsBashReview(input.command)) return undefined;
  let access: ClassifierAccess | undefined;
  try { access = guard.access(); } catch { access = undefined; }
  const verdict = access
    ? await reviewBashCommand({ command: input.command, cwd: guard.cwd, ...(guard.task ? { task: guard.task } : {}), ...(guard.writeRoots?.length ? { writeRoots: guard.writeRoots } : {}) }, settings, access, guard.signal)
    : failed("no model registry in this session");
  return bashReviewBlockReason(verdict, settings);
}
