/**
 * Risk score of an implement result (docs/specialist-orchestration.md 5.3): decides whether the Verifier runs. A pure function of
 * the change (files, line counts, diff text), the worker's checklist and the Framer's contract; no LLM call.
 */
import type { ChecklistItem } from "../orchestration/result-schemas.js";

export interface RiskSignal { name: string; points: number; detail?: string }
export interface RiskFile { path: string; added: number; removed: number; binary?: boolean }
export interface RiskInput {
  /** Files the worker changed, with line counts. */
  files: readonly RiskFile[];
  /** Unified diff of those files (domain patterns are matched on its changed source lines). */
  diff: string;
  checklist?: readonly ChecklistItem[];
  /** Requirement kinds from the Framer's contract (edge requirements count when they lack a passing check). */
  requirements?: readonly { id: string; kind: string }[];
  /** Ambiguities settled by the recommended reading rather than by the user. */
  recommendedReadings?: number;
  /** The user's original request (a review or verification request forces the check). */
  original?: string;
}
export type RiskDecision = "verify" | "skip";
export interface RiskAssessment {
  score: number;
  threshold: number;
  decision: RiskDecision;
  /** Why: `threshold`, `forced: review requested`, `forced: gate always`, `skipped: docs only`, `skipped: small verified change`, `below threshold`, `gate off`. */
  reason: string;
  signals: RiskSignal[];
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|(^|\/)test_[^/]*\.py$|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|(^|\/)conftest\.py$/i;
const DOC_FILE = /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(README|CHANGELOG|LICENSE|NOTICE)[^/]*$/i;
export const isTestFile = (path: string): boolean => TEST_FILE.test(path);
export const isDocFile = (path: string): boolean => DOC_FILE.test(path) && !TEST_FILE.test(path);

/**
 * Domains where a plausible-looking change is often wrong (the list of docs/specialist-orchestration.md 5.3), matched on changed
 * source lines. Crude on purpose: a domain only adds points, the threshold decides.
 */
export const RISK_DOMAINS: readonly { name: string; test: (text: string) => boolean }[] = [
  { name: "concurrency", test: text => /\b(mutex|semaphore|atomic\w*|race|concurren\w*|Promise\.(all|race|any|allSettled)|threading|asyncio|goroutine|Mutex|RwLock|Arc<|sync\.(Mutex|WaitGroup)|lock(ed|ing)?)\b/.test(text) },
  { name: "transactions/persistence", test: text => /\b(transaction\w*|rollback|commit\w*|migrat\w*|persist\w*|fsync|idempoten\w*)\b/i.test(text) || /\b(BEGIN|SAVEPOINT|INSERT INTO|DELETE FROM|UPDATE \w+ SET)\b/.test(text) },
  { name: "auth/security", test: text => /\b(auth\w*|password|secret|permission\w*|credential\w*|csrf|xss|sanitiz\w*|crypto|hmac|jwt|oauth)\b/i.test(text) },
  { name: "paths", test: text => /\b(path\.(join|resolve|normalize|relative)|realpath\w*|symlink\w*|readlink|os\.path|PathBuf|traversal)\b|\.\.\//.test(text) },
  { name: "money/rounding", test: text => /\b(price|amount|money|currenc\w*|cents?|round(ed|ing)?|toFixed|decimal|tax|discount|refund)\b/i.test(text) },
  { name: "cache invalidation", test: text => /\b(cache\w*|invalidat\w*|ttl|evict\w*)\b/i.test(text) },
  { name: "parsing/encoding", test: text => /\b(encod\w*|decod\w*|utf-?8|base64|serializ\w*|deserializ\w*|unescape|escape|charset|JSON\.parse|Date\.parse|toISOString|timezone)\b/i.test(text) },
];

const REVIEW_REQUEST = /\b(review|verify|verification|double[- ]check|audit|scrutini[sz]e)\b|검토|검증|리뷰|확인해\s*줘|점검/i;
export const asksForReview = (text: string | undefined): boolean => !!text && REVIEW_REQUEST.test(text);

/** Changed (+/-) lines of non-test, non-doc files in a unified diff. */
function changedSourceLines(diff: string): string[] {
  const lines: string[] = [];
  let source = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = /^diff --git a\/(.*?) b\//.exec(line)?.[1] ?? "";
      source = !isTestFile(path) && !isDocFile(path);
      continue;
    }
    if (!source || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) lines.push(line.slice(1));
  }
  return lines;
}

export interface RiskOptions { threshold: number; gate: "auto" | "always" | "off" }

export function assessRisk(input: RiskInput, options: RiskOptions): RiskAssessment {
  const signals: RiskSignal[] = [];
  const add = (name: string, points: number, detail?: string) => { if (points > 0) signals.push({ name, points, ...(detail ? { detail } : {}) }); };
  const files = input.files;
  const source = files.filter(file => !isTestFile(file.path) && !isDocFile(file.path));
  const tests = files.filter(file => isTestFile(file.path));
  const changedLines = files.reduce((sum, file) => sum + file.added + file.removed, 0);
  const nonDoc = files.filter(file => !isDocFile(file.path));
  if (nonDoc.length >= 3) add("files", 2, `${nonDoc.length} files`);
  const topDirs = new Set(source.map(file => file.path.includes("/") ? file.path.split("/")[0]! : "."));
  if (topDirs.size >= 2) add("top-level directories", 2, [...topDirs].join(", "));
  const lines = changedSourceLines(input.diff).join("\n");
  const domains = RISK_DOMAINS.filter(domain => domain.test(lines)).slice(0, 2);
  for (const domain of domains) add(domain.name, 2);
  if (source.length && !tests.length) add("source changed without test changes", 2);
  const checklist = input.checklist ?? [];
  const unverified = checklist.filter(item => item.status === "met" && !item.verifiedBy?.trim());
  if (unverified.length) add("met without verifiedBy", 2, unverified.map(item => item.id).join(", "));
  const edges = (input.requirements ?? []).filter(item => item.kind === "edge").map(item => item.id);
  const untestedEdges = edges.filter(id => { const item = checklist.find(entry => entry.id === id); return !item || item.status !== "met" || !item.verifiedBy?.trim(); });
  add("edge cases without a passing test", Math.min(3, untestedEdges.length), untestedEdges.join(", "));
  add("ambiguities settled by recommendation", Math.min(2, input.recommendedReadings ?? 0));
  if (changedLines >= 150) add("lines changed", 2, `${changedLines} lines`);
  const score = signals.reduce((sum, signal) => sum + signal.points, 0);
  const base = { score, threshold: options.threshold, signals };
  if (options.gate === "off") return { ...base, decision: "skip", reason: "gate off" };
  if (options.gate === "always") return { ...base, decision: "verify", reason: "forced: gate always" };
  if (asksForReview(input.original)) return { ...base, decision: "verify", reason: "forced: review requested" };
  if (!files.length) return { ...base, decision: "skip", reason: "skipped: no changes" };
  if (files.every(file => isDocFile(file.path))) return { ...base, decision: "skip", reason: "skipped: docs only" };
  const allVerified = checklist.length > 0 && checklist.every(item => item.status === "met" && !!item.verifiedBy?.trim());
  if (files.length === 1 && changedLines <= 10 && allVerified) return { ...base, decision: "skip", reason: "skipped: small verified change" };
  return score >= options.threshold ? { ...base, decision: "verify", reason: "threshold" } : { ...base, decision: "skip", reason: "below threshold" };
}

export function formatRisk(risk: RiskAssessment): string {
  const signals = risk.signals.map(signal => `${signal.name}${signal.detail ? ` (${signal.detail})` : ""} +${signal.points}`).join(", ") || "no signals";
  const verdict = risk.decision === "verify" ? "verify" : "no verification";
  const why = risk.reason === "threshold" ? `${risk.score} ≥ ${risk.threshold}` : risk.reason === "below threshold" ? `${risk.score} < ${risk.threshold}` : `${risk.score}; ${risk.reason}`;
  return `Risk ${why} → ${verdict} (${signals})`;
}
