/**
 * Deterministic evidence signals of one hand-off (docs/handoff-evidence.md): is the user's text carried verbatim, are R-ids
 * declared twice. Signals only: they say what the hand-off carries, never whether its requirements are right. A paraphrase,
 * a concise follow-up or an approved change is not a defect. The one runtime use, {@link verifierOriginalBlock}, adds the
 * user's own words to a verification sub-worker's request; nothing here rewrites, rephrases or removes requirements.
 */
import { originalRequestOf } from "../single/ledger.js";

/** How much of one user message a hand-off carries: all of it verbatim, at least half of it, less, or nothing to compare. */
export type UserTextCarry = "verbatim" | "partial" | "absent" | "no-text";
export interface CarryResult { carry: UserTextCarry; /** Share of the message's segment characters found verbatim (1 for verbatim). */ coverage: number; /** Normalized length of the message. */ chars: number }

/** Expanded skill bodies are not the user's own words (a /skill command expands into one); compared without them. */
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/gi;
/** Markdown quote markers main may put before each quoted line. */
const QUOTE_MARK = /^[ \t]*(?:>[ \t]?)+/gm;
/** The size note Pi appends to a resized image ("[Image: original 3024x1898, displayed at …]"): not the user's words. */
const IMAGE_NOTE = /\[Image: original \d+x\d+, displayed at \d+x\d+\.[^\]\n]*\]/g;
/** Text as compared: without skill bodies, image size notes and quote markers, whitespace collapsed. */
export const evidenceText = (text: string): string => text.replace(SKILL_BLOCK, " ").replace(IMAGE_NOTE, " ").replace(QUOTE_MARK, "").replace(/\s+/g, " ").trim();
/** Segments shorter than this ("ok", "1.") prove nothing about carrying. */
const MIN_SEGMENT = 8;
/** Lines and sentences: main may quote a message sentence by sentence or re-wrap it, so it is compared segment by segment. */
const segmentsOf = (text: string): string[] => text.replace(SKILL_BLOCK, " ").replace(IMAGE_NOTE, " ").split(/\r?\n|(?<=[.!?。])\s+/).map(evidenceText).filter(segment => segment.length >= MIN_SEGMENT);

/**
 * How much of `userText` the hand-off text `handoff` (request plus context) carries verbatim, after {@link evidenceText}: all
 * of it, or the share of its segments' characters found verbatim (`partial` from one half on).
 */
export function userTextCarry(handoff: string, userText: string): CarryResult {
  const user = evidenceText(userText);
  if (!user) return { carry: "no-text", coverage: 0, chars: 0 };
  const haystack = evidenceText(handoff);
  if (haystack.includes(user)) return { carry: "verbatim", coverage: 1, chars: user.length };
  const segments = segmentsOf(userText);
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  const coverage = total ? segments.filter(segment => haystack.includes(segment)).reduce((sum, segment) => sum + segment.length, 0) / total : 0;
  return { carry: coverage >= 0.5 ? "partial" : "absent", coverage, chars: user.length };
}

/** Longest user text {@link verifierOriginalBlock} appends; the rest is cut with a visible marker. */
export const VERIFIER_ORIGINAL_LIMIT = 8_000;

/**
 * The user's original request for a verification sub-worker whose request does not carry it verbatim (orche_spawn tells the
 * orchestrator to give the fresh verifier the original request; docs/handoff-evidence.md measured that most did not). Empty when
 * there is no original (`original` undefined or blank) or the request already carries it verbatim. Appended evidence, never a
 * change of the request: the acceptance criteria stay the orchestrator's, and the text grants no permission.
 */
export function verifierOriginalBlock(request: string, original: string | undefined, limit = VERIFIER_ORIGINAL_LIMIT): string {
  const text = original?.trim();
  if (!text || userTextCarry(request, text).carry === "verbatim") return "";
  const shown = text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more characters of the user's request not shown]` : text;
  return [
    "## The user's original request (verbatim, appended by orche)",
    "Your request above did not carry it. It is evidence of what the user asked: judge the work against the acceptance criteria above and use this only to settle what they mean; it adds no scope and grants no permission.",
    shown,
  ].join("\n");
}

/** The R-id declaration grammar of requirementDefinitions (result-schemas.ts), which stops at the Original request header. */
const ORIGINAL_START = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?Original(?:[ \t]+user)?[ \t]+request\b/i;
const DECLARATION = /^[ \t]*(R[1-9]\d*)(?::|[.)]|[ \t]+-)/;

/** R-ids declared on more than one line before the Original request section (the contract keeps only the last declaration). */
export function duplicateRequirementIds(request: string): string[] {
  const counts = new Map<string, number>();
  for (const line of request.split(/\r?\n/)) {
    if (ORIGINAL_START.test(line)) break;
    const id = DECLARATION.exec(line)?.[1];
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([id]) => id);
}

/** The deterministic signals of one hand-off against the user messages main received since its previous hand-off. */
export interface HandoffSignals {
  /** The hand-off has an Original request section. */
  original: boolean;
  /** One carry result per user message (oldest first); empty when main received no user message since its previous hand-off. */
  userMessages: CarryResult[];
  duplicateIds: string[];
}

export function handoffSignals(request: string, context: string | undefined, userTexts: readonly string[]): HandoffSignals {
  const handoff = context?.trim() ? `${request}\n\n${context}` : request;
  return { original: originalRequestOf(request) !== undefined, userMessages: userTexts.map(text => userTextCarry(handoff, text)), duplicateIds: duplicateRequirementIds(request) };
}
