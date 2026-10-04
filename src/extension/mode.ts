import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAIN_MODE, loadRouteConfig, MAIN_MODES, type MainMode } from "../orchestration/routing.js";
import { classifyBash, READ_ONLY_GIT_SUBCOMMANDS, type BashHint } from "./bash-policy.js";
import { CONFIG_FILE } from "./config.js";

export const MODE_ENTRY_TYPE = "orche-mode";
/** Records which tools the mode switched off, so a reload (which keeps the reduced active set) can switch them back on. */
export const TOOLS_ENTRY_TYPE = "orche-tools";
/** Tools the main session may not use while it must delegate every change. */
const EDIT_TOOLS: readonly string[] = ["edit", "write", "ast_rewrite"];
const SHELL_TOOLS: readonly string[] = ["bash", "powershell"];
export const DELEGATION_TOOLS: readonly string[] = ["orche_run", "orche_task"];

export function isMainMode(value: unknown): value is MainMode {
  return typeof value === "string" && (MAIN_MODES as readonly string[]).includes(value);
}
/** Tools that are switched off (removed from the active set) in `mode`. */
export function blockedTools(mode: MainMode): readonly string[] {
  switch (mode) {
    case "auto": return EDIT_TOOLS;
    case "single": return [...EDIT_TOOLS, "orche_run"];
    case "multi": return [...EDIT_TOOLS, "orche_task"];
    case "direct": return DELEGATION_TOOLS;
  }
}

const REFERENCE_RULE = "Pass references, not copies: repository paths with line ranges or symbol names, reproduction commands, artifact and run-record paths. Paste only short decisive snippets a worker cannot reproduce (an exact error line or user-provided text); never whole files, diffs or long logs.";
const REQUEST_RULES = `orche runs do not see this conversation. Make \`request\` self-contained: the goal, the decisions made so far, the relevant files and findings from this conversation, constraints, and acceptance criteria (what must be true and how to check it). Put background that is not the instruction itself in \`context\`. ${REFERENCE_RULE} When orche_run returns, report its result to the user; do not redo its work.`;
const MULTI_CRITERIA = "(a) the user explicitly asks for multi-agent orchestration or parallel workers; (b) the request contains at least two independent units with disjoint write sets, each substantial on its own, where parallel execution clearly shortens the work; (c) a defect's cause is unknown AND parallel competing hypotheses are clearly warranted.";
/** Stable per effective mode: never include session state or a worker roster here. */
export function delegationRules(mode: MainMode): string {
  switch (mode) {
    case "direct":
      return "orche mode: direct. Delegation tools are disabled; make changes directly with your own tools. You may edit user-requested paths outside the cwd/workspace, including absolute paths and ../ paths. Delegated workers' workspace confinement does not restrict this main direct session; their scope remains unchanged. Existing OS permissions and other policies still apply; direct mode does not grant elevated OS privileges or bypass those restrictions.";
    case "multi":
      return `orche mode: multi. You cannot edit files in this session: edit, write and ast_rewrite are disabled; explicit shell mutations and unverified shell syntax are blocked. Delegate every change with the orche_run tool. orche_task is disabled in this mode; switch with /orche mode auto or single to use one delegated worker, or /orche mode direct to make changes directly. You keep the conversation, inspection (read, grep, find, ls, ast_search, diagnostics, simple static Bash such as git status), trusted project checks that may create generated files or execute project configuration, and composing the delegation request. PowerShell is unsupported in multi.\n${REQUEST_RULES}`;
    case "auto":
    case "single": {
      const multi = mode === "auto";
      return [
        multi
          ? `orche mode: ${mode}. You cannot edit files in this session: edit, write and ast_rewrite are disabled; explicit shell mutations and unverified shell syntax are blocked. You keep the conversation, inspection (read, grep, find, ls, ast_search, diagnostics, simple static Bash) and trusted project checks. Delegate changes through the single workflow with orche_task by default; use orche_run only under the strict multi criteria below:`
          : "orche mode: single. You cannot edit files in this session: edit, write and ast_rewrite are disabled; explicit shell mutations and unverified shell syntax are blocked. You keep the conversation, requirements and acceptance, with limited inspection to state the task precisely and trusted project checks for acceptance. Do not explore or implement the codebase yourself; delegate with orche_task.",
        multi
          ? "orche_task (single): one persistent worker; available roles: explore | answer | implement | verify | game-asset | video. For this workflow choose implement for changes, answer for read-only questions. The worker owns the whole task end to end. Use game-asset for game art/audio/model assets, and video for video production."
          : "orche_task (single): one persistent worker; available roles: explore | answer | implement | verify | game-asset | video. For this workflow choose implement for changes, answer for read-only questions. The worker owns the whole task end to end: investigate, implement completely, add or update tests, run relevant project checks and iterate until they pass, then report.",
        "Git: workers never commit or push on their own, and this session cannot run commits itself. Only when the user explicitly asked in this conversation to commit or push, pass `git` ({commit:true} or {push:true, remote?, branch?}) to an implement, game-asset or video orche_task; explore, answer and verify reject it. The grant covers that assignment only, so scope the commit to the task's files where possible (pass `files` and name the paths in `request`) and check the commits listed in the result before reporting.",
        multi
          ? `orche_run (multi): coordinator, parallel workers and an independent verifier. Use ONLY when one of these holds: ${MULTI_CRITERIA} Otherwise, and whenever in doubt, use single through orche_task. Size, risk, user-visible behaviour and a desire for verification alone are not multi triggers.`
          : "Single workflow: refine the requirements with the user: goal, constraints and acceptance criteria. Inspect only what is needed to state the task precisely. Ask the user only about decisions you cannot reasonably make; without a UI, make a reasonable assumption and state it in the request and final report. Hand the whole task to ONE orche_task in ONE end-to-end assignment, even when it is large, multi-sized or risky: role implement for changes, answer for read-only questions. Do not split the task into explore/implement/verify phases, and never send an explore before an implement for the same request. Never stop to ask the user to switch modes in order to proceed, and never end a turn without attempting the requested change because of its size or risk. orche_run is disabled in mode single. Multi is optional advice only: mention it at most once, in the final report after the work is done (for example, 'orche_run could parallelize this; /orche mode auto or multi'), never as a reason to stop. This workflow is the same with and without a UI.",
        "Single hand-off (also auto's orche_task path): main analyses the user's intent, purpose and requirements. Write `request` as: Intent/Purpose; numbered requirements checklist R1..Rn as lines `R1: …`, each testable with acceptance criteria; Constraints and non-goals; Assumptions (explicit when there is no UI); and a final Original request section containing the user's ORIGINAL request text verbatim. Put relevant background and file/evidence references in `context`. One end-to-end assignment per round: implement for changes, answer for read-only questions. Do not split the task into explore/implement/verify phases, and never send an explore before an implement for the same request. Never end a turn without attempting the requested change because of its size or risk. The worker analyses requirements, creates a Task DAG with task_plan and executes nodes sequentially without main intervention while it runs. Standard roles inherit main's CURRENT model and thinking at hand-off and compact above 50% context, preserving requirements, original request and the assignment's plan. Specialists keep their routes and do not receive task_plan or 50% compaction.",
        "Reuse: problems and user follow-ups go to the SAME worker (pass its id in `worker`). Review the result, its evidence and checklist, and run trusted project checks. Restate additional or corrected requirements in the same hand-off format with new R-ids or revised ones and repeat. When a requirement remains unmet or partial for 2 consecutive assignments of that worker, hand ONLY the unmet items to a NEW worker (omit worker), with their requirements, relevant file references and the previous worker's evidence; do not resend the whole task. Never claim a reuse that did not happen (unknown ids are errors; workers are gone after a reload).",
        "Supervision: a worker's report is not acceptance, and its checklist is a self-report: in benchmarks workers reported every item met while hidden acceptance tests still failed because they implemented a different reading of a requirement. Read the report and its key evidence, run the trusted project checks yourself, confirm for each requirement that the cited verifiedBy check asserts the acceptance as stated in the Original request, check every reported ambiguity's chosen reading against the user's original wording (send a correction to the same worker when it differs), and report unverified items as unverified. Send a separate verify assignment only when the user explicitly asks for independent verification; otherwise send problems to the same worker with what is wrong.",
        REFERENCE_RULE,
        ...(multi ? ["After a failed orche_run, do not start another orche_run for the same request (even if multi criteria hold). Send remaining issues to handed-over workers via orche_task: implement for fixes, verify for re-checks; pass the reported id in `worker` to reuse context.", REQUEST_RULES] : []),
      ].join("\n");
    }
  }
}

/** A concrete allowed alternative for a blocked shell command, derived from the verdict's hint. */
function hintSuggestion(hint: BashHint): string {
  switch (hint.kind) {
    case "expansion":
      return "quote literal patterns or use the find/grep/ls tools (e.g. find with pattern '**/*.ts')";
    case "leading-option": {
      const run = hint.tool === "git" ? "git <subcommand>" : `${hint.tool} run <script>`;
      return `use \`cd <dir> && ${run}\`${hint.option ? ` instead of the leading ${hint.option} option` : ""}`;
    }
    case "git-subcommand":
      return `allowed read-only git: ${READ_ONLY_GIT_SUBCOMMANDS.slice(0, 4).join(", ")}, …`;
  }
}

/**
 * Why a tool call must not run in `mode`, or undefined if it may. Delegation guards are against habitual direct edits,
 * not a sandbox: see bash-policy.ts for what the shell allowlist can and cannot know.
 */
export function guardToolCall(mode: MainMode, toolName: string, input: Record<string, unknown>): string | undefined {
  const prefix = `Blocked by orche mode "${mode}":`;
  if (mode === "direct") {
    if (DELEGATION_TOOLS.includes(toolName)) return `${prefix} ${toolName} is disabled; make the change directly with your own tools.`;
    return undefined;
  }
  if (mode === "single" && toolName === "orche_run") return `${prefix} orche_run is disabled in mode single; continue with orche_task (reuse a worker for follow-ups).`;
  if (mode === "multi" && toolName === "orche_task") return `${prefix} orche_task is disabled; delegate with orche_run or switch with /orche mode auto or /orche mode single.`;
  const tools = mode === "auto" ? "orche_task or orche_run tools" : mode === "single" ? "orche_task tool" : "orche_run tool";
  const delegate = `Do not retry it directly: delegate the change with the ${tools} (a self-contained request: goal, decisions so far, relevant files and findings, constraints, acceptance criteria).`;
  const shellAdvice = `Use read with offset/limit, grep, simple static Bash inspection commands, or delegate with ${mode === "auto" ? "orche_task or orche_run" : mode === "single" ? "orche_task" : "orche_run"}. Supported tests and linters are trusted project checks that may create generated files and execute project configuration, not guaranteed read-only.`;
  if (EDIT_TOOLS.includes(toolName)) return `${prefix} ${toolName} is disabled in this session. ${delegate}`;
  if (SHELL_TOOLS.includes(toolName)) {
    if (toolName === "powershell") return `${prefix} PowerShell is unsupported; this command could not be verified without a dedicated PowerShell parser. ${shellAdvice}`;
    if (typeof input.command !== "string" || !input.command.trim()) return `${prefix} invalid command; command must be a non-blank string and could not be verified. ${shellAdvice}`;
    const verdict = classifyBash(input.command);
    if (!verdict.allowed) {
      const suggestion = verdict.hint ? ` Suggestion: ${hintSuggestion(verdict.hint)}.` : "";
      if (verdict.category === "mutation") return `${prefix} this shell command explicitly requests mutation (${verdict.reason}). ${delegate} ${shellAdvice}${suggestion}`;
      return `${prefix} this shell command could not be verified (${verdict.reason}); unsupported does not mean mutating. ${shellAdvice}${suggestion}`;
    }
  }
  return undefined;
}

export interface MainModeLookup {
  mode?: MainMode;
  /** The config file that was read. */
  path?: string;
  /** The file exists but is invalid: the default mode applies. */
  error?: string;
}
/** `mainMode` from the same selected config file as the routes: trusted project file, else user file, else none. */
export async function discoverMainMode(options: { cwd: string; agentDir: string; projectTrusted: boolean }): Promise<MainModeLookup> {
  const candidates = [...(options.projectTrusted ? [join(options.cwd, ".pi", CONFIG_FILE)] : []), join(options.agentDir, CONFIG_FILE)];
  for (const path of candidates) {
    try {
      await access(path);
    } catch {
      continue;
    }
    try {
      const { mainMode } = await loadRouteConfig(path);
      return { ...(mainMode ? { mode: mainMode } : {}), path };
    } catch (error) {
      return { path, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return {};
}

export type ModeSource = "session" | "config" | "default";
interface SessionEntryLike { type: string; customType?: string; data?: unknown }
type ModeHost = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "getAllTools" | "appendEntry">;

/**
 * The main session's delegation mode and the tool set that goes with it. The effective mode is, in order:
 * a one-turn `/orche single` or `/orche direct` override, the mode chosen with `/orche mode` (persisted in the session), `mainMode` from the
 * orche config, `auto`. Only tools this class removed are ever restored (and the removed set is recorded in the session, because
 * Pi carries the reduced active set over a reload), so an explicit `--tools` selection is respected.
 */
export class MainModeState {
  private configured: MainMode | undefined;
  private configPath: string | undefined;
  private chosen: MainMode | undefined;
  private override: MainMode | undefined;
  private readonly removed = new Set<string>();
  private recorded = "";

  constructor(private readonly host: ModeHost) {}

  /** The mode the guard enforces right now. */
  get effective(): MainMode {
    return this.override ?? this.session;
  }
  /** The mode of the session, ignoring a one-turn override. */
  get session(): MainMode {
    return this.chosen ?? this.configured ?? DEFAULT_MAIN_MODE;
  }
  get source(): { source: ModeSource; path?: string } {
    if (this.chosen) return { source: "session" };
    if (this.configured) return { source: "config", ...(this.configPath ? { path: this.configPath } : {}) };
    return { source: "default" };
  }
  get overriding(): boolean {
    return this.override !== undefined;
  }

  setConfig(mode: MainMode | undefined, path?: string): void {
    this.configured = mode;
    this.configPath = path;
  }
  /** Adopt the last `/orche mode` choice recorded in the session branch. */
  restore(entries: readonly SessionEntryLike[]): void {
    this.chosen = undefined;
    this.removed.clear();
    this.recorded = "";
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType === TOOLS_ENTRY_TYPE) {
        const removed = entry.data && typeof entry.data === "object" && "removed" in entry.data && Array.isArray(entry.data.removed) ? entry.data.removed : [];
        this.removed.clear();
        for (const name of removed) if (typeof name === "string") this.removed.add(name);
        this.recorded = JSON.stringify([...this.removed].sort());
        continue;
      }
      if (entry.customType !== MODE_ENTRY_TYPE) continue;
      const mode = entry.data && typeof entry.data === "object" && "mode" in entry.data ? entry.data.mode : undefined;
      if (isMainMode(mode)) this.chosen = mode;
    }
  }
  choose(mode: MainMode): void {
    this.chosen = mode;
    this.host.appendEntry(MODE_ENTRY_TYPE, { mode });
    this.apply();
  }
  setOverride(mode?: MainMode): void {
    this.override = mode;
    this.apply();
  }
  /** Make the active tool set match the effective mode. */
  apply(): void {
    const blocked = new Set(blockedTools(this.effective));
    const registered = new Set(this.host.getAllTools().map(tool => tool.name));
    const active = this.host.getActiveTools();
    const next = active.filter(name => !blocked.has(name));
    for (const name of active) if (blocked.has(name)) this.removed.add(name);
    for (const name of [...this.removed]) {
      if (blocked.has(name)) continue;
      this.removed.delete(name);
      if (registered.has(name) && !next.includes(name)) next.push(name);
    }
    if (next.length !== active.length || next.some((name, index) => name !== active[index])) this.host.setActiveTools(next);
    const record = JSON.stringify([...this.removed].sort());
    if (record !== this.recorded) {
      this.recorded = record;
      this.host.appendEntry(TOOLS_ENTRY_TYPE, { removed: [...this.removed].sort() });
    }
  }
}
