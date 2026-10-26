/**
 * The analyst → candidate hand-off chain of finished ultra units (results/ultra-ho/stage3-r2/PREREGISTRATION.md, Measures, with
 * amendment H2-A1; round 1: results/ultra-ho/stage3/PREREGISTRATION.md), model-free and from raw records only, computed identically
 * for every arm and runtime:
 *
 *  1. Reported: the analysts are the role-answer workers of the orchestrators' exploration orche_spawn calls (their transcripts
 *     under records/) that finished (status done); their FULL reports are the outcome in the tool result details, else the
 *     analyst's own last accepted report_result in its transcript, the clipped formatted tool text only when neither exists.
 *     A reported location (`reportLocations`): the intervention runtime's rule (src/orchestrator/ultra.ts captureHandoff) applied to
 *     the task's initial snapshot (`unitTask(meta).source`) instead of the live workspace: path-like tokens of the summary
 *     and of the data's JSON text (escapes and structure as separators), trailing dots dropped, `./` and `..` resolved, an absolute
 *     path under the workspace made relative, an optional `:line`, `:a-b` or comma list after it; a regular file of the snapshot
 *     (a link never, nor a real path outside it), not under .git, .orche, node_modules, .venv or venv, not in the protected basis
 *     (what the exploration's implement builders changed, as the ultra events and Ultra lines report it, a path under one included).
 *     A finding is a reported location of one exploration round of one orchestrator (the runtime's key: round and path), with the
 *     analysts that reported it, their line references and excerpts.
 *  2. Decisive: findings whose file the reference fix changes in non-test, non-doc source. The gold is read here only, never at
 *     runtime, under the unit's own fixture root (meta.fixtureRoot, meta.sweCacheSource; units without them: the canonical roots).
 *  3. Hand-off, per finding, over the candidates orche_spawn calls its orchestrator made after the exploration call that reported it,
 *     by H2's test (ultra.ts handoffDecision) on each call's arguments, in every arm alike: assigned (one implement candidate owns the
 *     path through its files, canonicalized like ownership, and names it in its request, relative or absolute under the workspace;
 *     an answer candidate: names it), reference (the call's `reference` entry, the path named in a request), excluded (its `excluded`
 *     entry), out of scope (outside main's `files` of that assignment, or so recorded by the runtime), mention-only (named, but by no
 *     candidate that owns it), owned-only (owned, named by none), else dropped. The class is the best over the accepted calls, in that
 *     order; the first proposal (accepted or refused) and the first accepted call are kept apart, with every hand-off refusal that
 *     named the finding and whether the next accepted call assigned it. Gate attribution: a refusal named it, the next accepted call
 *     assigned it, and no proposal before that call (after the report) had assigned it. Accepted means a successful result, or no
 *     result (the session ended while the call ran) with the runtime's candidates prepare event listing its workers; a call without a
 *     result and without that event is a proposal only. A `reference`/`excluded` entry's `grounded` is what the call declares (a
 *     reason and a cited [orche ref Tn]); whether the cited check really is a later own check naming the file is the runtime's test
 *     (H2 accepts the call only then; its disposition is kept under `runtime`), not re-verified here.
 *  4. Implementation: whether final.diff touches each decisive finding's file and each reference-fix source file.
 *  5. Correctness and process: grade.json (fail-to-pass and pass-to-pass with failure counts; suite tasks: hidden and visible
 *     tests), integrity violations, terminal status, primary pass, requests, USD, wall (meta.json), orche assignments and carry
 *     (re-derived from main's session and the records by evidence.ts; tasks.json when that fails).
 * The runtime's own hand-off record (captured findings, dispositions, refusals; H2 and round 1) is kept beside it as a cross-check.
 *
 * Layouts: ultra-ho units (meta.arm) and the older ultra-ab units of the same records family (meta.condition, no USD).
 *
 *   node --import tsx experiments/ultra-ho/chain.ts <out dir> [--dest <dir>]
 *     → <dest>/runs/<unit>/chain.json, <dest>/chain.json and <dest>/chain.md (dest: the out dir itself by default). It never writes
 *       into results/ultra-ho/stage3/ (round 1's outputs stay as they are): re-analyse those units with --dest elsewhere.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTask } from "../ultra-ab/env.js";
import { isTestFile } from "../ultra-ab/protocol.js";
import { jsonlFiles, readJsonl } from "../ultra-ab/run-one.js";
import { resolveOut } from "./driver.js";
import { DEFAULT_SWE_CACHE_SOURCE, REPO, isInside } from "./env.js";
import { assignments, taskRecordIndex } from "./evidence.js";

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
const ms = (value: unknown): number | undefined => typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) || undefined : undefined;
const iso = (value: number | undefined): string | undefined => value === undefined ? undefined : new Date(value).toISOString();
const textOf = (content: unknown): string => Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n") : typeof content === "string" ? content : "";
const isString = (value: unknown): value is string => typeof value === "string" && value !== "";

// ---------------------------------------------------------------------------------------------------------------------------
// The extraction rule: the runtime's (src/orchestrator/ultra.ts captureHandoff, pathMentions, workspacePath, excerptAround),
// applied to the task's initial snapshot instead of the live workspace.

/** Directories whose files are never analyst locations (the runtime's NOT_LOCATIONS: version control, orche's files, dependency dirs). */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([".git", ".orche", "node_modules", ".venv", "venv"]);
/** How much of one report text is scanned (the runtime's MAX_REPORT_SCAN). */
const MAX_REPORT_SCAN = 200_000;

/** The task's initial snapshot: its regular files (lstat, so a link is none, and the real path inside the snapshot), cached. */
export interface Snapshot { root: string; isFile(path: string): boolean }
export function snapshotOf(root: string): Snapshot {
  const files = new Map<string, boolean>();
  let real: string | undefined;
  const isFile = (path: string): boolean => {
    let value = files.get(path);
    if (value === undefined) {
      try {
        real ??= realpathSync(root);
        const inside = lstatSync(join(root, path)).isFile() ? relative(real, realpathSync(join(root, path))) : "";
        value = !!inside && !isAbsolute(inside) && inside.split(sep)[0] !== "..";
      } catch { value = false; }
      files.set(path, value);
    }
    return value;
  };
  return { root, isFile };
}

/**
 * A path-like token → workspace-relative (the runtime's workspacePath, lexically): trailing dots dropped, `./` and `..` resolved, an
 * absolute path under one of the workspaces made relative; undefined when it is empty or outside (another absolute path, or `..` out).
 */
export function relativePath(raw: string, workspaces: readonly string[]): string | undefined {
  const token = raw.replace(/\.+$/, "");
  if (!token) return undefined;
  let path = posix.normalize(token);
  if (path.startsWith("/")) {
    const root = workspaces.map(item => posix.normalize(item).replace(/\/+$/, "")).filter(item => item && path.startsWith(`${item}/`)).sort((a, b) => b.length - a.length)[0];
    if (!root) return undefined;
    path = path.slice(root.length + 1);
  }
  path = path.replace(/\/+$/, "");
  return !path || path === "." || path === ".." || path.startsWith("../") ? undefined : path;
}

/** Path-like tokens (ASCII path characters only) and the line reference right after one: `:12`, `:12-30` (en/em dash too), comma lists. */
const PATH_TOKEN = /[A-Za-z0-9_@+~./-]+/g;
const LINE_REF = /^:(\d+(?:[-–—]\d+)?(?:,\d+(?:[-–—]\d+)?)*)/;
const LINE_SUFFIX = /:\d+(?:[-–—]\d+)?(?:,\d+(?:[-–—]\d+)?)*$/;

export interface Mention { path: string; at: number; end: number; lines?: string }
/** Every path a text names, workspace-relative (existence is not checked here), with its line reference (dashes as `-`). */
export function pathMentions(text: string, workspaces: readonly string[]): Mention[] {
  const out: Mention[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[0].replace(/\.+$/, "");
    const path = token ? relativePath(token, workspaces) : undefined;
    if (!path) continue;
    const at = match.index ?? 0, end = at + token.length;
    const lines = LINE_REF.exec(text.slice(end, end + 80))?.[1]?.replace(/[–—]/g, "-");
    out.push({ path, at, end, ...(lines ? { lines } : {}) });
  }
  return out;
}

/** The text around a mention as the runtime records it: its line from at most 80 characters before it, at most 200 characters. */
function excerptAround(text: string, at: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const next = text.indexOf("\n", end);
  const from = Math.max(lineStart, at - 80);
  const body = text.slice(from, Math.min(next < 0 ? text.length : next, from + 400)).replace(/\s+/g, " ").trim();
  return clip(`${from > lineStart ? "…" : ""}${body}`, 200);
}
/** The protected basis covers a path at or under one of its entries (the runtime's `under`). */
const inBasis = (path: string, basis: readonly string[]): boolean => basis.some(owned => path === owned || path.startsWith(`${owned.replace(/\/$/, "")}/`));

/** The texts of a report the runtime scans: its summary, and its data as JSON with escapes and structure turned into separators. */
export const reportTexts = (report: { summary?: unknown; data?: unknown }): string[] => [
  typeof report.summary === "string" ? report.summary : "",
  report.data === undefined ? "" : (JSON.stringify(report.data) ?? "").replace(/\\(?:u[0-9a-fA-F]{4}|.)/g, " ").replace(/["{}[\]]/g, " "),
].map(text => text.slice(0, MAX_REPORT_SCAN));

export interface ReportedLocation { path: string; lines: string[]; excerpt: string }
/** The locations of one full report: regular files of the snapshot, outside the ignored directories and the protected basis. */
export function reportLocations(report: { summary?: unknown; data?: unknown }, options: { snapshot: Snapshot; workspaces: readonly string[]; basis?: readonly string[] }): ReportedLocation[] {
  const found = new Map<string, ReportedLocation>();
  for (const text of reportTexts(report)) {
    for (const mention of pathMentions(text, options.workspaces)) {
      if (mention.path.split("/").some(part => IGNORED_DIRS.has(part)) || inBasis(mention.path, options.basis ?? []) || !options.snapshot.isFile(mention.path)) continue;
      let item = found.get(mention.path);
      if (!item) found.set(mention.path, item = { path: mention.path, lines: [], excerpt: excerptAround(text, mention.at, mention.end) });
      for (const lines of mention.lines?.split(",") ?? []) if (!item.lines.includes(lines)) item.lines.push(lines);
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------------------------------------------------------
// Hand-off: H2's test (ultra.ts handoffDecision) on every candidates call, in every arm

/**
 * An owned path as the runtime canonicalizes it (spawn.ts scopePaths, backlog.ts normalizeOwnedPath): `dir/**` and `dir/**\/*` → `dir/`,
 * `./` the whole workspace ("/"); absolute, glob and outside paths own nothing (the runtime refuses them).
 */
export function canonicalScope(file: string): string | undefined {
  const raw = file.replaceAll("\\", "/").replace(/\/\*\*(?:\/\*)?$/, "/");
  if (raw === "./") return "/";
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop(); else parts.push(part);
  }
  const path = parts.join("/") + (raw.endsWith("/") && parts.length ? "/" : "");
  return !path || /[*?[\]{}]/.test(path) || isAbsolute(file) || /^[A-Za-z]:/.test(file) || path.split("/")[0] === ".." ? undefined : path;
}
/** ownership.ts ownsPath: a directory scope (`dir/`) covers its files, any other scope only itself; "/" the whole workspace. */
export function scopeCovers(scope: string, path: string): boolean {
  if (scope === "/") return true;
  return scope.endsWith("/") ? path === scope.slice(0, -1) || `${path}/`.startsWith(scope) : path === scope;
}

/** A finding's hand-off classes, in their order of precedence (stage3-r2/PREREGISTRATION.md, Measures 2). */
export const FINDING_CLASSES = ["assigned", "reference", "excluded", "out-of-scope", "mention-only", "owned-only", "dropped"] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];
export interface CandidateWorker { id?: string; name: string; role?: string; request: string; files: readonly string[]; from?: string; requestPaths?: readonly string[] }
export interface Exclusion { path?: string; reason?: string; evidence?: unknown; grounded: boolean }
/** A finding a hand-off refusal named: its path, its exploration round (H2; round 1 named paths only) and the problems the runtime gave. */
export interface RefusedFinding { path: string; exploration?: number; problems?: string[] }
/**
 * One candidates orche_spawn call: accepted, refused (tool result isError) or without a result (the session ended while it ran).
 * `index`: its position among the orchestrator's tool calls; `scope`: main's write scope (`files`) of its assignment, canonical, when
 * known; `refused`: the findings its hand-off refusal named. `prepared` (calls without a result only): the runtime's candidates
 * prepare event lists its workers, i.e. the call passed the hand-off gate and its candidates were made. Without that evidence a call
 * without a result is a proposal only: it never counts as accepted (`isAccepted`).
 */
export interface CandidatesCall {
  ref: string; orchestrator: string; index?: number; at?: string; endAt?: string; status: "accepted" | "refused" | "no result"; message?: string;
  workers: CandidateWorker[]; reference: Exclusion[]; excluded: Exclusion[]; scope?: string[]; refused?: RefusedFinding[]; prepared?: boolean;
}

/** A call that counts as accepted: a successful result, or no result but the runtime prepared its candidates (`prepared`). */
export const isAccepted = (call: Pick<CandidatesCall, "status" | "prepared">): boolean => call.status === "accepted" || call.status === "no result" && call.prepared === true;

/** A `reference` or `excluded` entry of a candidates call; `grounded`: a reason and evidence citing an [orche ref Tn] (H2 also checks that the ref is a later own check that names the file). */
export function exclusionOf(item: any): Exclusion {
  const reason = typeof item?.reason === "string" ? item.reason.trim() : undefined;
  const evidence = item?.evidence;
  const cites = (Array.isArray(evidence) ? evidence : [evidence]).some(value => typeof value === "string" && /\bT\d{1,5}\b/.test(value));
  return { ...(typeof item?.path === "string" ? { path: item.path } : {}), ...(reason ? { reason: clip(reason, 1000) } : {}), ...(evidence !== undefined ? { evidence } : {}), grounded: !!reason && cites };
}

/** How one candidates call treats one finding's path: its class there, the candidates that take it (with their files), name it, own it. */
export interface CallVerdict { class: FindingClass; assignedBy: { candidate: string; name: string; files: string[] }[]; namedBy: string[]; ownedBy: string[]; entry?: Exclusion }

/**
 * H2's test of one candidates call for `path` (ultra.ts handoffDecision, on the call's arguments): out of scope first (`outOfScope`);
 * assigned when one candidate of the run's kind (implement; a read-only run: answer) owns the path through its files (a directory
 * `dir/` its files, `./` everything) AND names it in its request (an answer candidate: names it); reference when the call's
 * `reference` lists it and a candidate names it; excluded when its `excluded` lists it; else mention-only (named, by no candidate that
 * owns it), owned-only (owned, named by none) or dropped. `requestPaths` (when given) are the paths a request names.
 */
export function callVerdict(path: string, call: Pick<CandidatesCall, "workers" | "reference" | "excluded">, options: { workspaces: readonly string[]; outOfScope?: boolean }): CallVerdict {
  const readOnly = call.workers.length > 0 && call.workers.every(worker => worker.role === "answer");
  const eligible = call.workers.filter(worker => (worker.role ?? "implement") === (readOnly ? "answer" : "implement"));
  const id = (worker: CandidateWorker) => worker.id ?? worker.name;
  const named = eligible.filter(worker => (worker.requestPaths ?? pathMentions(worker.request, options.workspaces).map(mention => mention.path)).includes(path));
  const owned = readOnly ? [] : eligible.filter(worker => worker.files.some(file => { const scope = canonicalScope(file); return !!scope && scopeCovers(scope, path); }));
  const assigned = readOnly ? named : named.filter(worker => owned.includes(worker));
  const base = { assignedBy: assigned.map(worker => ({ candidate: id(worker), name: worker.name, files: [...worker.files] })), namedBy: named.map(id), ownedBy: owned.map(id) };
  if (options.outOfScope) return { class: "out-of-scope", ...base };
  if (assigned.length) return { class: "assigned", ...base };
  const entry = (list: readonly Exclusion[]) => list.find(item => item.path !== undefined && relativePath(item.path.trim().replace(LINE_SUFFIX, ""), options.workspaces) === path);
  const reference = named.length ? entry(call.reference) : undefined;
  if (reference) return { class: "reference", ...base, entry: reference };
  const excluded = entry(call.excluded);
  if (excluded) return { class: "excluded", ...base, entry: excluded };
  return { class: named.length ? "mention-only" : owned.length ? "owned-only" : "dropped", ...base };
}

/** The intervention runtime's refusal of a candidates call by the hand-off rule (ultra.ts enforceHandoff). */
export const HANDOFF_REFUSAL = /Refused \(ultra hand-off\)/;
const REFUSED_LINE = /^- (\S+?)(?::\d[\d,-]*)? \(analysts? [^\n]*?, exploration round (\d+)\)/gm;
/** The findings a hand-off refusal's text lists (`- path[:lines] (analyst …, exploration round N): "…"`; the first 20 of them). */
export function refusedInText(text: string): RefusedFinding[] {
  return HANDOFF_REFUSAL.test(text) ? [...text.matchAll(REFUSED_LINE)].map(match => ({ path: match[1]!, exploration: Number(match[2]) })) : [];
}

export interface FindingRefusal { call: string; at?: string; problems?: string[]; next?: string; nextAssigned: boolean }
export interface FindingHandoff {
  /** The best class over the accepted calls (FINDING_CLASSES order); dropped without one. */
  class: FindingClass;
  /** The candidates of accepted calls that took it, with their files. */
  assigned: { call: string; candidate: string; name: string; files: string[] }[];
  /** Every proposal (candidates call after the report, accepted or not) and its class there. */
  calls: { call: string; status: CandidatesCall["status"]; prepared?: boolean; class: FindingClass; namedBy: string[]; ownedBy: string[] }[];
  /** The orchestrator's first proposal after the report (accepted or refused): did it already assign the finding? */
  firstProposal?: { call: string; status: CandidatesCall["status"]; class: FindingClass };
  /** The first accepted call: under H2 the runtime's disposition. */
  firstAccepted?: { call: string; class: FindingClass };
  /** Hand-off refusals that named it, each with the next accepted call and whether that call assigned it. */
  refusals: FindingRefusal[];
  /** Gate attribution: a refusal named it, the next accepted call assigned it, and no proposal before that call had assigned it. */
  gateTransferred: boolean;
}

/**
 * The hand-off of one finding over `proposals`: the candidates calls of its orchestrator after the exploration call that reported
 * it, in order. `outOfScope(call)`: the path lies outside that call's write scope; `named(call)`: the call's hand-off refusal named
 * this finding (its problems), else undefined.
 */
export function findingHandoff(path: string, proposals: readonly CandidatesCall[], options: { workspaces: readonly string[]; outOfScope?: (call: CandidatesCall) => boolean; named?: (call: CandidatesCall) => { problems?: string[] } | undefined }): FindingHandoff {
  const verdicts = proposals.map(call => callVerdict(path, call, { workspaces: options.workspaces, outOfScope: options.outOfScope?.(call) ?? false }));
  // A refused call never counts; a call without a result counts only when the runtime prepared its candidates (isAccepted).
  const accepted = (call: CandidatesCall) => isAccepted(call);
  const rank = (value: FindingClass) => FINDING_CLASSES.indexOf(value);
  let best: FindingClass = "dropped";
  proposals.forEach((call, index) => { if (accepted(call) && rank(verdicts[index]!.class) < rank(best)) best = verdicts[index]!.class; });
  const firstAssigned = verdicts.findIndex(verdict => verdict.class === "assigned");
  const refusals: FindingRefusal[] = [];
  proposals.forEach((call, index) => {
    if (call.status !== "refused" || !HANDOFF_REFUSAL.test(call.message ?? "")) return;
    const named = options.named?.(call);
    if (!named) return;
    const next = proposals.findIndex((item, at) => at > index && accepted(item));
    refusals.push({ call: call.ref, ...(call.at ? { at: call.at } : {}), ...(named.problems?.length ? { problems: named.problems } : {}), ...(next >= 0 ? { next: proposals[next]!.ref } : {}), nextAssigned: next >= 0 && verdicts[next]!.class === "assigned" });
  });
  const firstAccepted = proposals.findIndex(accepted);
  return {
    class: best,
    assigned: proposals.flatMap((call, index) => accepted(call) ? verdicts[index]!.assignedBy.map(item => ({ call: call.ref, ...item })) : []),
    calls: proposals.map((call, index) => ({ call: call.ref, status: call.status, ...(call.status === "no result" ? { prepared: call.prepared === true } : {}), class: verdicts[index]!.class, namedBy: verdicts[index]!.namedBy, ownedBy: verdicts[index]!.ownedBy })),
    ...(proposals[0] ? { firstProposal: { call: proposals[0].ref, status: proposals[0].status, class: verdicts[0]!.class } } : {}),
    ...(firstAccepted >= 0 ? { firstAccepted: { call: proposals[firstAccepted]!.ref, class: verdicts[firstAccepted]!.class } } : {}),
    refusals,
    // The first proposal that assigned it is the accepted call right after a refusal that named it: nothing earlier had.
    gateTransferred: firstAssigned >= 0 && refusals.some(item => item.nextAssigned && item.next === proposals[firstAssigned]!.ref),
  };
}

/** The key of a finding: its orchestrator, exploration round and path (`*` for a round-1 event that names no round). */
export const findingKey = (orchestrator: string, round: number | "*", path: string) => `${orchestrator} r${round} ${path}`;

/** What the runtime's ultra `handoff` events recorded: H2's findings and dispositions by round, round 1's locations by path, none in the baseline. */
export interface RuntimeHandoff {
  events: number;
  /** Findings it captured after exploration rounds, by key (round 1: its locations with their round). */
  findings: string[];
  /** Dispositions of accepted candidates calls by finding key (round 1, without a round: `W1 r* path`), first one per key. */
  dispositions: Record<string, { disposition: string; by?: string[] }>;
  outOfScope: string[]; refused: string[]; errors: string[];
  /** Compared with this analysis: findings only it found / only the runtime did (it checks the live workspace), and H2 dispositions that differ from the first accepted call's class here. */
  agreement?: { analysisOnly: string[]; runtimeOnly: string[]; mismatches: string[] };
}
export function runtimeHandoff(events: readonly any[]): RuntimeHandoff {
  const own = events.filter(event => event?.type === "ultra" && event.stage === "handoff");
  const findings = new Set<string>(), refused = new Set<string>(), dispositions: RuntimeHandoff["dispositions"] = {}, errors: string[] = [];
  const keyOf = (event: any, item: any, round: unknown) => findingKey(String(event.worker ?? "?"), typeof round === "number" ? round : "*", String(item.path));
  for (const event of own) {
    for (const item of [...(Array.isArray(event.findings) ? event.findings : []), ...(Array.isArray(event.locations) ? event.locations : [])]) if (typeof item?.path === "string") findings.add(keyOf(event, item, item.round ?? event.exploration));
    for (const item of Array.isArray(event.dispositions) ? event.dispositions : []) {
      if (typeof item?.path !== "string" || typeof item.disposition !== "string") continue;
      const key = keyOf(event, item, item.exploration);
      if (!(key in dispositions)) dispositions[key] = { disposition: item.disposition, ...(Array.isArray(item.by) ? { by: item.by.map(String) } : {}) };
    }
    for (const item of Array.isArray(event.refused) ? event.refused : []) if (typeof item?.path === "string") refused.add(keyOf(event, item, item.exploration));
    if (typeof event.error === "string") errors.push(clip(event.error, 500));
  }
  return { events: own.length, findings: [...findings].sort(), dispositions, outOfScope: Object.keys(dispositions).filter(key => dispositions[key]!.disposition === "out-of-scope").sort(), refused: [...refused].sort(), errors };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Gold (analysis only) and the final diff

export type FileKind = "source" | "test" | "doc";
const DOC_DIRS = /^(docs?|documentation|changelog|changelog\.d|newsfragments)$/i;
/** Documentation: under docs/doc/documentation/changelog(.d)/newsfragments, Markdown/reST/AsciiDoc, or CHANGES/HISTORY/NEWS/README-like names. */
export function isDocFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return parts.slice(0, -1).some(part => DOC_DIRS.test(part)) || /\.(md|markdown|rst|adoc|asciidoc)$/i.test(name) || /^(CHANGES|CHANGELOG|HISTORY|NEWS|README|AUTHORS|CONTRIBUTORS|CONTRIBUTING)(\.[^/]*)?$/i.test(name);
}
/** Tests by the grader's rule (ultra-ab protocol.ts isTestFile), then docs, else source. */
export const fileKind = (path: string): FileKind => isTestFile(path) ? "test" : isDocFile(path) ? "doc" : "source";

/** Files a git diff touches (both sides of the `diff --git` line, ---/+++ and rename/copy headers; /dev/null apart). */
export function diffFiles(diff: string): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined, prefixed: boolean) => {
    if (!raw) return;
    let path = raw.replace(/\t.*$/, "");
    if (path.startsWith("\"") && path.endsWith("\"")) path = path.slice(1, -1);
    if (path === "/dev/null") return;
    if (prefixed) { if (!/^[ab]\//.test(path)) return; path = path.slice(2); }
    if (path) out.add(path);
  };
  let header = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      const simple = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (simple) { add(simple[1], false); add(simple[2], false); }
      continue;
    }
    if (!header) continue;
    if (line.startsWith("@@") || line.startsWith("GIT binary patch") || line.startsWith("Binary files")) { header = false; continue; }
    const side = /^(?:---|\+\+\+) (.+)$/.exec(line);
    if (side) { add(side[1], true); continue; }
    const moved = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (moved) add(moved[1], false);
  }
  return [...out].sort();
}

const treeFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile()) out.push(relative(root, path)); } };
  if (existsSync(root)) walk(root);
  return out.sort();
};
const sameBytes = (a: string, b: string): boolean => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
const shown = (file: string): string => file.startsWith(`${REPO}/`) ? relative(REPO, file) : file;

export interface Reference { file: string; files: { path: string; kind: FileKind }[] }
/** The reference fix: SWE `reference/fix.patch`; suite `reference/` files that differ from (or are absent in) the snapshot. */
export function referenceOf(task: { dir: string; source: string }): Reference | undefined {
  const patch = join(task.dir, "reference/fix.patch"), tree = join(task.dir, "reference");
  const paths = existsSync(patch) ? diffFiles(readFileSync(patch, "utf8")) : existsSync(tree) ? treeFiles(tree).filter(path => !sameBytes(join(tree, path), join(task.source, path))) : undefined;
  return paths ? { file: shown(existsSync(patch) ? patch : tree), files: paths.map(path => ({ path, kind: fileKind(path) })) } : undefined;
}

/** `failing`: the test ids and statuses the grader listed as not passed (SWE detail; it lists at most what fits its 1500 characters). */
export interface TestCheck { passed: boolean; passedTests?: number; total?: number; failures?: number; failing?: string[]; detail: string }
/** A grade check with its counts: SWE `n/m passed[ (k excluded)]: id STATUS; …`, suite TAP `pass n, fail m`. */
export function testCheck(check: any): TestCheck | undefined {
  if (!check || typeof check !== "object") return undefined;
  const detail = String(check.detail ?? "");
  const swe = /^(\d+)\/(\d+) passed(?: \(\d+ excluded\))?(?:: ([\s\S]*))?/.exec(detail), tap = /pass (\d+), fail (-?\d+)/.exec(detail);
  const passed = swe ? Number(swe[1]) : tap ? Number(tap[1]) : undefined;
  const total = swe ? Number(swe[2]) : tap && Number(tap[2]) >= 0 ? Number(tap[1]) + Number(tap[2]) : undefined;
  const failing = swe?.[3]?.split("; ").map(item => item.trim()).filter(Boolean);
  return { passed: check.passed === true, ...(passed !== undefined ? { passedTests: passed } : {}), ...(total !== undefined && passed !== undefined ? { total, failures: total - passed } : {}), ...(failing?.length ? { failing } : {}), detail: clip(detail, 1500) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Records: orchestrator and sub-worker transcripts

const WORKER_FILE = /^(W\d+(?:\.\d+)*)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/;
/** Worker transcripts (records/<session>/workers/<agent>-<ts>.jsonl) by agent id. */
function transcriptFiles(runDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of jsonlFiles(join(runDir, "records"))) {
    const agent = WORKER_FILE.exec(basename(file))?.[1];
    if (agent && basename(dirname(file)) === "workers") out.set(agent, [...(out.get(agent) ?? []), file]);
  }
  return out;
}

interface ToolCall { agent: string; id: string; name: string; arguments: any; at?: number; result?: { at?: number; isError: boolean; text: string; details: any } }
function toolCalls(files: readonly string[], agent: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const file of files) for (const entry of readJsonl<any>(file)) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (!message) continue;
    const at = ms(entry.timestamp) ?? ms(message.timestamp);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall") continue;
        const call: ToolCall = { agent, id: String(part.id), name: String(part.name), arguments: part.arguments && typeof part.arguments === "object" ? part.arguments : {}, ...(at !== undefined ? { at } : {}) };
        calls.push(call); byId.set(call.id, call);
      }
    } else if (message.role === "toolResult") {
      const call = byId.get(String(message.toolCallId));
      if (call) call.result = { ...(at !== undefined ? { at } : {}), isError: message.isError === true, text: textOf(message.content), details: message.details && typeof message.details === "object" ? message.details : {} };
    }
  }
  return calls;
}

/** A sub-worker's own last report that was not rejected (its report_result arguments). */
function ownReport(files: readonly string[] | undefined, agent: string): { summary: unknown; data: unknown; at?: number } | undefined {
  const report = toolCalls(files ?? [], agent).filter(call => call.name === "report_result" && call.result?.isError !== true).at(-1);
  return report ? { summary: report.arguments.summary, data: report.arguments.data, ...(report.at !== undefined ? { at: report.at } : {}) } : undefined;
}

const WORKER_HEADER = /^W\d+(?:\.\d+)+ \S+ \((?:implement|answer|verify|game-asset|video), /;
/** Last resort: one worker's block of the formatted orche_spawn text (its summary is clipped there). */
function formattedBlock(text: string, id: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex(line => line.startsWith(`${id} `) && WORKER_HEADER.test(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => WORKER_HEADER.test(line) || /^(Warning: |Ultra |You own the result)/.test(line));
  return rest.slice(0, end < 0 ? undefined : end).join("\n").trim() || undefined;
}

const BASIS_LINES = [/^Ultra protected basis: (.+)$/, /^Protected verification basis \([^)]*\): (.+)$/];
const basisOfLine = (line: string): string[] => { for (const pattern of BASIS_LINES) { const match = pattern.exec(line.trim()); if (match) return match[1]!.replace(/\.$/, "").split(/,\s+/).filter(Boolean); } return []; };

// ---------------------------------------------------------------------------------------------------------------------------
// One unit

export interface Analyst {
  id: string; name: string; orchestrator: string; call: string; round: number; at?: string; status: string;
  /** Where the full report came from; `transcript`: the analyst's own report compared with the details outcome. */
  source?: "details" | "transcript" | "formatted"; transcript: "same" | "differs" | "used" | "absent"; chars: number; locations: string[];
}
/** One finding (an orchestrator's exploration round and a path) with its provenance, its hand-off by H2's test, the gold and the diff. */
export interface Finding extends FindingHandoff {
  key: string; path: string; orchestrator: string; round: number;
  /** The exploration call that reported it, and when its result came. */
  call: string; reportedAt?: string;
  lines: string[]; analysts: { id: string; excerpt: string; lines: string[] }[];
  decisive: boolean; reference?: FileKind;
  /** The runtime's own disposition of it, when its events record one (H2: by round; round 1: by path). */
  runtime?: { disposition: string; by?: string[] };
  diffTouched: boolean;
}
export interface ChainFlags {
  findings: number; reportedDecisive: boolean;
  /** Decisive findings (keys): all, by class, those the first proposal already assigned, those a refusal named, those the gate transferred. */
  decisive: string[]; decisiveByClass: Record<FindingClass, string[]>;
  decisiveFirstProposalAssigned: string[]; decisiveRefused: string[]; decisiveGateTransferred: string[];
  /** Every decisive finding's file / every reference-fix source file touched by final.diff (null: none reported / none known). */
  diffTouchedDecisive: boolean | null; diffTouchedReference: boolean | null;
  f2pPassed: boolean | null; p2pRegression: boolean | null; integrityViolation: boolean; terminalNonDone: boolean; primaryPass: boolean;
  refusedCandidates: number; handoffRefusals: number;
}
export interface UnitChain {
  id: string; dir: string; task: string; arm: string; layout: "ultra-ho" | "ultra-ab" | "unknown"; mode?: string; runtime?: string;
  /** The task's fixture directory (gold: reference/) and its initial snapshot. */
  fixture: string; snapshot: string; workspaces: string[]; reference?: Reference; basis: string[];
  analysts: Analyst[]; findings: Finding[]; candidates: CandidatesCall[];
  /** The runtime's own hand-off record (ultra handoff events): a cross-check; an input only for out of scope. */
  handoffRecord: RuntimeHandoff;
  implementation: { diffFiles: string[]; decisive: { key: string; path: string; touched: boolean }[]; reference: { path: string; kind: FileKind; reported: boolean; class?: FindingClass; touched: boolean }[] };
  correctness: { gradePassed: boolean | null; gradeError?: string; failToPass?: TestCheck; passToPass?: TestCheck; integrityViolations: string[] };
  process: { terminal?: string; primaryPass: boolean; requests: number | null; costUSD: number | null; wallMinutes: number | null; assignments: number; carried: number; continuations: number };
  chain: ChainFlags;
}
export interface TaskSource { kind: string; source: string; dir: string }

/**
 * The task a unit ran, from its own fixture root: meta.fixtureRoot (run-one.ts) and, for SWE, the snapshot in the cache its
 * environment was staged from (meta.sweCacheSource, else the canonical cache). A unit without a recorded root: ultra-ab loadTask
 * (the canonical fixture roots).
 */
export async function unitTask(meta: any, repo = REPO): Promise<TaskSource> {
  const id = String(meta?.task ?? "");
  if (!isString(meta?.fixtureRoot)) return loadTask(id);
  const dir = join(meta.fixtureRoot, id);
  if (meta.kind === "swe" || meta.kind === undefined && existsSync(join(dir, "hidden/test.patch"))) return { kind: "swe", dir, source: join(isString(meta.sweCacheSource) ? meta.sweCacheSource : resolve(repo, DEFAULT_SWE_CACHE_SOURCE), id, "src") };
  return { kind: String(meta.kind ?? "suite"), dir, source: join(dir, "repo") };
}

/** The chain of one finished unit directory (runs/<task>/<arm>/r<n>); `task` overrides the unit's own task (synthetic units). */
export async function unitChain(dir: string, options: { task?: TaskSource } = {}): Promise<UnitChain> {
  const meta = readJson(join(dir, "meta.json")) ?? {};
  const layout: UnitChain["layout"] = meta.arm !== undefined ? "ultra-ho" : meta.condition !== undefined ? "ultra-ab" : "unknown";
  if (typeof meta.task !== "string" && !options.task) throw new Error(`${dir}: meta.json names no task`);
  const task = options.task ?? await unitTask(meta);
  const snapshot = snapshotOf(task.source);
  const records = taskRecordIndex(dir);
  const events = records.flatMap(record => record.events);
  const workspaces = [...new Set([meta.workspace, meta.command?.cwd, ...records.map(record => record.run?.cwd)].filter(isString))];
  const files = transcriptFiles(dir);
  // Every orche_spawn call of each orchestrator, with its position among the orchestrator's calls (the order findings and proposals follow).
  const spawns = [...files].filter(([agent]) => /^W\d+$/.test(agent)).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .flatMap(([agent, list]) => toolCalls(list, agent).map((call, index) => ({ ...call, index })).filter(call => call.name === "orche_spawn").map((call, n) => ({ ...call, ref: `${agent} orche_spawn #${n + 1}` })));
  let items: any[] = [];
  try { items = meta.sessionId ? assignments(dir, meta.sessionId) : []; } catch { items = []; }
  if (!items.length) items = readJson(join(dir, "tasks.json")) ?? [];

  // Ids by call (fallback when a call has no details): the ultra prepare events list them in the call's worker order.
  const used = new Set<any>();
  const preparedIds = (call: ToolCall, stage: string): string[] | undefined => {
    const event = events.filter(item => item?.type === "ultra" && item.stage === stage && item.worker === call.agent && Array.isArray(item.workers) && !used.has(item) && (ms(item.timestamp) ?? 0) >= (call.at ?? 0) - 1000)
      .sort((a, b) => (ms(a.timestamp) ?? 0) - (ms(b.timestamp) ?? 0))[0];
    if (!event) return undefined;
    used.add(event);
    return event.workers.map((item: any) => typeof item === "string" ? item : String(item?.id ?? ""));
  };
  const spawnStatus = new Map<string, string>();
  for (const event of events) if (event?.type === "spawn" && Array.isArray(event.workers)) for (const worker of event.workers) if (worker?.id && typeof worker.status === "string") spawnStatus.set(String(worker.id), worker.status);

  // Exploration members (accepted calls), each call's exploration round (the runtime's prepare event, else the count) and the protected basis.
  const rounds = new Map<string, number>();
  const exploration = spawns.filter(call => call.arguments?.reason === "exploration" && call.result?.isError !== true).map(call => {
    const outcomes: any[] = Array.isArray(call.result?.details?.workers) ? call.result!.details.workers : [];
    const planned: any[] = Array.isArray(call.arguments.workers) ? call.arguments.workers : [];
    const ids = outcomes.length ? undefined : preparedIds(call, "exploration");
    const members = outcomes.length
      ? outcomes.map(outcome => ({ id: String(outcome?.id ?? ""), name: String(outcome?.name ?? ""), role: String(outcome?.role ?? ""), status: typeof outcome?.status === "string" ? outcome.status as string : undefined, outcome }))
      : planned.map((worker, index) => ({ id: ids?.[index] ?? "", name: String(worker?.name ?? ""), role: String(worker?.role ?? ""), status: undefined as string | undefined, outcome: undefined as any }));
    const memberIds = new Set(members.map(member => member.id).filter(Boolean));
    const event = events.find(item => item?.type === "ultra" && item.stage === "exploration" && item.worker === call.agent && typeof item.round === "number" && Array.isArray(item.workers) && item.workers.some((id: unknown) => memberIds.has(typeof id === "string" ? id : String((id as { id?: unknown } | null)?.id ?? ""))));
    const round = typeof event?.round === "number" ? event.round as number : (rounds.get(call.agent) ?? 0) + 1;
    rounds.set(call.agent, Math.max(rounds.get(call.agent) ?? 0, round));
    return { call, members, round };
  });
  const basis = new Set<string>();
  const addBasis = (raw: unknown) => { if (typeof raw !== "string") return; const path = relativePath(raw, workspaces); if (path) basis.add(path); };
  for (const { call, members } of exploration) {
    for (const member of members) if (member.role === "implement" && (member.status ?? spawnStatus.get(member.id)) === "done" && Array.isArray(member.outcome?.changes)) member.outcome.changes.forEach(addBasis);
    for (const line of Array.isArray(call.result?.details?.ultra) ? call.result!.details.ultra : []) basisOfLine(String(line)).forEach(addBasis);
  }
  for (const event of events) if (event?.type === "ultra" && event.stage === "exploration" && Array.isArray(event.protected)) event.protected.forEach(addBasis);
  for (const item of items) for (const line of Array.isArray(item?.ultraLines) ? item.ultraLines : []) basisOfLine(String(line)).forEach(addBasis);
  const basisList = [...basis].sort();

  // 1. Analysts and their findings (orchestrator, exploration round, path).
  const analysts: Analyst[] = [];
  type Draft = Pick<Finding, "key" | "path" | "orchestrator" | "round" | "call" | "reportedAt" | "lines" | "analysts"> & { index: number };
  const found = new Map<string, Draft>();
  for (const { call, members, round } of exploration) {
    for (const member of members) {
      if (member.role !== "answer") continue;
      const own = member.id ? ownReport(files.get(member.id), member.id) : undefined;
      const status = member.status ?? spawnStatus.get(member.id) ?? (own ? "done" : "unknown");
      const hasOutcome = !!member.outcome && (typeof member.outcome.summary === "string" || member.outcome.data !== undefined);
      const block = !hasOutcome && !own && member.id ? formattedBlock(call.result?.text ?? "", member.id) : undefined;
      const report = hasOutcome ? { summary: member.outcome.summary, data: member.outcome.data } : own ? { summary: own.summary, data: own.data } : block !== undefined ? { summary: block } : undefined;
      const same = own && hasOutcome ? (own.summary === member.outcome.summary && JSON.stringify(own.data ?? null) === JSON.stringify(member.outcome.data ?? null) ? "same" : "differs") : own ? "used" : "absent";
      const at = call.result?.at ?? own?.at;
      const located = status === "done" && report ? reportLocations(report, { snapshot, workspaces, basis: basisList }) : [];
      analysts.push({
        id: member.id || member.name, name: member.name, orchestrator: call.agent, call: call.ref, round, ...(iso(at) ? { at: iso(at) } : {}), status,
        ...(report ? { source: hasOutcome ? "details" as const : own ? "transcript" as const : "formatted" as const } : {}), transcript: same,
        chars: report ? (typeof report.summary === "string" ? report.summary.length : 0) + JSON.stringify((report as { data?: unknown }).data ?? null).length : 0, locations: located.map(item => item.path),
      });
      for (const item of located) {
        const key = findingKey(call.agent, round, item.path);
        let entry = found.get(key);
        if (!entry) found.set(key, entry = { key, path: item.path, orchestrator: call.agent, round, call: call.ref, index: call.index, lines: [], analysts: [] });
        for (const lines of item.lines) if (!entry.lines.includes(lines)) entry.lines.push(lines);
        entry.analysts.push({ id: member.id || member.name, excerpt: item.excerpt, lines: item.lines });
        if (at !== undefined && (entry.reportedAt === undefined || at < Date.parse(entry.reportedAt))) entry.reportedAt = iso(at);
      }
    }
  }

  // 3. Candidates calls (the write scope of their assignment, the findings a hand-off refusal named) and each finding's hand-off.
  const scopeAt = (agent: string, at: number | undefined): string[] | undefined => {
    const item = [...items].reverse().find(entry => entry?.worker === agent && (at === undefined || ms(entry?.at) === undefined || ms(entry.at)! <= at));
    const scope = item?.requested?.files;
    if (!Array.isArray(scope) || item.requested.role === "answer") return undefined;
    return scope.map((file: unknown) => canonicalScope(String(file))).filter(isString);
  };
  const refusalEvents = events.filter(event => event?.type === "ultra" && event.stage === "handoff" && Array.isArray(event.refused));
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const candidates: CandidatesCall[] = spawns.filter(call => call.arguments?.reason === "candidates").map(call => {
    const status = !call.result ? "no result" as const : call.result.isError ? "refused" as const : "accepted" as const;
    const outcomes: any[] = Array.isArray(call.result?.details?.workers) ? call.result!.details.workers : [];
    const planned: any[] = Array.isArray(call.arguments.workers) ? call.arguments.workers : [];
    const ids = status === "no result" ? preparedIds(call, "candidates") : undefined;
    const scope = scopeAt(call.agent, call.at);
    const endAt = call.result?.at;
    // The findings its hand-off refusal named: the runtime's refused event of this call (between its start and its result), else its text.
    const event = status === "refused" ? refusalEvents.find(item => item.worker === call.agent && (ms(item.timestamp) ?? 0) >= (call.at ?? 0) - 1000 && (endAt === undefined || (ms(item.timestamp) ?? 0) <= endAt + 1000)) : undefined;
    const refused: RefusedFinding[] = event
      ? event.refused.filter((item: any) => typeof item?.path === "string").map((item: any) => ({ path: item.path, ...(typeof item.exploration === "number" ? { exploration: item.exploration } : {}), ...(Array.isArray(item.problems) ? { problems: item.problems.map(String) } : typeof item.problem === "string" ? { problems: [item.problem] } : {}) }))
      : status === "refused" ? refusedInText(call.result!.text) : [];
    return {
      ref: call.ref, orchestrator: call.agent, index: call.index, ...(iso(call.at) ? { at: iso(call.at) } : {}), ...(iso(endAt) ? { endAt: iso(endAt) } : {}), status,
      ...(status === "refused" ? { message: clip(call.result!.text, 2000) } : {}),
      workers: planned.map((worker, index): CandidateWorker => {
        const request = String(worker?.request ?? "");
        const id = outcomes.find(outcome => outcome?.name === worker?.name)?.id ?? ids?.[index];
        return { ...(id ? { id: String(id) } : {}), name: String(worker?.name ?? ""), ...(typeof worker?.role === "string" ? { role: worker.role } : {}), ...(typeof worker?.from === "string" ? { from: worker.from } : {}), files: Array.isArray(worker?.files) ? worker.files.map(String) : [], request: clip(request, 4000), requestPaths: [...new Set(pathMentions(request, workspaces).map(mention => mention.path))].filter(path => snapshot.isFile(path)).sort() };
      }),
      reference: list(call.arguments.reference).map(exclusionOf), excluded: list(call.arguments.excluded).map(exclusionOf),
      ...(scope ? { scope } : {}), ...(refused.length ? { refused } : {}), ...(status === "no result" ? { prepared: !!ids?.length } : {}),
    };
  });
  const runtime = runtimeHandoff(events);
  const reference = referenceOf(task);
  const sources = new Set((reference?.files ?? []).filter(file => file.kind === "source").map(file => file.path));
  const kinds = new Map((reference?.files ?? []).map(file => [file.path, file.kind] as const));
  const touched = new Set(diffFiles(existsSync(join(dir, "final.diff")) ? readFileSync(join(dir, "final.diff"), "utf8") : ""));
  const findings: Finding[] = [...found.values()].map(({ index, ...entry }) => {
    // Its orchestrator's candidates calls after the exploration call that reported it, accepted or not, in order.
    const proposals = candidates.filter(call => call.orchestrator === entry.orchestrator && (call.index ?? 0) > index);
    const roundless = findingKey(entry.orchestrator, "*", entry.path);
    const recordedOut = runtime.outOfScope.includes(entry.key) || runtime.outOfScope.includes(roundless);
    const handoff = findingHandoff(entry.path, proposals, {
      workspaces,
      outOfScope: call => recordedOut || !!call.scope && !call.scope.some(scope => scopeCovers(scope, entry.path)),
      named: call => { const hit = call.refused?.find(item => item.path === entry.path && (item.exploration === undefined || item.exploration === entry.round)); return hit ? { ...(hit.problems?.length ? { problems: hit.problems } : {}) } : undefined; },
    });
    const recorded = runtime.dispositions[entry.key] ?? runtime.dispositions[roundless];
    const kind = kinds.get(entry.path);
    return { ...entry, decisive: sources.has(entry.path), ...(kind ? { reference: kind } : {}), ...handoff, ...(recorded ? { runtime: recorded } : {}), diffTouched: touched.has(entry.path) };
  }).sort((a, b) => Number(b.decisive) - Number(a.decisive) || a.path.localeCompare(b.path) || a.orchestrator.localeCompare(b.orchestrator) || a.round - b.round);
  const decisive = findings.filter(entry => entry.decisive);
  if (runtime.events) runtime.agreement = {
    analysisOnly: findings.map(entry => entry.key).filter(key => !runtime.findings.includes(key)),
    runtimeOnly: runtime.findings.filter(key => !found.has(key)),
    mismatches: findings.flatMap(entry => { const recorded = runtime.dispositions[entry.key]; const analysed = entry.firstAccepted?.class; return recorded && analysed && recorded.disposition !== analysed ? [`${entry.key}: runtime ${recorded.disposition}, analysis ${analysed}`] : []; }),
  };

  // 4–5. Implementation, correctness, process.
  const gradeFile = readJson(join(dir, "grade.json"));
  const grade = gradeFile?.grade ?? meta.grade;
  const checks = gradeFile?.grade?.checks ?? {};
  const failToPass = testCheck(checks.failToPass ?? checks.hiddenTests);
  const passToPass = testCheck(checks.passToPass ?? checks.visibleTests);
  const violations: string[] = (gradeFile?.integrity?.violations ?? meta.integrity?.violations ?? []).map(String);
  const refused = candidates.filter(call => call.status === "refused");
  const byClass = Object.fromEntries(FINDING_CLASSES.map(value => [value, decisive.filter(entry => entry.class === value).map(entry => entry.key)])) as Record<FindingClass, string[]>;
  const best = (path: string) => findings.filter(entry => entry.path === path).map(entry => entry.class).sort((a, b) => FINDING_CLASSES.indexOf(a) - FINDING_CLASSES.indexOf(b))[0];
  const referenceRows = (reference?.files ?? []).map(file => { const value = best(file.path); return { path: file.path, kind: file.kind, reported: value !== undefined, ...(value ? { class: value } : {}), touched: touched.has(file.path) }; });
  return {
    id: String(meta.unit ?? relative(join(dir, "../../.."), dir)), dir: shown(dir), task: String(meta.task ?? ""), arm: String(meta.arm ?? meta.condition ?? "?"), layout,
    ...(meta.mode ? { mode: String(meta.mode) } : {}), ...(meta.runtime ? { runtime: typeof meta.runtime === "string" ? shown(meta.runtime) : `${meta.runtime.name} ${String(meta.runtime.digest ?? "").slice(0, 12)}` } : {}),
    fixture: shown(task.dir), snapshot: shown(task.source), workspaces, ...(reference ? { reference } : {}), basis: basisList,
    analysts, findings, candidates, handoffRecord: runtime,
    implementation: { diffFiles: [...touched].sort(), decisive: decisive.map(entry => ({ key: entry.key, path: entry.path, touched: entry.diffTouched })), reference: referenceRows },
    correctness: { gradePassed: typeof grade?.passed === "boolean" ? grade.passed : null, ...(grade?.error ? { gradeError: clip(String(grade.error), 1500) } : {}), ...(failToPass ? { failToPass } : {}), ...(passToPass ? { passToPass } : {}), integrityViolations: violations },
    process: {
      ...(meta.terminal ? { terminal: String(meta.terminal) } : {}), primaryPass: meta.primaryPass === true,
      requests: typeof meta.wire?.requests === "number" ? meta.wire.requests : null, costUSD: typeof meta.wire?.costUSD === "number" ? meta.wire.costUSD : null,
      wallMinutes: typeof meta.wallMs === "number" ? Math.round(meta.wallMs / 600) / 100 : null,
      assignments: items.length, carried: items.filter(item => item?.carried).length, continuations: items.filter(item => item?.passedTask).length,
    },
    chain: {
      findings: findings.length, reportedDecisive: decisive.length > 0, decisive: decisive.map(entry => entry.key), decisiveByClass: byClass,
      decisiveFirstProposalAssigned: decisive.filter(entry => entry.firstProposal?.class === "assigned").map(entry => entry.key),
      decisiveRefused: decisive.filter(entry => entry.refusals.length > 0).map(entry => entry.key),
      decisiveGateTransferred: decisive.filter(entry => entry.gateTransferred).map(entry => entry.key),
      diffTouchedDecisive: decisive.length ? decisive.every(entry => entry.diffTouched) : null,
      diffTouchedReference: sources.size ? [...sources].every(path => touched.has(path)) : null,
      f2pPassed: failToPass ? failToPass.passed : null, p2pRegression: passToPass ? !passToPass.passed || (passToPass.failures ?? 0) > 0 : null,
      integrityViolation: violations.length > 0, terminalNonDone: meta.terminal !== "done", primaryPass: meta.primaryPass === true,
      refusedCandidates: refused.length, handoffRefusals: refused.filter(call => HANDOFF_REFUSAL.test(call.message ?? "")).length,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Totals per arm and per task

export type ClassCounts = Record<FindingClass, number> & { total: number };
export interface ChainTotals {
  units: number;
  /** Units with ≥ 1 finding / with a decisive finding, and among the latter those whose decisive findings were all assigned / not all. */
  reportedAny: number; reportedDecisive: number; decisiveAllAssigned: number; decisiveNotAllAssigned: number;
  diffTouchedDecisive: number; diffTouchedReference: number;
  f2pPassed: number; p2pRegressions: number; integrityViolations: number; terminalNonDone: number; primaryPass: number;
  refusedCandidates: number; handoffRefusals: number;
  /** Findings by class; decisive findings by class, touched by final.diff, assigned by the first proposal, named by a refusal, gate-transferred. */
  findings: ClassCounts;
  decisiveFindings: ClassCounts & { diffTouched: number; firstProposalAssigned: number; refused: number; gateTransferred: number };
  requests: number; costUSD: number | null; wallMinutes: number;
}
const classCounts = (): ClassCounts => ({ total: 0, ...Object.fromEntries(FINDING_CLASSES.map(value => [value, 0])) }) as ClassCounts;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function chainTotals(units: readonly UnitChain[]): ChainTotals {
  const total: ChainTotals = {
    units: units.length, reportedAny: 0, reportedDecisive: 0, decisiveAllAssigned: 0, decisiveNotAllAssigned: 0, diffTouchedDecisive: 0, diffTouchedReference: 0,
    f2pPassed: 0, p2pRegressions: 0, integrityViolations: 0, terminalNonDone: 0, primaryPass: 0, refusedCandidates: 0, handoffRefusals: 0,
    findings: classCounts(), decisiveFindings: { ...classCounts(), diffTouched: 0, firstProposalAssigned: 0, refused: 0, gateTransferred: 0 }, requests: 0, costUSD: null, wallMinutes: 0,
  };
  for (const unit of units) {
    const chain = unit.chain;
    if (chain.findings) total.reportedAny++;
    if (chain.reportedDecisive) {
      total.reportedDecisive++;
      if (chain.decisiveByClass.assigned.length === chain.decisive.length) total.decisiveAllAssigned++; else total.decisiveNotAllAssigned++;
    }
    if (chain.diffTouchedDecisive) total.diffTouchedDecisive++;
    if (chain.diffTouchedReference) total.diffTouchedReference++;
    if (chain.f2pPassed) total.f2pPassed++;
    if (chain.p2pRegression) total.p2pRegressions++;
    if (chain.integrityViolation) total.integrityViolations++;
    if (chain.terminalNonDone) total.terminalNonDone++;
    if (chain.primaryPass) total.primaryPass++;
    total.refusedCandidates += chain.refusedCandidates; total.handoffRefusals += chain.handoffRefusals;
    for (const finding of unit.findings) {
      total.findings.total++; total.findings[finding.class]++;
      if (!finding.decisive) continue;
      const counts = total.decisiveFindings;
      counts.total++; counts[finding.class]++;
      if (finding.diffTouched) counts.diffTouched++;
      if (finding.firstProposal?.class === "assigned") counts.firstProposalAssigned++;
      if (finding.refusals.length) counts.refused++;
      if (finding.gateTransferred) counts.gateTransferred++;
    }
    total.requests += unit.process.requests ?? 0;
    if (unit.process.costUSD !== null) total.costUSD = round2((total.costUSD ?? 0) + unit.process.costUSD);
    total.wallMinutes = round2(total.wallMinutes + (unit.process.wallMinutes ?? 0));
  }
  return total;
}

export interface ChainSummary {
  out: string;
  units: { id: string; task: string; arm: string; layout: string; chain?: ChainFlags; error?: string; status?: string }[];
  arms: Record<string, ChainTotals>;
  tasks: Record<string, Record<string, ChainTotals>>;
}
export function summarizeChains(out: string, units: readonly UnitChain[], skipped: readonly { id: string; task: string; arm: string; status?: string; error?: string }[] = []): ChainSummary {
  const arms: ChainSummary["arms"] = {};
  const tasks: ChainSummary["tasks"] = {};
  for (const arm of [...new Set(units.map(unit => unit.arm))].sort()) arms[arm] = chainTotals(units.filter(unit => unit.arm === arm));
  for (const task of [...new Set(units.map(unit => unit.task))].sort()) {
    tasks[task] = {};
    for (const arm of [...new Set(units.filter(unit => unit.task === task).map(unit => unit.arm))].sort()) tasks[task]![arm] = chainTotals(units.filter(unit => unit.task === task && unit.arm === arm));
  }
  return { out: shown(out), units: [...units.map(unit => ({ id: unit.id, task: unit.task, arm: unit.arm, layout: unit.layout, chain: unit.chain })), ...skipped.map(item => ({ ...item, layout: "?" }))], arms, tasks };
}

const loc = (entry: Finding) => `${entry.path}${entry.lines.length ? `:${entry.lines.join(";")}` : ""}`;
/** One finding's hand-off in words: its class, who took it, the first proposal, the refusals that named it, the gate attribution, the runtime's record. */
export function handoffText(entry: Finding): string {
  const parts: string[] = [entry.class];
  if (entry.assigned.length) parts.push(`assigned to ${entry.assigned.map(item => `${item.candidate} [files ${item.files.join(", ") || "none"}] in ${item.call}`).join("; ")}`);
  parts.push(entry.firstProposal ? `first proposal ${entry.firstProposal.call} (${entry.firstProposal.status}): ${entry.firstProposal.class}` : "no candidates call after the report");
  if (entry.refusals.length) parts.push(`refusals naming it: ${entry.refusals.map(item => `${item.call} → ${item.next ? `${item.next} ${item.nextAssigned ? "assigned it" : "did not assign it"}` : "no accepted call after it"}`).join("; ")}`);
  parts.push(`gate-transferred: ${entry.gateTransferred ? "yes" : "no"}`);
  if (entry.runtime) parts.push(`runtime: ${entry.runtime.disposition}${entry.runtime.by?.length ? ` by ${entry.runtime.by.join(", ")}` : ""}`);
  return parts.join("; ");
}
const ROW = ["units", "reported any", "reported decisive", "decisive all assigned", "decisive not all assigned", "decisive findings assigned/reference/excluded/out of scope/mention-only/owned-only/dropped of n", "first proposal assigned", "named by a refusal", "gate-transferred", "decisive findings touched", "diff touched every decisive file (units)", "diff touched all reference files", "F2P pass", "P2P regression", "integrity violation", "terminal not done", "primary pass", "refused candidates calls (hand-off)", "requests", "USD", "wall min"];
const classesOf = (counts: ClassCounts) => `${FINDING_CLASSES.map(value => counts[value]).join("/")} of ${counts.total}`;
const row = (total: ChainTotals): string[] => [total.units, total.reportedAny, total.reportedDecisive, total.decisiveAllAssigned, total.decisiveNotAllAssigned, classesOf(total.decisiveFindings),
  total.decisiveFindings.firstProposalAssigned, total.decisiveFindings.refused, total.decisiveFindings.gateTransferred, total.decisiveFindings.diffTouched, total.diffTouchedDecisive, total.diffTouchedReference,
  total.f2pPassed, total.p2pRegressions, total.integrityViolations, total.terminalNonDone, total.primaryPass, `${total.refusedCandidates} (${total.handoffRefusals})`, total.requests, total.costUSD ?? "n/a", total.wallMinutes].map(String);

export function formatChains(summary: ChainSummary, units: readonly UnitChain[]): string {
  const lines = [`# ultra-ho hand-off chain: ${summary.out}`, "", "Measures of results/ultra-ho/stage3-r2/PREREGISTRATION.md from raw records (experiments/ultra-ho/chain.ts); the reference fix is gold for this analysis only. A finding is one orchestrator's exploration round's reported file; \"decisive\" = a finding whose file the reference fix changes in non-test source. Classes by H2's test on every candidates call after the report, in every arm: assigned (owned and named by the same implement candidate), reference, excluded, out of scope, mention-only, owned-only, dropped. Gate-transferred: a hand-off refusal named it, the next accepted call assigned it, and no earlier proposal had. Unit counts unless named otherwise.", "", "## Totals per arm", "", `| arm | ${ROW.join(" | ")} |`, `|---|${ROW.map(() => "---").join("|")}|`];
  for (const [arm, total] of Object.entries(summary.arms)) lines.push(`| ${arm} | ${row(total).join(" | ")} |`);
  lines.push("", "## Per task and arm", "", `| task | arm | ${ROW.join(" | ")} |`, `|---|---|${ROW.map(() => "---").join("|")}|`);
  for (const [task, arms] of Object.entries(summary.tasks)) for (const [arm, total] of Object.entries(arms)) lines.push(`| ${task} | ${arm} | ${row(total).join(" | ")} |`);
  lines.push("", "## Units", "");
  for (const unit of units) {
    const c = unit.correctness, p = unit.process;
    lines.push(`### ${unit.id} (${unit.layout}${unit.mode ? `, ${unit.mode}` : ""}${unit.runtime ? `, runtime ${unit.runtime}` : ""})`);
    lines.push(`- task fixture ${unit.fixture} · snapshot ${unit.snapshot}`);
    lines.push(`- analysts: ${unit.analysts.map(item => `${item.id} ${item.name} (${item.orchestrator} round ${item.round}, ${item.status}${item.source ? `, ${item.source}` : ""}${item.transcript === "differs" ? ", transcript differs" : ""}): ${item.locations.length} location(s)`).join("; ") || "none"}${unit.basis.length ? ` · protected basis: ${unit.basis.join(", ")}` : ""}`);
    const decisive = unit.findings.filter(entry => entry.decisive);
    for (const entry of decisive) lines.push(`- DECISIVE ${loc(entry)} (${entry.orchestrator} round ${entry.round}; analysts ${entry.analysts.map(item => item.id).join(", ")}): ${handoffText(entry)}; final.diff ${entry.diffTouched ? "touches it" : "does not touch it"} — "${entry.analysts[0]?.excerpt ?? ""}"`);
    if (!decisive.length) lines.push("- no decisive finding reported");
    lines.push(`- reference files: ${unit.implementation.reference.map(file => `${file.path} (${file.kind}; ${file.reported ? `reported, ${file.class}` : "not reported"}; diff ${file.touched ? "yes" : "no"})`).join("; ") || "unknown"}`);
    const others = unit.findings.filter(entry => !entry.decisive);
    if (others.length) lines.push(`- other findings (${others.length}; ${FINDING_CLASSES.filter(value => others.some(entry => entry.class === value)).map(value => `${value} ${others.filter(entry => entry.class === value).length}`).join(", ")}): ${others.map(entry => `${entry.path} (${entry.orchestrator} r${entry.round}) ${entry.class}`).join(", ")}`);
    for (const call of unit.candidates) lines.push(`- candidates ${call.ref} ${call.status}${call.at ? ` at ${call.at}` : ""}: ${call.workers.map(worker => `${worker.id ?? worker.name} ${worker.name}${worker.from ? ` from ${worker.from}` : ""} [files ${worker.files.join(", ") || "none"}; request names ${worker.requestPaths?.length ? worker.requestPaths.join(", ") : "no snapshot file"}]`).join("; ")}${call.reference.length ? ` · reference ${call.reference.map(item => `${item.path ?? "?"} (${item.reason ?? "no reason"}${item.grounded ? "" : ", ungrounded"})`).join(", ")}` : ""}${call.excluded.length ? ` · excluded ${call.excluded.map(item => `${item.path ?? "?"} (${item.reason ?? "no reason"}${item.grounded ? "" : ", ungrounded"})`).join(", ")}` : ""}${call.scope ? ` · write scope ${call.scope.join(", ")}` : ""}${call.refused?.length ? ` · refused for ${call.refused.map(item => `${item.path}${item.exploration !== undefined ? ` (round ${item.exploration})` : ""}`).join(", ")}` : ""}${call.message ? ` · message: ${clip(call.message.replace(/\s+/g, " "), 400)}` : ""}`);
    const rt = unit.handoffRecord;
    if (rt.events) lines.push(`- runtime hand-off record: ${rt.events} event(s), ${rt.findings.length} captured finding(s); dispositions ${Object.entries(rt.dispositions).map(([key, item]) => `${key} ${item.disposition}`).join(", ") || "none"}${rt.refused.length ? `; refused for ${rt.refused.join(", ")}` : ""}${rt.errors.length ? `; scan errors: ${rt.errors.join("; ")}` : ""}${rt.agreement && (rt.agreement.analysisOnly.length || rt.agreement.runtimeOnly.length) ? `; only this analysis: ${rt.agreement.analysisOnly.join(", ") || "none"}; only the runtime: ${rt.agreement.runtimeOnly.join(", ") || "none"}` : "; same findings as this analysis"}${rt.agreement?.mismatches.length ? `; DISPOSITION MISMATCHES: ${rt.agreement.mismatches.join("; ")}` : ""}`);
    const check = (item: TestCheck | undefined) => item ? `${item.passed ? "pass" : "FAIL"}${item.total !== undefined ? ` ${item.passedTests}/${item.total} (${item.failures} failing${item.failing ? `: ${clip(item.failing.join("; "), 300)}` : ""})` : ""}` : "-";
    lines.push(`- grade ${c.gradePassed ?? "-"}${c.gradeError ? ` (error: ${clip(c.gradeError, 200)})` : ""} · F2P ${check(c.failToPass)} · P2P ${check(c.passToPass)} · integrity violations ${c.integrityViolations.length}${c.integrityViolations.length ? `: ${c.integrityViolations.join("; ")}` : ""}`);
    lines.push(`- terminal ${p.terminal ?? "-"} · primary ${p.primaryPass} · ${p.requests ?? "?"} requests · USD ${p.costUSD ?? "n/a"} · ${p.wallMinutes ?? "?"} min · orche assignments ${p.assignments} (carried ${p.carried}, continuations ${p.continuations})`, "");
  }
  const skipped = summary.units.filter(unit => unit.error || unit.status);
  if (skipped.length) lines.push("## Not measured", "", ...skipped.map(unit => `- ${unit.id}: ${unit.error ?? `status ${unit.status}`}`), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------
// The study directory

/** Unit directories `runs/<task>/<arm>/r<n>` (kept attempts such as r1.interrupted-1 are not units). */
export function unitDirs(out: string): string[] {
  const runs = join(out, "runs");
  const dirs = (path: string) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
  return dirs(runs).flatMap(task => dirs(join(runs, task)).flatMap(arm => dirs(join(runs, task, arm)).filter(name => /^r\d+$/.test(name)).map(name => join(runs, task, arm, name)))).filter(dir => existsSync(join(dir, "meta.json")));
}

const writeAtomic = async (file: string, value: unknown) => { await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`); await rename(`${file}.tmp`, file); };

/** Study directories whose outputs are frozen (repository-relative): chain.ts never writes into them. Round 1's stage 3 stays as reported. */
export const FROZEN_OUTPUTS: readonly string[] = ["results/ultra-ho/stage3"];
/** `path` with the links of its existing part resolved (lexical below the first missing directory). */
function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) { tail.unshift(basename(head)); head = dirname(head); }
  try { head = realpathSync(head); } catch { /* as written */ }
  return join(head, ...tail);
}
/** Refuses a write destination at or inside a frozen study directory (`frozen`: repository-relative or absolute), also through a link. */
export function assertWritable(dest: string, frozen: readonly string[] = FROZEN_OUTPUTS, repo = REPO): void {
  for (const item of frozen) {
    const root = resolve(repo, item);
    if (isInside(root, resolve(dest)) || isInside(realish(root), realish(dest))) throw new Error(`${dest} is inside ${item}, whose outputs are frozen (round 1 stays as reported): write the analysis elsewhere (--dest <dir>)`);
  }
}

/**
 * Every completed unit of `out`: <dest>/runs/<unit>/chain.json, then <dest>/chain.json (totals per arm and task) and <dest>/chain.md;
 * `dest` defaults to `out` and is never a frozen study directory (FROZEN_OUTPUTS, checked before anything is read or written).
 * `task` resolves a task id to its snapshot and gold directory (default: the unit's own fixture root, `unitTask`; tests pass synthetic tasks).
 */
export async function writeChains(outInput: string, options: { task?: (id: string) => TaskSource | Promise<TaskSource>; dest?: string; frozen?: readonly string[] } = {}): Promise<{ summary: ChainSummary; text: string; dest: string }> {
  const out = resolveOut(outInput);
  const dest = resolveOut(options.dest ?? outInput);
  assertWritable(dest, options.frozen);
  const units: UnitChain[] = [];
  const skipped: { id: string; task: string; arm: string; status?: string; error?: string }[] = [];
  for (const dir of unitDirs(out)) {
    const meta = readJson(join(dir, "meta.json")) ?? {};
    const id = String(meta.unit ?? relative(join(out, "runs"), dir)), task = String(meta.task ?? ""), arm = String(meta.arm ?? meta.condition ?? "?");
    if (meta.status !== "completed") { skipped.push({ id, task, arm, status: String(meta.status ?? "unknown") }); continue; }
    try {
      const unit = await unitChain(dir, options.task ? { task: await options.task(task) } : {});
      const target = join(dest, relative(out, dir), "chain.json");
      await mkdir(dirname(target), { recursive: true });
      await writeAtomic(target, unit);
      units.push(unit);
    } catch (error) { skipped.push({ id, task, arm, error: String(error instanceof Error ? error.message : error).slice(0, 500) }); }
  }
  const summary = summarizeChains(out, units, skipped);
  const text = formatChains(summary, units);
  await mkdir(dest, { recursive: true });
  await writeAtomic(join(dest, "chain.json"), summary);
  await writeFile(join(dest, "chain.md"), `${text}\n`);
  return { summary, text, dest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--dest");
  const dest = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0) args.splice(at, 2);
  const [out] = args;
  if (!out || at >= 0 && !dest) { console.error("usage: node --import tsx experiments/ultra-ho/chain.ts <out dir> [--dest <dir>]"); process.exit(2); }
  const { summary, dest: written } = await writeChains(out, dest ? { dest } : {});
  for (const [arm, total] of Object.entries(summary.arms)) console.log(`${arm}: ${total.units} unit(s), reported decisive ${total.reportedDecisive}, decisive findings ${FINDING_CLASSES.map(value => `${value} ${total.decisiveFindings[value]}`).join(", ")} of ${total.decisiveFindings.total}, gate-transferred ${total.decisiveFindings.gateTransferred}, diff touched every decisive file ${total.diffTouchedDecisive}, F2P pass ${total.f2pPassed}, P2P regressions ${total.p2pRegressions}, not done ${total.terminalNonDone}, primary ${total.primaryPass}`);
  for (const unit of summary.units.filter(unit => unit.error)) console.error(`${unit.id}: ${unit.error}`);
  console.log(join(written, "chain.md"));
}
