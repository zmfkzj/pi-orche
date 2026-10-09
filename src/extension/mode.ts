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
export const DELEGATION_TOOLS: readonly string[] = ["orche_task", "orche_task_status", "orche_task_message", "orche_task_attach"];

export function isMainMode(value: unknown): value is MainMode {
  return typeof value === "string" && (MAIN_MODES as readonly string[]).includes(value);
}
/** `auto` and `multi` were removed (multi-agent delegation measured no better than one worker); they now mean `single`. */
export function isLegacyMainMode(value: unknown): value is (typeof LEGACY_MAIN_MODES)[number] {
  return typeof value === "string" && (LEGACY_MAIN_MODES as readonly string[]).includes(value);
}
/** Tools that are switched off (removed from the active set) in `mode`: single, strong and ultra delegate every change. */
export function blockedTools(mode: MainMode): readonly string[] {
  return mode === "direct" ? DELEGATION_TOOLS : EDIT_TOOLS;
}

/**
 * The background orche_task flow (jobs.ts): the call stays attached to its job like a blocking call; a steered user message or a
 * woken peer note detaches it, main answers, then attaches again; a queued follow-up waits for the result. Main never polls and can steer the worker.
 */
export const ASYNC_RULE = "Background tasks: in an interactive or RPC session orche_task runs as a job (J1, J2, …) and the call stays attached to it: it waits like a blocking call and returns the worker's result. A user message steered into the running turn or a message from another Pi session DETACHES it: the call returns at once, the worker keeps running. Then answer that input first. A queued follow-up message never detaches: like any follow-up it reaches you after the result, once this turn has nothing else to do, and it does not count as waiting. After answering, if the job is still running and nothing else is waiting for you, call orche_task_attach to wait for the result again; do not attach again after the user detached it themselves (/orche detach) unless they ask, and when the user interrupted with Esc only after answering their next message. A job that ends while detached delivers its result once as an orche-task-result message that starts your next turn. Never wait with sleep and never poll orche_task_status (call it only when the user asks about progress). To add or correct instructions for the running worker, use orche_task_message: it reaches the worker before its next model request and grants no new permissions; a message the worker could not read before it reported is listed as not delivered in the result, so send it as a follow-up orche_task then. One task runs at a time; orche_task_status with cancel:true (or the user's /orche cancel) stops it, detaching never does. Pass wait:true only when the result must not be interrupted. When the result arrives (attached result or message), review it as below and report to the user.";
const REFERENCE_RULE = "Pass references, not copies: repository paths with line ranges or symbol names, reproduction commands, artifact and run-record paths. Paste only short decisive snippets a worker cannot reproduce (an exact error line or user-provided text); never whole files, diffs or long logs.";
/**
 * Main reviews a result from the report alone, without re-reading the changed code or re-running checks itself (G-M + G-M2,
 * 48 tasks per arm: 48/48 vs 46/48 passed, main context 0.41x, cost 0.97x; docs/specialist-orchestration.md 10.6–10.7).
 */
const SUPERVISION_BASE = "Supervision: a worker's report is not acceptance, and its checklist is a self-report. Read the report: its checklist, the checks it names and the readings it chose; do not re-read the changed code or re-run the project checks to verify it yourself (the worker ran them and names them). Check every reported ambiguity's chosen reading against the user's original wording (send a correction to the same worker when it differs), and report unverified items as unverified.";
/** `single.spawn: false`: the earlier single worker, word for word. */
const SUPERVISION = `${SUPERVISION_BASE} Send a separate verify assignment only when the user explicitly asks for independent verification; otherwise send problems to the same worker with what is wrong.`;
/** With an orchestrator, an independent review the user asks for up front belongs in the request: the orchestrator runs it. */
const ORCHESTRATOR_SUPERVISION = `${SUPERVISION_BASE} The Split line says whether the worker used sub-workers and why; report an independent verification it ran with its verdict. Send a separate verify assignment only when the user asks for verification after the result; otherwise send problems to the same worker with what is wrong.`;
/**
 * The worker of implement/answer is an orchestrator (docs/orchestrator.md): it decides itself whether to split. Main must not
 * split the task across orche_task calls; it states the user's own wishes (e.g. an explicit independent review) in the request.
 */
const ORCHESTRATOR_RULE = "The implement or answer worker is an orchestrator: it decides itself whether the task needs sub-workers (independent parallel parts, an isolated game-asset or video specialist, a fresh independent verifier), runs them, integrates their results and reports its decision on a `Split:` line. Do not split the task across orche_task calls and do not tell it how to split; put the user's own wishes, such as an explicit request for independent review or verification, into the request in the user's words.";
/** Ultra (src/orchestrator/ultra.ts): the same one hand-off; the worker runs the enforced quality-first stages itself. */
const ULTRA_RULE = "The implement or answer worker is an ultra orchestrator: it runs an independent verification basis and hypotheses (exploration), 2-4 independent candidates (implementations in isolated workspace copies, or answers), execution-based evaluation, adoption of the best verified candidate, an independent counterexample review and integration checks; a report gate enforces the stages and its result carries `Ultra:` lines (stages, candidates, adoption, gate). Do not split the task across orche_task calls and do not prescribe the stages; ultra takes much longer and costs several times a single task, which the user chose for quality.";
const ULTRA_SUPERVISION = `${SUPERVISION_BASE} The Ultra lines say which stages ran, which candidate was adopted and whether the report gate passed; report a blocked stage with its reason and what was preserved. Send a separate verify assignment only when the user asks for verification after the result; otherwise send problems to the same worker with what is wrong.`;
export interface DelegationOptions {
  /** `single.spawn` (default true): the worker is an orchestrator that may spawn sub-workers. */
  spawn?: boolean;
  /** The mode's orchestrator tier names a model of its own (not `{ "model": "main" }`): standard roles run on it instead of main's model
   * (docs/orchestrator.md 12). */
  orchestratorModel?: boolean;
  /** That tier sets a thinking level of its own (not `"main"`, not omitted): standard roles do not take main's thinking. */
  orchestratorThinking?: boolean;
  /** The `models` key of that tier (default `orchestrator`; strong/ultra: `strong-orchestrator`, or `orchestrator` as its fallback). */
  orchestratorKey?: string;
}
/**
 * How standard roles get their model and thinking. Without a model or level of `models.orchestrator`'s own (unset, `"main"`, or
 * no thinking) the earlier sentence word for word; each part names main's CURRENT value only where it is really inherited.
 */
const MODEL_SENTENCE = {
  inherited: "Standard roles inherit main's CURRENT model and thinking at hand-off",
  inheritedModel: "Standard roles inherit main's CURRENT model at hand-off, with the thinking level configured in the orche config (models.orchestrator),",
  configured: "Standard roles run on the orchestrator model configured in the orche config (models.orchestrator), not on main's model, with main's CURRENT thinking at hand-off,",
  configuredBoth: "Standard roles run on the orchestrator model and thinking level configured in the orche config (models.orchestrator), not on main's,",
};
const modelSentence = (options: DelegationOptions) => (options.orchestratorModel
  ? options.orchestratorThinking ? MODEL_SENTENCE.configuredBoth : MODEL_SENTENCE.configured
  : options.orchestratorThinking ? MODEL_SENTENCE.inheritedModel : MODEL_SENTENCE.inherited).replace("(models.orchestrator)", `(models.${options.orchestratorKey ?? "orchestrator"})`);
/** The first sentence per delegating mode: strong and ultra are the single workflow on the strong tiers. */
const MODE_HEAD: Record<Exclude<MainMode, "direct">, string> = {
  single: "orche mode: single.",
  strong: "orche mode: strong (the single workflow on the strong model tiers: models.strong-orchestrator and models.strong-worker).",
  ultra: "orche mode: ultra (the single workflow with the quality-first ultra orchestration, on the strong model tiers).",
};
/** Stable per effective mode and config: never include session state or a worker roster here. */
export function delegationRules(mode: MainMode, options: DelegationOptions = {}): string {
  if (mode === "direct")
    return "orche mode: direct. Delegation tools are disabled; make changes directly with your own tools. You may edit user-requested paths outside the cwd/workspace, including absolute paths and ../ paths. Delegated workers' workspace confinement does not restrict this main direct session; their scope remains unchanged. Existing OS permissions and other policies still apply; direct mode does not grant elevated OS privileges or bypass those restrictions.";
  // ultra always orchestrates (its stages are orche_spawn calls); single and strong follow single.spawn.
  const spawn = mode === "ultra" || (options.spawn ?? true);
  return [
    `${MODE_HEAD[mode]} You cannot edit files in this session: edit, write and ast_rewrite are disabled; explicit shell mutations and unverified shell syntax are blocked. You keep the conversation, requirements and acceptance, with limited inspection to state the task precisely; acceptance rests on the checks the worker reports. Do not explore or implement the codebase yourself; delegate with orche_task.`,
    "orche_task (single): one persistent worker; available roles: explore | answer | implement | verify | game-asset | video. For this workflow choose implement for changes, answer for read-only questions. The worker owns the whole task end to end: investigate, implement completely, add or update tests, run relevant project checks and iterate until they pass, then report.",
    WORK_TYPE_RULE,
    "Git: workers never commit or push on their own, and this session cannot run commits itself. Only when the user explicitly asked in this conversation to commit or push, pass `git` ({commit:true} or {push:true, remote?, branch?}) to an implement, game-asset or video orche_task; explore, answer and verify reject it. The grant covers that assignment only, so scope the commit to the task's files where possible (pass `files` and name the paths in `request`) and check the commits listed in the result before reporting.",
    "Single workflow: refine the requirements with the user: goal, constraints and acceptance criteria. Inspect only what is needed to state the task precisely. Ask the user only about decisions you cannot reasonably make; without a UI, make a reasonable assumption and state it in the request and final report. Hand the whole task to ONE orche_task in ONE end-to-end assignment, even when it is large or risky: role implement for changes, answer for read-only questions. Do not split the task into explore/implement/verify phases, and never send an explore before an implement for the same request. Never stop to ask the user to switch modes in order to proceed, and never end a turn without attempting the requested change because of its size or risk. This workflow is the same with and without a UI.",
    ...(spawn ? [mode === "ultra" ? ULTRA_RULE : ORCHESTRATOR_RULE] : []),
    `Single hand-off: main analyses the user's intent, purpose and requirements. Write \`request\` as: Intent/Purpose; numbered requirements checklist R1..Rn as lines \`R1: …\`, each testable with acceptance criteria; Constraints and non-goals; Assumptions (explicit when there is no UI); and a final Original request section containing the user's ORIGINAL request text verbatim. Put relevant background and file/evidence references in \`context\`. One end-to-end assignment per round: implement for changes, answer for read-only questions. The worker analyses requirements, creates a Task DAG with task_plan and executes nodes sequentially without main intervention while it runs. ${modelSentence(options)} and compact above 50% context, preserving requirements, original request and the assignment's plan. Specialists keep their routes and do not receive task_plan or 50% compaction.`,
    ASYNC_RULE,
    "Reuse: problems and user follow-ups go to the SAME worker (pass its id in `worker`). Review the result, its evidence and checklist. Restate additional or corrected requirements in the same hand-off format with new R-ids or revised ones and repeat. When a requirement remains unmet or partial in 2 consecutive REPORTED results of that worker, hand ONLY the unmet items to a NEW worker (omit worker), with their requirements, relevant file references and the previous worker's evidence; do not resend the whole task. A timeout is not an unmet result and never counts towards that rule: continue a timed-out assignment with the SAME worker and task (pass both) and only the remaining work, as its result's Resume line says; the worker keeps its context while it is live, and the task ledger keeps its last recorded Task DAG checkpoint for whichever worker continues. When a result names a task ledger (`Task ledger T…`), pass that id in `task` for every follow-up of the same task, including the new worker that takes over unmet items; omit `task` for a different user task, even when you reuse the worker. Never claim a reuse that did not happen: unknown ids are errors, and a worker that is gone (idle expiry, eviction, reload) is continued by a NEW worker briefed from its transcript; the result names the new id, use it from then on.",
    mode === "ultra" ? ULTRA_SUPERVISION : spawn ? ORCHESTRATOR_SUPERVISION : SUPERVISION,
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
 * a one-shot `/orche <mode> <prompt>` override (for the run of that request only; with task ledgers its tasks keep the mode, see workers.ts RequestMode),
 * the mode chosen with `/orche mode` (persisted in the session), `mainMode` from the
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
