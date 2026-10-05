import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAIN_MODE, LEGACY_MAIN_MODES, loadRouteConfig, MAIN_MODES, type MainMode } from "../orchestration/routing.js";
import { classifyBash, READ_ONLY_GIT_SUBCOMMANDS, type BashHint } from "./bash-policy.js";
import { CONFIG_FILE } from "./config.js";
import { WORK_TYPE_RULE } from "../single/work-types.js";

export const MODE_ENTRY_TYPE = "orche-mode";
/** Records which tools the mode switched off, so a reload (which keeps the reduced active set) can switch them back on. */
export const TOOLS_ENTRY_TYPE = "orche-tools";
/** Tools the main session may not use while it must delegate every change. */
const EDIT_TOOLS: readonly string[] = ["edit", "write", "ast_rewrite"];
const SHELL_TOOLS: readonly string[] = ["bash", "powershell"];
export const DELEGATION_TOOLS: readonly string[] = ["orche_task"];

export function isMainMode(value: unknown): value is MainMode {
  return typeof value === "string" && (MAIN_MODES as readonly string[]).includes(value);
}
/** `auto` and `multi` were removed (multi-agent delegation measured no better than one worker); they now mean `single`. */
export function isLegacyMainMode(value: unknown): value is (typeof LEGACY_MAIN_MODES)[number] {
  return typeof value === "string" && (LEGACY_MAIN_MODES as readonly string[]).includes(value);
}
/** Tools that are switched off (removed from the active set) in `mode`. */
export function blockedTools(mode: MainMode): readonly string[] {
  return mode === "single" ? EDIT_TOOLS : DELEGATION_TOOLS;
}

const REFERENCE_RULE = "Pass references, not copies: repository paths with line ranges or symbol names, reproduction commands, artifact and run-record paths. Paste only short decisive snippets a worker cannot reproduce (an exact error line or user-provided text); never whole files, diffs or long logs.";
/** Single pipeline v2 (`single.pipeline: "v2"`): the Framer writes implement contracts and a risk-gated Verifier checks results, so main does neither. */
const V2_HANDOFF = "Single hand-off (pipeline v2): main analyses the user's intent and purpose. For implement, write `request` as: Intent/Purpose; Constraints and non-goals; Assumptions (explicit when there is no UI); and a final Original request section containing the user's ORIGINAL request text verbatim. Do not write a requirements checklist for implement: orche's Framer reads your request and the repository and writes the contract the worker reports on (requirement ids with acceptance and edge cases, the readings it settled for ambiguous wording, invariants); after the worker, a risk score decides whether an independent Verifier checks the result by execution, its blocking findings go back to the same worker, and orche re-runs its probes. For answer, write a numbered requirements checklist R1..Rn as lines `R1: …`. Put relevant background and file/evidence references in `context`. One end-to-end assignment per round: implement for changes, answer for read-only questions. Standard roles inherit main's CURRENT model and thinking at hand-off and compact above 50% context, preserving the contract, original request and the assignment's plan. Specialists keep their routes and do not receive task_plan or 50% compaction.";
const V2_REUSE = "Reuse: problems and user follow-ups go to the SAME worker (pass its id in `worker`). For implement, state additional or corrected requirements in words in the new request (the Framer carries the task's earlier requirements over by id); for answer, restate them as R-ids. When a requirement remains unmet or partial for 2 consecutive assignments of that worker, hand ONLY the unmet items to a NEW worker (omit worker), with their requirements, relevant file references and the previous worker's evidence; do not resend the whole task. When a result names a task ledger (`Task ledger T…`), pass that id in `task` for every follow-up of the same task, including the new worker that takes over unmet items; omit `task` for a different user task, even when you reuse the worker. Never claim a reuse that did not happen (unknown ids are errors; workers are gone after a reload, and only a task id continues their work).";
const V2_SUPERVISION = "Supervision: a worker's report is not acceptance, and its checklist is a self-report. Read the result: the Framer's settled readings, the risk score and, when it ran, the Verifier's findings with orche's recheck. Check every settled or worker-chosen reading against the user's original wording: when one differs from what the user meant, or is marked as needing the user's decision, ask the user (with a UI) or send a correction to the same task. Report open, disputed or unchecked findings and unverified items as such; do not re-verify the change yourself. An explicit review or verification request in the user's words makes the Verifier run; send a separate verify assignment only when the user asks for one after the fact.";
/** Stable per effective mode and config: never include session state or a worker roster here. */
export function delegationRules(mode: MainMode, options: { pipeline?: "v1" | "v2" } = {}): string {
  if (mode === "direct")
    return "orche mode: direct. Delegation tools are disabled; make changes directly with your own tools. You may edit user-requested paths outside the cwd/workspace, including absolute paths and ../ paths. Delegated workers' workspace confinement does not restrict this main direct session; their scope remains unchanged. Existing OS permissions and other policies still apply; direct mode does not grant elevated OS privileges or bypass those restrictions.";
  return [
    "orche mode: single. You cannot edit files in this session: edit, write and ast_rewrite are disabled; explicit shell mutations and unverified shell syntax are blocked. You keep the conversation, requirements and acceptance, with limited inspection to state the task precisely and trusted project checks for acceptance. Do not explore or implement the codebase yourself; delegate with orche_task.",
    "orche_task (single): one persistent worker; available roles: explore | answer | implement | verify | game-asset | video. For this workflow choose implement for changes, answer for read-only questions. The worker owns the whole task end to end: investigate, implement completely, add or update tests, run relevant project checks and iterate until they pass, then report.",
    WORK_TYPE_RULE,
    "Git: workers never commit or push on their own, and this session cannot run commits itself. Only when the user explicitly asked in this conversation to commit or push, pass `git` ({commit:true} or {push:true, remote?, branch?}) to an implement, game-asset or video orche_task; explore, answer and verify reject it. The grant covers that assignment only, so scope the commit to the task's files where possible (pass `files` and name the paths in `request`) and check the commits listed in the result before reporting.",
    "Single workflow: refine the requirements with the user: goal, constraints and acceptance criteria. Inspect only what is needed to state the task precisely. Ask the user only about decisions you cannot reasonably make; without a UI, make a reasonable assumption and state it in the request and final report. Hand the whole task to ONE orche_task in ONE end-to-end assignment, even when it is large or risky: role implement for changes, answer for read-only questions. Do not split the task into explore/implement/verify phases, and never send an explore before an implement for the same request. Never stop to ask the user to switch modes in order to proceed, and never end a turn without attempting the requested change because of its size or risk. This workflow is the same with and without a UI.",
    ...(options.pipeline === "v2" ? [V2_HANDOFF, V2_REUSE, V2_SUPERVISION] : [
      "Single hand-off: main analyses the user's intent, purpose and requirements. Write `request` as: Intent/Purpose; numbered requirements checklist R1..Rn as lines `R1: …`, each testable with acceptance criteria; Constraints and non-goals; Assumptions (explicit when there is no UI); and a final Original request section containing the user's ORIGINAL request text verbatim. Put relevant background and file/evidence references in `context`. One end-to-end assignment per round: implement for changes, answer for read-only questions. The worker analyses requirements, creates a Task DAG with task_plan and executes nodes sequentially without main intervention while it runs. Standard roles inherit main's CURRENT model and thinking at hand-off and compact above 50% context, preserving requirements, original request and the assignment's plan. Specialists keep their routes and do not receive task_plan or 50% compaction.",
      "Reuse: problems and user follow-ups go to the SAME worker (pass its id in `worker`). Review the result, its evidence and checklist, and run trusted project checks. Restate additional or corrected requirements in the same hand-off format with new R-ids or revised ones and repeat. When a requirement remains unmet or partial for 2 consecutive assignments of that worker, hand ONLY the unmet items to a NEW worker (omit worker), with their requirements, relevant file references and the previous worker's evidence; do not resend the whole task. When a result names a task ledger (`Task ledger T…`), pass that id in `task` for every follow-up of the same task, including the new worker that takes over unmet items; omit `task` for a different user task, even when you reuse the worker. Never claim a reuse that did not happen (unknown ids are errors; workers are gone after a reload, and only a task id continues their work).",
      "Supervision: a worker's report is not acceptance, and its checklist is a self-report. Read the report and its key evidence, run the trusted project checks yourself, check every reported ambiguity's chosen reading against the user's original wording (send a correction to the same worker when it differs), and report unverified items as unverified. Send a separate verify assignment only when the user explicitly asks for independent verification; otherwise send problems to the same worker with what is wrong.",
    ]),
    REFERENCE_RULE,
  ].join("\n");
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
  const delegate = "Do not retry it directly: delegate the change with the orche_task tool (a self-contained request: goal, decisions so far, relevant files and findings, constraints, acceptance criteria).";
  const shellAdvice = "Use read with offset/limit, grep, simple static Bash inspection commands, or delegate with orche_task. Supported tests and linters are trusted project checks that may create generated files and execute project configuration, not guaranteed read-only.";
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
  /** The file names a removed mode (`auto`/`multi`), read as `single`. */
  legacyMode?: (typeof LEGACY_MAIN_MODES)[number];
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
 * orche config, `direct`. Only tools this class removed are ever restored (and the removed set is recorded in the session, because
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
      else if (isLegacyMainMode(mode)) this.chosen = "single";
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
