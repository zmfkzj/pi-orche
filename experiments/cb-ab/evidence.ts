/**
 * Model-free evidence of one cb-ab unit (results/cb-ab/PROTOCOL.md "Conditions" and "Records"), computed from the files a unit copied
 * out of its private agent dir: session transcripts and their roles, route fidelity on the wire, compliance with the B/C analysis
 * step, the tool-call audit, usage by role, the frozen final report, the target check and the redaction of credentials.
 * Pure functions over files; the unit (run.ts) writes their results.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { filesUnder, readJsonl, sha } from "../mdsd-ab/run.js";
import { CB_BRIEF, EXPLORER_NAME, GENERIC_BRIEF, MODEL, MODEL_REF, THINKING, type Arm } from "./protocol.js";

// ---- transcripts ----------------------------------------------------------------------------------------------------------------

export type Role = "main" | "orchestrator" | "explorer" | "sub-worker" | "other";
export const ROLES: readonly (Role | "unattributed")[] = ["main", "orchestrator", "explorer", "sub-worker", "other", "unattributed"];

export interface SpawnWorker { name: string; role: string; request: string }
export interface SpawnCall { session: string; agent: string; at?: string; toolCallId?: string; reason?: string; workers: SpawnWorker[]; result?: { isError: boolean; text: string } }
export interface ToolCall { id?: string; name: string; arguments: unknown; at?: string }
export interface Transcript {
  id: string; file: string; agent: string; entries: number;
  /** `provider/id` of every model_change entry, in order. */
  models: string[];
  /** Every thinking_level_change entry, in order. */
  thinking: string[];
  /** `provider/model` of every assistant message → count. */
  responseModels: Record<string, number>;
  first?: string; last?: string; lastText?: string;
  reports: { at?: string; arguments: unknown }[];
  spawns: SpawnCall[];
  toolCalls: ToolCall[];
  /** A sub-worker's own id and name, from its assignment ("You are sub-worker W1.2 ("name") ..."). */
  subWorker?: { id: string; name: string };
}

/** Worker transcripts are `<agent>-<ISO time>.jsonl` (W1, W1.2, W1.advisor); an id segment never contains a hyphen. */
const AGENT_FILE = /^(W\d+(?:\.[A-Za-z0-9_]+)*)-\d{4}-/;
const SUB_WORKER = /You are sub-worker (W\d+(?:\.\d+)+) \("([^"]*)"\)/;
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("") : "";

export function transcriptOf(file: string, entries: any[], mainSessionId: string): Transcript | undefined {
  const head = entries[0];
  if (head?.type !== "session" || typeof head.id !== "string") return undefined;
  const responseModels: Record<string, number> = {};
  const reports: Transcript["reports"] = [], spawns: SpawnCall[] = [], toolCalls: ToolCall[] = [];
  const results = new Map<string, { isError: boolean; text: string }>();
  let lastText: string | undefined, subWorker: Transcript["subWorker"], firstUser = true;
  const agentFromFile = AGENT_FILE.exec(basename(file))?.[1];
  for (const entry of entries) {
    const message = entry?.message;
    if (entry?.type !== "message" || !message) continue;
    if (message.role === "user" && firstUser) {
      firstUser = false;
      const match = SUB_WORKER.exec(textOf(message.content));
      if (match) subWorker = { id: match[1]!, name: match[2]! };
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") results.set(message.toolCallId, { isError: message.isError === true, text: textOf(message.content).slice(0, 600) });
    if (message.role !== "assistant") continue;
    const key = `${message.provider}/${message.model}`;
    responseModels[key] = (responseModels[key] ?? 0) + 1;
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) lastText = part.text;
      if (part?.type !== "toolCall") continue;
      const call: ToolCall = { ...(typeof part.id === "string" ? { id: part.id } : {}), name: String(part.name), arguments: part.arguments ?? {}, ...(entry.timestamp ? { at: entry.timestamp } : {}) };
      toolCalls.push(call);
      if (part.name === "report_result") reports.push({ at: entry.timestamp, arguments: part.arguments });
      if (part.name === "orche_spawn") {
        const args = part.arguments ?? {};
        spawns.push({
          session: head.id, agent: "", at: entry.timestamp, ...(call.id ? { toolCallId: call.id } : {}), ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
          workers: (Array.isArray(args.workers) ? args.workers : []).map((worker: any) => ({ name: String(worker?.name ?? ""), role: String(worker?.role ?? ""), request: typeof worker?.request === "string" ? worker.request : "" })),
        });
      }
    }
  }
  const agent = head.id === mainSessionId ? "main" : agentFromFile ?? subWorker?.id ?? "other";
  for (const spawn of spawns) { spawn.agent = agent; const result = spawn.toolCallId ? results.get(spawn.toolCallId) : undefined; if (result) spawn.result = result; }
  return {
    id: head.id, file, agent, entries: entries.length,
    models: entries.filter(entry => entry?.type === "model_change").map(entry => `${entry.provider}/${entry.modelId}`),
    thinking: entries.filter(entry => entry?.type === "thinking_level_change").map(entry => String(entry.thinkingLevel)),
    responseModels, first: head.timestamp, last: entries.at(-1)?.timestamp, ...(lastText ? { lastText } : {}), reports, spawns, toolCalls, ...(subWorker ? { subWorker } : {}),
  };
}

/**
 * Pi session transcripts below `roots` by session id (line 1). Main is the session the unit started (`--session-id`); a worker is
 * named by its transcript's file name (orche records: workers/W1-…, W1.2-…) or its sub-worker assignment; anything else is "other".
 * A session found twice keeps its longer transcript.
 */
export function sessionTranscripts(mainSessionId: string, ...roots: string[]): Map<string, Transcript> {
  const out = new Map<string, Transcript>();
  for (const root of roots) for (const file of filesUnder(root, /\.jsonl$/)) {
    if (["events.jsonl", "split-log.jsonl"].includes(basename(file))) continue;
    const transcript = transcriptOf(file, readJsonl(file), mainSessionId);
    if (!transcript) continue;
    const known = out.get(transcript.id);
    if (!known || known.entries < transcript.entries) out.set(transcript.id, transcript);
  }
  return out;
}

/** The ids of the explorer sub-workers of B/C: named EXPLORER_NAME[arm] in orche's spawn outcome or in their own assignment. */
export function explorerIds(arm: Arm, transcripts: Map<string, Transcript>, tasks: readonly { run: any }[]): Set<string> {
  if (arm === "A") return new Set();
  const name = EXPLORER_NAME[arm];
  const ids = new Set<string>();
  for (const task of tasks) for (const item of Array.isArray(task.run?.outcome?.spawned) ? task.run.outcome.spawned : []) if (item?.name === name && typeof item.id === "string") ids.add(item.id);
  for (const transcript of transcripts.values()) if (transcript.subWorker?.name === name) ids.add(transcript.subWorker.id);
  return ids;
}

export const roleOfAgent = (agent: string, explorers: ReadonlySet<string>): Role =>
  agent === "main" ? "main" : /^W\d+$/.test(agent) ? "orchestrator" : explorers.has(agent) ? "explorer" : /^W\d+\.\d+$/.test(agent) ? "sub-worker" : "other";

// ---- the frozen final report -------------------------------------------------------------------------------------------------

/**
 * The orche result the user got (experiments/mdsd-ab/quality.ts finalReport): the last report of the worker that ran the last
 * completed orche task. Main may retry a failed task with a new worker, so W1's last report is not necessarily the answer.
 */
export function finalReport(tasks: readonly { run: any }[], sessions: Map<string, { agent: string; reports: any[] }>): any {
  const time = (value: unknown) => new Date(value as string | number).getTime() || 0;
  const ordered = [...tasks].sort((a, b) => time(a.run.start) - time(b.run.start));
  const done = ordered.filter(item => item.run.status === "done" || item.run.outcome?.status === "completed");
  const worker = (done.at(-1) ?? ordered.at(-1))?.run.worker?.id ?? "W1";
  return [...sessions.values()].find(item => item.agent === worker)?.reports.at(-1) ?? null;
}

/** Main's final assistant text in Pi's JSON-mode event stream (the last non-empty text of an assistant message_end). */
export function finalText(events: readonly any[]): string {
  let text = "";
  for (const event of events) {
    const message = event?.message;
    if (event?.type !== "message_end" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const part = message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("");
    if (part.trim()) text = part;
  }
  return text;
}

/** The orche task records (`run.json` of kind task) with their status, worker, route and size. */
export function taskStatuses(tasks: readonly { file: string; run: any }[]): Record<string, unknown>[] {
  return tasks.map(({ file, run }) => ({
    file, worker: run.worker?.id, status: run.status, outcome: run.outcome?.status, mode: run.assignment?.mode, tier: run.assignment?.tier, model: run.assignment?.model, thinking: run.assignment?.thinking,
    requests: run.outcome?.requests, durationMs: run.outcome?.durationMs ?? run.durationMs, start: run.start,
    spawned: (Array.isArray(run.outcome?.spawned) ? run.outcome.spawned : []).map((item: any) => ({ id: item.id, name: item.name, role: item.role, reason: item.reason, status: item.status, requests: item.requests, costUSD: item.costUSD, model: item.model, thinking: item.thinking })),
    agents: (Array.isArray(run.agents) ? run.agents : []).map((item: any) => ({ id: item.id, role: item.role, kind: item.kind, model: item.model, thinking: item.thinking, status: item.status, requests: item.requests })),
  }));
}

// ---- route fidelity --------------------------------------------------------------------------------------------------------------

/** One logged request of proxy.mjs (experiments/mdsd-ab/proxy.mjs). */
export interface WireEntry {
  id?: number; at?: string; endAt?: string; method?: string; path?: string; model?: string; effort?: string; updateEfforts?: string[]; session?: string; status?: number;
  respModel?: string; finalModel?: string; usage?: { input: number; cached: number; cacheWrite?: number; output: number; reasoning: number }; costUSD?: number;
  providerError?: unknown; error?: string; unparsed?: number; parseError?: string; noFinalEvent?: boolean; [key: string]: unknown;
}
export type ViolationKind = "model" | "effort" | "update-effort" | "response-model" | "unverifiable" | "unattributed" | "unparsed-request"
  | "session-model" | "session-thinking" | "session-response-model" | "session-unverifiable";
export interface Violation { kind: ViolationKind; detail: string; wire?: number; session?: string; agent?: string; role?: Role | "unattributed" }

export const isModelRequest = (entry: WireEntry): boolean => entry.method === "POST" && !!entry.model;
export const successful = (entry: WireEntry): boolean => isModelRequest(entry) && entry.status === 200 && !!entry.usage;

/** The wire checks of one POST: request model and effort, every configuration_update effort, the response model (missing = unverifiable). */
export function requestViolations(entry: WireEntry): Violation[] {
  const out: Violation[] = [];
  const at = { ...(entry.id !== undefined ? { wire: entry.id } : {}), ...(entry.session ? { session: entry.session } : {}) };
  if (entry.method !== "POST") return out;
  if (!entry.model) return [{ kind: "unparsed-request", detail: `POST ${entry.path ?? "?"} without a readable model (${entry.parseError ?? "no model field"})`, ...at }];
  if (entry.model !== MODEL.id) out.push({ kind: "model", detail: `request model ${entry.model}`, ...at });
  if (entry.effort !== THINKING) out.push({ kind: "effort", detail: `request effort ${entry.effort ?? "none"}`, ...at });
  for (const effort of entry.updateEfforts ?? []) if (effort !== THINKING) out.push({ kind: "update-effort", detail: `configuration_update effort ${effort}`, ...at });
  const responded = [entry.respModel, entry.finalModel].filter((model): model is string => typeof model === "string" && model.length > 0);
  if (!responded.length) out.push({ kind: "unverifiable", detail: `no response model (HTTP ${entry.status ?? "none"}${entry.error ? `, ${String(entry.error).slice(0, 80)}` : ""}${entry.noFinalEvent ? ", no final event" : ""})`, ...at });
  for (const model of new Set(responded)) if (model !== MODEL.id) out.push({ kind: "response-model", detail: `response model ${model}`, ...at });
  return out;
}

export interface SessionRoute { id: string; agent: string; role: Role; file: string; models: string[]; thinking: string[]; responseModels: Record<string, number>; requests: number; violations: number }
export interface RouteReport { requests: number; posts: number; ok: boolean; violations: Violation[]; byKind: Record<string, number>; byRole: Record<string, { requests: number; violations: number }>; sessions: SessionRoute[] }

/**
 * Route fidelity of a run: every POST must be a gpt-6.1-sol/high request (no other configuration_update effort) answered by
 * gpt-6.1-sol and attributed by its prompt_cache_key to a session of the run; every session's transcript must stay on the route
 * (model_change, thinking_level_change, the model of every assistant message). Every violation is listed.
 */
export function routeFidelity(wire: readonly WireEntry[], transcripts: Map<string, Transcript>, explorers: ReadonlySet<string>, root = ""): RouteReport {
  const posts = wire.filter(entry => entry.method === "POST");
  const violations: Violation[] = [];
  const roleOf = (session?: string): Role | "unattributed" => { const transcript = session ? transcripts.get(session) : undefined; return transcript ? roleOfAgent(transcript.agent, explorers) : "unattributed"; };
  const byRole: RouteReport["byRole"] = {};
  const bump = (role: string, key: "requests" | "violations", n = 1) => { byRole[role] ??= { requests: 0, violations: 0 }; byRole[role]![key] += n; };
  for (const entry of posts) {
    const role = roleOf(entry.session);
    const transcript = entry.session ? transcripts.get(entry.session) : undefined;
    const found = requestViolations(entry).map(item => ({ ...item, role, ...(transcript ? { agent: transcript.agent } : {}) }));
    if (!transcript) found.push({ kind: "unattributed", detail: entry.session ? `prompt_cache_key ${entry.session} is no session of this run` : "no prompt_cache_key", ...(entry.id !== undefined ? { wire: entry.id } : {}), ...(entry.session ? { session: entry.session } : {}), role });
    bump(role, "requests"); if (found.length) bump(role, "violations", found.length);
    violations.push(...found);
  }
  const sessions: SessionRoute[] = [];
  for (const transcript of transcripts.values()) {
    const role = roleOfAgent(transcript.agent, explorers);
    const at = { session: transcript.id, agent: transcript.agent, role };
    const own: Violation[] = [];
    for (const model of new Set(transcript.models)) if (model !== MODEL_REF) own.push({ kind: "session-model", detail: `model_change to ${model}`, ...at });
    for (const level of new Set(transcript.thinking)) if (level !== THINKING) own.push({ kind: "session-thinking", detail: `thinking_level_change to ${level}`, ...at });
    for (const model of Object.keys(transcript.responseModels)) if (model !== MODEL_REF) own.push({ kind: "session-response-model", detail: `assistant message from ${model}`, ...at });
    if (!transcript.models.length) own.push({ kind: "session-unverifiable", detail: "no model_change entry", ...at });
    if (!transcript.thinking.length) own.push({ kind: "session-unverifiable", detail: "no thinking_level_change entry", ...at });
    violations.push(...own);
    if (own.length) bump(role, "violations", own.length);
    sessions.push({
      id: transcript.id, agent: transcript.agent, role, file: root && transcript.file.startsWith(`${root}/`) ? transcript.file.slice(root.length + 1) : transcript.file,
      models: [...new Set(transcript.models)], thinking: [...new Set(transcript.thinking)], responseModels: transcript.responseModels,
      requests: posts.filter(entry => entry.session === transcript.id).length, violations: own.length + violations.filter(item => item.session === transcript.id && item.wire !== undefined).length,
    });
  }
  sessions.sort((a, b) => (a.agent === "main" ? "" : a.agent).localeCompare(b.agent === "main" ? "" : b.agent, "en", { numeric: true }));
  const byKind: Record<string, number> = {};
  for (const item of violations) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  return { requests: posts.filter(isModelRequest).length, posts: posts.length, ok: violations.length === 0, violations, byKind, byRole, sessions };
}

// ---- compliance -----------------------------------------------------------------------------------------------------------------

export const briefOf = (arm: Exclude<Arm, "A">): string => arm === "B" ? CB_BRIEF : GENERIC_BRIEF;
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

export interface ExplorerCompliance {
  name: string;
  /** orche_spawn calls naming the explorer (refused calls included) and those orche accepted. */
  calls: number; accepted: number;
  reason?: string; role?: string; workersInCall?: number;
  requestChars?: number; requestSha256?: string;
  /** The request R starts with the arm's brief verbatim / contains the case prompt verbatim / is exactly brief + blank line + prompt. */
  briefVerbatim: boolean; promptVerbatim: boolean; exact: boolean;
  /** The same after collapsing whitespace (tells a whitespace-only difference from a rewrite). */
  briefNormalized: boolean; promptNormalized: boolean;
  /** Characters of R beyond brief + blank line + prompt (added text when > 0). */
  extraChars?: number;
  ids: string[]; status?: string; orcheRequests?: number; orcheCostUSD?: number; wireRequests: number; listCostUSD: number;
  ran: boolean; form: boolean; verbatim: boolean; compliant: boolean;
}
export interface Compliance { arm: Arm; spawns: { agent: string; at?: string; reason?: string; names: string[]; roles: string[]; ok: boolean; error?: string }[]; explorer?: ExplorerCompliance }

/**
 * The B/C analysis step as it happened: every orche_spawn call of the run (reason, names, roles, refused or not), and for B/C the
 * explorer's spawns, whether its request carries the brief and the case prompt verbatim, and what it did (status, requests, cost).
 */
export function compliance(arm: Arm, prompt: string, transcripts: Map<string, Transcript>, tasks: readonly { run: any }[], wire: readonly WireEntry[]): Compliance {
  const calls = [...transcripts.values()].flatMap(transcript => transcript.spawns).sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  const spawns = calls.map(call => ({ agent: call.agent, ...(call.at ? { at: call.at } : {}), ...(call.reason ? { reason: call.reason } : {}), names: call.workers.map(worker => worker.name), roles: call.workers.map(worker => worker.role), ok: !call.result?.isError, ...(call.result?.isError ? { error: call.result.text.slice(0, 300) } : {}) }));
  if (arm === "A") return { arm, spawns };
  const name = EXPLORER_NAME[arm], brief = briefOf(arm);
  const naming = calls.filter(call => call.workers.some(worker => worker.name === name));
  const accepted = naming.filter(call => !call.result?.isError);
  const call = accepted[0] ?? naming[0];
  const worker = call?.workers.find(item => item.name === name);
  const request = worker?.request ?? "";
  const ids = [...explorerIds(arm, transcripts, tasks)].sort();
  const spawned = tasks.flatMap(task => Array.isArray(task.run?.outcome?.spawned) ? task.run.outcome.spawned : []).filter((item: any) => item?.name === name);
  const agents = tasks.flatMap(task => Array.isArray(task.run?.agents) ? task.run.agents : []).filter((item: any) => ids.includes(item?.id));
  const sessions = new Set([...transcripts.values()].filter(transcript => ids.includes(transcript.agent)).map(transcript => transcript.id));
  const mine = wire.filter(entry => isModelRequest(entry) && entry.session !== undefined && sessions.has(entry.session));
  const briefVerbatim = !!worker && request.startsWith(brief), promptVerbatim = !!worker && request.includes(prompt);
  const ran = accepted.length === 1;
  const form = !!call && call.reason === "isolation" && worker?.role === "answer" && call.workers.length === 1;
  const sum = (items: any[], key: string) => items.length ? items.reduce((total, item) => total + (typeof item?.[key] === "number" ? item[key] : 0), 0) : undefined;
  const explorer: ExplorerCompliance = {
    name, calls: naming.length, accepted: accepted.length,
    ...(call?.reason ? { reason: call.reason } : {}), ...(worker ? { role: worker.role, workersInCall: call!.workers.length, requestChars: request.length, requestSha256: sha(request), extraChars: request.length - brief.length - 2 - prompt.length } : {}),
    briefVerbatim, promptVerbatim, exact: !!worker && request === `${brief}\n\n${prompt}`,
    briefNormalized: !!worker && squash(request).startsWith(squash(brief)), promptNormalized: !!worker && squash(request).includes(squash(prompt)),
    ids, ...(spawned.length ? { status: spawned.map((item: any) => String(item.status)).join(",") } : agents.length ? { status: agents.map((item: any) => String(item.status)).join(",") } : {}),
    ...(spawned.length ? { orcheRequests: sum(spawned, "requests"), orcheCostUSD: sum(spawned, "costUSD") } : agents.length ? { orcheRequests: sum(agents, "requests") } : {}),
    wireRequests: mine.length, listCostUSD: round6(mine.reduce((total, entry) => total + (entry.costUSD ?? 0), 0)),
    ran, form, verbatim: briefVerbatim && promptVerbatim, compliant: ran && form && briefVerbatim && promptVerbatim,
  };
  return { arm, spawns, explorer };
}

// ---- audit -------------------------------------------------------------------------------------------------------------------------

/** `exec`: the rule applies only to tools that run commands or fetch (a delegation request only mentions; a command acts). */
export interface AuditRule { id: string; pattern: RegExp; scope: "all" | "exec" }
export const AUDIT_RULES: readonly AuditRule[] = [
  { id: "repository", pattern: /oh-my-pi-extensions|\/orche\/(?:src|test|experiments|fixtures|results|docs)\b/, scope: "all" },
  { id: "results", pattern: /(?:^|[^\w.-])results\//, scope: "all" },
  { id: "fixtures", pattern: /\bfixtures\/(?:advisor-bench|suite)\b|advisor-bench|advisor-reviewer/, scope: "all" },
  { id: "hidden-or-reference", pattern: /\b(?:test|fix)\.patch\b|\b(?:hidden|reference)\/(?:test|fix)\b/, scope: "all" },
  { id: "agent-private", pattern: /\.pi\/agent\/(?:orche|sessions|git)\b/, scope: "all" },
  { id: "frozen-mounts", pattern: /orche-runtime|cliproxyapi-provider|\bcb-ab\b/, scope: "all" },
  { id: "network-command", pattern: /\b(?:curl|wget|ncat|telnet)\b|\bgit\s+(?:fetch|clone|pull|push|ls-remote|remote)\b|\bpip3?\s+(?:install|download)\b|\bnpm\s+(?:view|install|i|ci)\b|\buv\s+(?:pip|add|sync|run)\b/, scope: "exec" },
  { id: "network-url", pattern: /\bhttps?:\/\/(?!127\.0\.0\.1|localhost)/, scope: "exec" },
];
const EXEC_TOOL = /^(?:bash|shell|exec|sh|python)$|fetch|browser|web|http|url/i;
const NETWORK_TOOL = /fetch|browser|web_?search|http|url/i;

const maskValue = (value: unknown, masks: readonly string[]): unknown => typeof value === "string" ? masks.reduce((text, mask) => mask ? text.split(mask).join("<given text>") : text, value)
  : Array.isArray(value) ? value.map(item => maskValue(item, masks))
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item, masks)])) : value;

export interface AuditHit { agent: string; session: string; tool: string; rule: string; excerpt: string }
/**
 * Tool calls of every transcript of the run that touch forbidden material: this repository, results/, the bench fixtures, hidden
 * tests and reference fixes, orche's private records/sessions/packages, the frozen runtime/provider mounts, and network fetches.
 * The texts the run was given (the case prompt, the brief) are masked first, so quoting them is no hit.
 */
export function auditTranscripts(transcripts: Map<string, Transcript>, masks: readonly string[] = [], rules: readonly AuditRule[] = AUDIT_RULES): { calls: number; hits: AuditHit[]; byRule: Record<string, number>; clean: boolean } {
  let calls = 0;
  const hits: AuditHit[] = [];
  for (const transcript of transcripts.values()) for (const call of transcript.toolCalls) {
    calls++;
    const text = JSON.stringify(maskValue(call.arguments, masks)) ?? "";
    const where = { agent: transcript.agent, session: transcript.id, tool: call.name };
    if (NETWORK_TOOL.test(call.name)) hits.push({ ...where, rule: "network-tool", excerpt: text.slice(0, 240) });
    for (const rule of rules) {
      if (rule.scope === "exec" && !EXEC_TOOL.test(call.name)) continue;
      const match = rule.pattern.exec(text);
      if (match) hits.push({ ...where, rule: rule.id, excerpt: text.slice(Math.max(0, match.index - 100), match.index + 140) });
    }
  }
  const byRule: Record<string, number> = {};
  for (const hit of hits) byRule[hit.rule] = (byRule[hit.rule] ?? 0) + 1;
  return { calls, hits, byRule, clean: hits.length === 0 };
}

// ---- usage -------------------------------------------------------------------------------------------------------------------------

export interface Usage { requests: number; input: number; cached: number; cacheWrite: number; output: number; reasoning: number; costUSD: number; unknownUsage: number }
export const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
export function usageOf(entries: readonly WireEntry[]): Usage {
  const sum = (key: "input" | "cached" | "cacheWrite" | "output" | "reasoning") => entries.reduce((total, entry) => total + (entry.usage?.[key] ?? 0), 0);
  return { requests: entries.length, input: sum("input"), cached: sum("cached"), cacheWrite: sum("cacheWrite"), output: sum("output"), reasoning: sum("reasoning"), costUSD: round6(entries.reduce((total, entry) => total + (entry.costUSD ?? 0), 0)), unknownUsage: entries.filter(entry => !entry.usage || entry.costUSD === undefined).length };
}
/** Model requests by role of their session (main / orchestrator / explorer / other sub-workers / other / unattributed), list prices. */
export function usageByRole(wire: readonly WireEntry[], transcripts: Map<string, Transcript>, explorers: ReadonlySet<string>): Record<string, Usage> & { total: Usage } {
  const requests = wire.filter(isModelRequest);
  const roleOf = (entry: WireEntry) => { const transcript = entry.session ? transcripts.get(entry.session) : undefined; return transcript ? roleOfAgent(transcript.agent, explorers) : "unattributed"; };
  const out: Record<string, Usage> = {};
  for (const role of ROLES) { const mine = requests.filter(entry => roleOf(entry) === role); if (mine.length) out[role] = usageOf(mine); }
  return { ...out, total: usageOf(requests) };
}

/** Request statistics of the wire (experiments/mdsd-ab/matrix.ts wireStats). */
export function wireStats(entries: readonly WireEntry[]) {
  const countBy = <T>(items: readonly T[], key: (item: T) => string) => items.reduce((acc: Record<string, number>, item) => { const name = key(item); acc[name] = (acc[name] ?? 0) + 1; return acc; }, {});
  const starts = entries.map(entry => Date.parse(String(entry.at))), ends = entries.map(entry => Date.parse(String(entry.endAt ?? entry.at)));
  return {
    ...usageOf(entries), statuses: countBy(entries, entry => String(entry.status)), routes: countBy(entries, entry => `${entry.model}@${entry.effort}`),
    updateEfforts: countBy(entries.flatMap(entry => entry.updateEfforts ?? []), effort => String(effort)), respModels: countBy(entries, entry => String(entry.finalModel ?? entry.respModel ?? "?")),
    providerErrors: entries.filter(entry => entry.providerError || entry.error).map(entry => ({ id: entry.id, status: entry.status, ...(entry.providerError && typeof entry.providerError === "object" ? entry.providerError : {}), ...(entry.error ? { connection: entry.error } : {}) })),
    firstAt: entries.length ? new Date(Math.min(...starts)).toISOString() : undefined, lastEndAt: entries.length ? new Date(Math.max(...ends)).toISOString() : undefined,
    spanMs: entries.length ? Math.max(...ends) - Math.min(...starts) : 0,
  };
}

// ---- target ------------------------------------------------------------------------------------------------------------------------

/** File content hashes below `root` (experiments/mdsd-ab/matrix.ts contentHashes; `.git` and a node_modules mount point aside). */
export function contentHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), name = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && (entry.name === ".git" || entry.name === "node_modules")) continue;
      if (entry.isSymbolicLink()) out[name] = `symlink:${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path, name);
      else out[name] = entry.isFile() ? sha(readFileSync(path)) : "special";
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}
const CACHE = /(?:^|\/)(?:__pycache__|\.pytest_cache|\.hypothesis|\.mypy_cache|\.ruff_cache)(?:\/|$)/;
/** Before/after: changed, removed and added files; orche's `.orche/` tool-output spill and Python/pytest caches counted apart. */
export function targetCheck(before: Record<string, string>, after: Record<string, string>) {
  const changed = Object.keys(before).filter(name => name in after && after[name] !== before[name]);
  const removed = Object.keys(before).filter(name => !(name in after));
  const created = Object.keys(after).filter(name => !(name in before));
  const spill = created.filter(name => name.startsWith(".orche/"));
  const caches = created.filter(name => !name.startsWith(".orche/") && CACHE.test(name));
  const added = created.filter(name => !name.startsWith(".orche/") && !CACHE.test(name));
  return { files: Object.keys(before).length, changed, removed, added, spill: spill.length, caches, unchanged: !changed.length && !removed.length && !added.length };
}

// ---- redaction ---------------------------------------------------------------------------------------------------------------------

const replaceAll = (buffer: Buffer, from: Buffer, to: Buffer): Buffer => {
  const parts: Buffer[] = [];
  let start = 0, at: number;
  while ((at = buffer.indexOf(from, start)) !== -1) { parts.push(buffer.subarray(start, at), to); start = at + from.length; }
  parts.push(buffer.subarray(start));
  return Buffer.concat(parts);
};
/** Replace every secret (8+ characters) in every regular file below `root` by [REDACTED]; returns the rewritten files and any left. */
export function redactTree(root: string, secrets: readonly string[]): { files: string[]; remaining: string[] } {
  const list = [...new Set(secrets.filter(secret => secret.length >= 8))].map(secret => Buffer.from(secret));
  const files: string[] = [], remaining: string[] = [];
  if (!list.length) return { files, remaining };
  const mark = Buffer.from("[REDACTED]");
  for (const file of filesUnder(root, /./)) {
    let stat;
    try { stat = lstatSync(file); } catch { continue; }
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024) { if (stat.isFile()) remaining.push(`${file} (too large to check)`); continue; }
    const bytes = readFileSync(file);
    if (!list.some(secret => bytes.includes(secret))) continue;
    const clean = list.reduce<Buffer>((acc, secret) => replaceAll(acc, secret, mark), bytes);
    writeFileSync(file, clean);
    files.push(file);
    if (list.some(secret => readFileSync(file).includes(secret))) remaining.push(file);
  }
  return { files, remaining };
}
