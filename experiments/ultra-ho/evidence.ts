/**
 * Evidence of one ultra-ho run directory (written by run-one.ts): which recorded session each prompt_cache_key belongs to, and
 * per orche task (one orche_task call of main = one assignment) what main asked for, what came back and what the records show:
 * the assignment number, the worker, the task id main passed (if any), whether the ultra state was carried, the carried candidates,
 * the `Ultra:` result lines, the ultra gate events and adoptions (with the fresh check before each), and stages a report named that
 * the runtime record does not show.
 *
 * Layout read here: `sessions/**.jsonl` (main's Pi session dir), `main-artifacts/` (the workspace's .orche/artifacts: full texts of
 * spilled tool results), `records/<session>/<ts>_task-<id>/{run.json,events.jsonl}` and `records/<session>/workers/<agent>-<ts>.jsonl`
 * (orche's records: one stable transcript per worker and sub-worker).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { jsonlFiles, readJsonl } from "../ultra-ab/run-one.js";
import { parseUltraLine, roleOfAgent, unsupportedStageClaims, type SessionInfo, type UltraClaim, type UltraFacts } from "./protocol.js";

const CARRIED_TEXT = "continued from the previous assignment of this task";
const WORKER_FILE = /^(W\d+(?:\.\d+)*)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/;
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const textOf = (content: unknown): string => Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n") : typeof content === "string" ? content : "";
const ms = (value: unknown): number | undefined => typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) || undefined : undefined;
const iso = (value: unknown): string | undefined => { const at = ms(value); return at === undefined ? undefined : new Date(at).toISOString(); };

/** The header of a Pi session file (`{type: "session", id}`); only its first line is parsed. */
export function sessionHeader(file: string): { id: string; timestamp?: string } | undefined {
  try {
    const text = readFileSync(file, "utf8");
    const first = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
    const header = JSON.parse(first);
    return header?.type === "session" && typeof header.id === "string" ? { id: header.id, ...(header.timestamp ? { timestamp: header.timestamp } : {}) } : undefined;
  } catch { return undefined; }
}

/** The main session's file (the run's `--session-id`) in the copied session dir. */
export function mainSessionFile(runDir: string, mainSession: string): string | undefined {
  return jsonlFiles(join(runDir, "sessions")).find(file => sessionHeader(file)?.id === mainSession);
}

/**
 * prompt_cache_key (the Pi session id) → the session it belongs to: main (the run's own `--session-id`), the orche_task workers
 * (W<n>: orchestrators) and their sub-workers (W<n>.<m>) by their transcript in records/<session>/workers/, other recorded
 * sessions (an orche_run record's sessions/<agent>.jsonl, any other session in main's session dir) as "other".
 */
export function sessionMap(runDir: string, mainSession: string): Map<string, SessionInfo> {
  const map = new Map<string, SessionInfo>();
  const main = mainSessionFile(runDir, mainSession);
  map.set(mainSession, { role: "main", agent: "main", ...(main ? { file: relative(runDir, main) } : {}) });
  for (const file of jsonlFiles(join(runDir, "records"))) {
    const header = sessionHeader(file);
    if (!header || map.has(header.id)) continue;
    const name = basename(file);
    const worker = WORKER_FILE.exec(name)?.[1];
    if (worker && basename(dirname(file)) === "workers") map.set(header.id, { role: roleOfAgent(worker), agent: worker, file: relative(runDir, file) });
    else if (basename(dirname(file)) === "sessions") { const agent = name.replace(/\.jsonl$/, ""); map.set(header.id, { role: roleOfAgent(agent), agent, file: relative(runDir, file) }); }
  }
  for (const file of jsonlFiles(join(runDir, "sessions"))) {
    const header = sessionHeader(file);
    if (header && !map.has(header.id)) map.set(header.id, { role: "other", agent: `session:${header.id}`, file: relative(runDir, file) });
  }
  return map;
}

// ---------------------------------------------------------------------------------------------------------------------------
// main's orche_task calls

export interface OrcheCall {
  /** 1-based, in the order main made them. */
  index: number;
  id: string;
  at?: string;
  arguments: Record<string, unknown>;
  result?: { at?: string; isError: boolean; text: string; fullText: string; spilled?: string; details: Record<string, any> };
}

/** main's orche_task calls and their results; a result spilled by orche (`.orche/artifacts/…`) is read in full from `artifactsDir`. */
export function orcheCalls(mainFile: string | undefined, artifactsDir: string): OrcheCall[] {
  if (!mainFile) return [];
  const calls: OrcheCall[] = [];
  const byId = new Map<string, OrcheCall>();
  for (const entry of readJsonl<any>(mainFile)) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall" || part.name !== "orche_task") continue;
        const call: OrcheCall = { index: calls.length + 1, id: String(part.id), ...(entry.timestamp ? { at: entry.timestamp } : {}), arguments: part.arguments && typeof part.arguments === "object" ? part.arguments : {} };
        calls.push(call); byId.set(call.id, call);
      }
    } else if (message.role === "toolResult" && message.toolName === "orche_task") {
      const call = byId.get(String(message.toolCallId));
      if (!call) continue;
      const text = textOf(message.content);
      const spilled = /Full output saved to (\.orche\/artifacts\/[^\s;\]]+)/.exec(text)?.[1];
      const artifact = spilled ? join(artifactsDir, basename(spilled)) : undefined;
      const fullText = artifact && existsSync(artifact) ? readFileSync(artifact, "utf8") : text;
      call.result = { ...(entry.timestamp ? { at: entry.timestamp } : {}), isError: message.isError === true, text, fullText, ...(spilled ? { spilled } : {}), details: message.details && typeof message.details === "object" ? message.details : {} };
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Records

export interface TaskRecord { dir: string; base: string; run: any; events: any[] }

/** Every orche_task record (run.json kind task) of the run, in start order, with its events. */
export function taskRecordIndex(runDir: string): TaskRecord[] {
  const out: TaskRecord[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (entry.name !== "run.json") continue;
      try {
        const run = JSON.parse(readFileSync(path, "utf8"));
        if (run?.kind === "task") out.push({ dir: relative(runDir, dir), base: basename(dir), run, events: readJsonl<any>(join(dir, "events.jsonl")) });
      } catch { /* partial */ }
    }
  };
  if (existsSync(join(runDir, "records"))) walk(join(runDir, "records"));
  return out.sort((a, b) => (Date.parse(a.run.start ?? "") || 0) - (Date.parse(b.run.start ?? "") || 0));
}

interface Call { id: string; name: string; arguments: any; at?: number; result?: { isError: boolean; text: string; at?: number } }
const refOf = (call: Call): string | undefined => call.result ? /\[orche ref (T\d+)/.exec(call.result.text)?.[1] : undefined;

/** Tool calls of a worker transcript (one file across all its assignments), with their results. */
function transcriptCalls(file: string): Call[] {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  for (const entry of readJsonl<any>(file)) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (!message) continue;
    const at = ms(entry.timestamp) ?? ms(message.timestamp);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) if (part?.type === "toolCall") { const call: Call = { id: String(part.id), name: String(part.name), arguments: part.arguments ?? {}, ...(at !== undefined ? { at } : {}) }; calls.push(call); byId.set(call.id, call); }
    } else if (message.role === "toolResult") {
      const call = byId.get(String(message.toolCallId));
      if (call) call.result = { isError: message.isError === true, text: textOf(message.content), ...(at !== undefined ? { at } : {}) };
    }
  }
  return calls;
}

/** Worker transcripts by agent id (W1, W1.3, …). */
export function workerTranscripts(runDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of jsonlFiles(join(runDir, "records"))) {
    const agent = WORKER_FILE.exec(basename(file))?.[1];
    if (agent && basename(dirname(file)) === "workers" && !out.has(agent)) out.set(agent, file);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Assignments

export interface Adoption {
  candidate: string; files: string[]; at?: string; fingerprint?: string;
  /** The last successful check (bash in the candidate's copy) of this assignment before the adoption: what the adoption rested on. */
  check?: { ref?: string; command: string; at?: string };
  /** Checks of this candidate's copy in this assignment before the adoption (failed ones included). */
  checksBefore: number;
}
/** An adoption made in an earlier assignment of the task and carried into this one, with this assignment's own successful checks of its copy (refs restart per assignment, so only these can count here). */
export interface CarriedAdoption { candidate: string; freshChecks: { ref?: string; command: string; at?: string }[] }
/** A ref a report cites, resolved against this assignment's own calls; `target`: the candidate whose copy a bash command names, else "workspace". */
export interface ResolvedRef { ref: string; tool?: string; isError?: boolean; at?: string; command?: string; target?: string }
/** The report the assignment ended with and what its cited refs are. */
export interface FinalReport {
  at?: string; status?: string; stage?: string; accepted?: boolean;
  selection?: { chosen: string; evidence: ResolvedRef[] };
  candidates: { id: string; verdict?: string; evidence: ResolvedRef[] }[];
  review: { finding: string; status?: string; evidence: ResolvedRef[] }[];
  integration: ResolvedRef[];
}
export interface Report { at?: string; status?: string; stage?: string; accepted?: boolean; ultra?: UltraClaim }
export interface AssignmentEvidence {
  /** 1-based order of main's orche_task calls. */
  index: number;
  /** When main made the call. */
  at?: string;
  /** What main passed (`files`: the assignment's write scope, when given). */
  requested: { role?: string; worker?: string; task?: string; files?: string[] };
  passedTask: boolean;
  worker?: string;
  /** Task ledger id and its assignment number ("Task ledger T1, assignment 2"). */
  task?: string;
  assignment?: number;
  status?: string;
  isError: boolean;
  failure?: unknown;
  record?: string;
  recordStatus?: string;
  /** The runtime carried the ultra state (details.ultra.carried) / the Ultra line says so. */
  carried: boolean;
  carriedLine: boolean;
  /** Candidates of the previous assignment of the same task (and worker) present in this one, when carried. */
  carriedCandidates: string[];
  ultraLines: string[];
  resumeLines: string[];
  /** details.ultra: the run summary (stage, rounds, candidates, adoptions, verification rounds, gate, carried). */
  ultra?: any;
  facts?: UltraFacts;
  gate: { result?: string; events: { at?: string; passed?: boolean; rejected?: string; evaluated?: unknown; excluded?: unknown }[] };
  ultraEvents: { at?: string; stage?: string; detail: string }[];
  adoptions: Adoption[];
  carriedAdoptions: CarriedAdoption[];
  finalReport?: FinalReport;
  reports: Report[];
  /** Stages named without the runtime record showing them: by the assignment's last report, and by its Ultra line. */
  stageClaims: { report: string[]; line: string[] };
}

const factsOf = (ultra: any): UltraFacts | undefined => ultra && typeof ultra === "object" ? {
  explorationRounds: Number(ultra.explorationRounds ?? 0), candidateRounds: Number(ultra.candidateRounds ?? 0),
  candidates: Array.isArray(ultra.candidates) ? ultra.candidates.map((item: any) => String(item?.id)) : [],
  adoptions: Array.isArray(ultra.adoptions) ? ultra.adoptions.map(String) : [], verificationRounds: Number(ultra.verificationRounds ?? 0),
  ...(typeof ultra.gate === "string" ? { gate: ultra.gate } : {}),
} : undefined;

/** A compact line per ultra event (the records keep the full event). */
function eventDetail(event: any): string {
  const { type: _type, timestamp: _timestamp, worker: _worker, stage: _stage, ...rest } = event ?? {};
  return clip(JSON.stringify(rest), 600);
}

/** Every orche task of the run (one per orche_task call of main), with the evidence described at the top of this file. */
export function assignments(runDir: string, mainSession: string): AssignmentEvidence[] {
  const calls = orcheCalls(mainSessionFile(runDir, mainSession), join(runDir, "main-artifacts"));
  const records = taskRecordIndex(runDir);
  const transcripts = workerTranscripts(runDir);
  const transcriptCache = new Map<string, Call[]>();
  const callsOf = (agent: string | undefined): Call[] => {
    if (!agent) return [];
    if (!transcriptCache.has(agent)) transcriptCache.set(agent, transcripts.has(agent) ? transcriptCalls(transcripts.get(agent)!) : []);
    return transcriptCache.get(agent)!;
  };
  // Candidate copies by id, from every record (a carried candidate's copy was made in an earlier assignment) and main's details.
  const workspaces = new Map<string, string>();
  for (const record of records) for (const event of record.events) if (event?.type === "ultra" && event.stage === "candidates" && Array.isArray(event.workers)) for (const worker of event.workers) if (worker?.id && worker.workspace) workspaces.set(String(worker.id), String(worker.workspace));
  for (const call of calls) for (const item of call.result?.details?.spawned ?? []) if (item?.id && item.workspace && !workspaces.has(item.id)) workspaces.set(String(item.id), String(item.workspace));

  const out: AssignmentEvidence[] = [];
  for (const call of calls) {
    const details = call.result?.details ?? {};
    const text = call.result?.fullText ?? "";
    const lines = text.split("\n");
    const ledger = /Task ledger (T\d+), assignment (\d+)/.exec(text);
    const record = typeof details.record === "string" ? records.find(item => item.base === basename(details.record)) : undefined;
    const worker = typeof details.worker === "string" ? details.worker : undefined;
    const task = typeof details.task === "string" ? details.task : ledger?.[1];
    const ultraLines = lines.filter(line => /^Ultra[ :]/.test(line));
    const ultra = details.ultra;
    const facts = factsOf(ultra);
    const carried = ultra?.carried === true;
    const carriedLine = ultraLines.some(line => line.startsWith("Ultra:") && line.includes(CARRIED_TEXT));
    const previous = [...out].reverse().find(item => item.task !== undefined && item.task === task && item.worker === worker);
    const carriedCandidates = carried && previous?.facts && facts ? previous.facts.candidates.filter(id => facts.candidates.includes(id)) : [];
    const ultraEvents = (record?.events ?? []).filter(event => event?.type === "ultra");
    const start = ms(record?.run?.start) ?? ms(call.at) ?? 0;
    const end = ms(record?.run?.end) ?? ms(call.result?.at) ?? Number.POSITIVE_INFINITY;
    const own = callsOf(worker).filter(item => item.at !== undefined && item.at >= start && item.at <= end);
    const adoptions = ultraEvents.filter(event => event.stage === "selection" && event.adopted).map((event): Adoption => {
      const candidate = String(event.adopted);
      const at = ms(event.timestamp);
      const adopt = own.filter(item => item.name === "orche_adopt" && item.arguments?.candidate === candidate && (at === undefined || (item.at ?? 0) <= at)).at(-1);
      const copy = workspaces.get(candidate);
      const before = own.filter(item => item.name === "bash" && copy && String(item.arguments?.command ?? "").includes(copy) && (item.at ?? 0) <= (adopt?.at ?? at ?? end));
      const passed = before.filter(item => item.result && !item.result.isError).at(-1);
      return {
        candidate, files: Array.isArray(event.files) ? event.files.map(String) : [], ...(at !== undefined ? { at: new Date(at).toISOString() } : {}), ...(event.fingerprint ? { fingerprint: String(event.fingerprint) } : {}),
        ...(passed ? { check: { ...(/\[orche ref (T\d+)/.exec(passed.result!.text)?.[1] ? { ref: /\[orche ref (T\d+)/.exec(passed.result!.text)![1] } : {}), command: clip(String(passed.arguments?.command ?? ""), 400), ...(passed.at !== undefined ? { at: new Date(passed.at).toISOString() } : {}) } } : {}),
        checksBefore: before.length,
      };
    });
    const reports: Report[] = own.filter(item => item.name === "report_result").map(item => {
      const data = item.arguments?.data && typeof item.arguments.data === "object" ? item.arguments.data : {};
      return { ...(item.at !== undefined ? { at: new Date(item.at).toISOString() } : {}), ...(typeof data.status === "string" ? { status: data.status } : {}), ...(typeof data.ultra?.stage === "string" ? { stage: data.ultra.stage } : {}), ...(item.result ? { accepted: !item.result.isError } : {}), ...(data.ultra && typeof data.ultra === "object" ? { ultra: data.ultra as UltraClaim } : {}) };
    });
    // The report the assignment ended with: the last one that was not rejected (an accepted report may end the session before its result is stored).
    const final = [...reports].reverse().find(report => report.accepted !== false);
    const line = ultraLines.find(item => item.startsWith("Ultra:"));
    const parsed = line ? parseUltraLine(line) : undefined;
    // Refs restart with every assignment: a cited [orche ref Tn] means this assignment's call Tn.
    const byRef = new Map(own.flatMap(item => { const ref = refOf(item); return ref ? [[ref, item] as const] : []; }));
    const targetOf = (command: string): string => [...workspaces].filter(([, path]) => command.includes(path)).sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? "workspace";
    const resolve = (items: unknown): ResolvedRef[] => [...new Set((Array.isArray(items) ? items : []).flatMap(item => [...String(item).matchAll(/\bT(\d{1,5})\b/g)].map(match => `T${Number(match[1])}`)))].map(ref => {
      const item = byRef.get(ref);
      if (!item) return { ref };
      const command = item.name === "bash" ? String(item.arguments?.command ?? "") : undefined;
      return { ref, tool: item.name, ...(item.result ? { isError: item.result.isError } : {}), ...(item.at !== undefined ? { at: new Date(item.at).toISOString() } : {}), ...(command !== undefined ? { command: clip(command, 300), target: targetOf(command) } : {}) };
    });
    const claim: any = final?.ultra;
    const finalReport: FinalReport | undefined = final ? {
      ...(final.at ? { at: final.at } : {}), ...(final.status ? { status: final.status } : {}), ...(final.stage ? { stage: final.stage } : {}), ...(final.accepted !== undefined ? { accepted: final.accepted } : {}),
      ...(claim?.selection?.chosen ? { selection: { chosen: String(claim.selection.chosen), evidence: resolve(claim.selection.evidence) } } : {}),
      candidates: (Array.isArray(claim?.candidates) ? claim.candidates : []).map((item: any) => ({ id: String(item?.id), ...(item?.verdict ? { verdict: String(item.verdict) } : {}), evidence: resolve(item?.evidence) })),
      review: (Array.isArray(claim?.review) ? claim.review : []).map((item: any) => ({ finding: clip(String(item?.finding ?? ""), 300), ...(item?.status ? { status: String(item.status) } : {}), evidence: resolve(item?.evidence) })),
      integration: resolve(claim?.integration?.evidence),
    } : undefined;
    const adoptedHere = new Set(adoptions.map(adoption => adoption.candidate));
    const carriedAdoptions: CarriedAdoption[] = carried && facts ? facts.adoptions.filter(candidate => !adoptedHere.has(candidate)).map(candidate => {
      const copy = workspaces.get(candidate);
      const fresh = own.filter(item => item.name === "bash" && !!copy && String(item.arguments?.command ?? "").includes(copy) && item.result && !item.result.isError);
      return { candidate, freshChecks: fresh.map(item => ({ ...(refOf(item) ? { ref: refOf(item)! } : {}), command: clip(String(item.arguments?.command ?? ""), 300), ...(item.at !== undefined ? { at: new Date(item.at).toISOString() } : {}) })) };
    }) : [];
    out.push({
      index: call.index, ...(call.at ? { at: call.at } : {}),
      requested: { ...(typeof call.arguments.role === "string" ? { role: call.arguments.role } : {}), ...(typeof call.arguments.worker === "string" ? { worker: call.arguments.worker } : {}), ...(typeof call.arguments.task === "string" ? { task: call.arguments.task } : {}), ...(Array.isArray(call.arguments.files) ? { files: call.arguments.files.map(String) } : {}) },
      passedTask: typeof call.arguments.task === "string",
      ...(worker ? { worker } : {}), ...(task ? { task } : {}), ...(ledger ? { assignment: Number(ledger[2]) } : {}),
      ...(typeof details.status === "string" ? { status: details.status } : details.failure?.status ? { status: String(details.failure.status) } : {}),
      isError: call.result?.isError ?? false, ...(details.failure ? { failure: details.failure } : {}),
      ...(record ? { record: record.dir, recordStatus: record.run.outcome?.status ?? record.run.status } : {}),
      carried, carriedLine, carriedCandidates, ultraLines,
      resumeLines: lines.filter(item => /^(Resume|Checkpoint at the timeout):/.test(item)),
      ...(ultra ? { ultra } : {}), ...(facts ? { facts } : {}),
      gate: { ...(typeof ultra?.gate === "string" ? { result: ultra.gate } : {}), events: ultraEvents.filter(event => event.stage === "gate").map(event => ({ ...(iso(event.timestamp) ? { at: iso(event.timestamp) } : {}), ...(event.passed ? { passed: true, evaluated: event.evaluated, excluded: event.excluded } : {}), ...(event.rejected ? { rejected: clip(String(event.rejected), 2000) } : {}) })) },
      ultraEvents: ultraEvents.map(event => ({ ...(iso(event.timestamp) ? { at: iso(event.timestamp) } : {}), ...(event.stage ? { stage: String(event.stage) } : {}), detail: eventDetail(event) })),
      adoptions, carriedAdoptions, ...(finalReport ? { finalReport } : {}), reports: reports.map(({ ultra: _ultra, ...rest }) => rest),
      stageClaims: { report: facts && final ? unsupportedStageClaims(final.ultra ?? { ...(final.stage ? { stage: final.stage } : {}) }, facts) : [], line: facts && parsed?.stage ? unsupportedStageClaims({ stage: parsed.stage }, facts) : [] },
    });
  }
  return out;
}

/** One line per assignment for summaries: `#2 W1 T1 a2 task✓ carried(W1.3,W1.4) done gate passed adopt W1.3 after T4`. */
export function assignmentLine(item: AssignmentEvidence): string {
  const parts = [`#${item.index}`, item.worker ?? "?", item.task ? `${item.task}${item.assignment ? `/a${item.assignment}` : ""}` : "no-task",
    item.passedTask ? `task passed (${item.requested.task})` : "task not passed",
    item.carried ? `carried${item.carriedCandidates.length ? ` [${item.carriedCandidates.join(",")}]` : ""}${item.carriedLine ? "" : " (line missing)"}` : item.carriedLine ? "carried line only" : "fresh",
    item.status ?? "?", `gate ${item.gate.result ?? "not reached"}`,
    ...item.adoptions.map(adoption => `adopted ${adoption.candidate}${adoption.check ? ` after ${adoption.check.ref ?? "a check"}` : " (no prior check found)"}`),
    ...item.carriedAdoptions.map(adoption => `carried adoption ${adoption.candidate}${adoption.freshChecks.length ? ` re-checked by ${adoption.freshChecks.map(check => check.ref ?? "?").join(",")}` : " (no fresh check)"}`),
    ...(item.stageClaims.report.length || item.stageClaims.line.length ? [`UNSUPPORTED: ${[...item.stageClaims.report, ...item.stageClaims.line].join("; ")}`] : [])];
  return parts.join(" · ");
}
