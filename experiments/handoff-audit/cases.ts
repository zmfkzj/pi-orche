/**
 * Synthetic evaluation cases for hand-off evidence policies (docs/handoff-evidence.md). SYNTHETIC: each case is written by hand
 * with a ground-truth label; none is an observed failure, and the rates below describe these cases only, not real sessions.
 *
 * Policies compared:
 *  - current: no check at all (every case passes through unflagged);
 *  - deterministic: the signals of handoffSignals (newest user message not verbatim, an earlier one absent, duplicate R-ids);
 *  - semantic detection and detection+fix: NOT RUN. No model experiment was made; their rows say so instead of carrying numbers.
 */
import { handoffSignals } from "../../src/orchestration/handoff-evidence.js";

export type Truth = "loss" | "no-loss" | "unverifiable";
export interface EvaluationCase {
  id: string;
  situation: "first" | "follow-up" | "handover" | "replacement" | "post-main-compaction" | "sub-worker";
  /** User messages main received since its previous hand-off, oldest first (empty: main delegated on its own). */
  userMessages: string[];
  request: string;
  context?: string;
  truth: Truth;
  /** Why the label is what it is, and what a detector would need to know. */
  why: string;
}

const original = (text: string) => `\nOriginal request:\n${text}`;
const points = (count: number) => Array.from({ length: count }, (_, index) => `Point ${index + 1}: a separate claim to check in detail.`).join("\n");

export const CASES: readonly EvaluationCase[] = [
  { id: "verbatim-first", situation: "first", userMessages: ["Improve recall of the detector. Keep precision at least 50%."],
    request: `Intent: raise recall.\nR1: Recall improves on the validation set.\nR2: Precision stays at least 50%.${original("Improve recall of the detector. Keep precision at least 50%.")}`,
    truth: "no-loss", why: "The user's text is carried verbatim and the R-lines match it." },
  { id: "omitted-constraint", situation: "first", userMessages: ["Improve recall of the detector. Keep precision at least 50%."],
    request: `Intent: raise recall.\nR1: Recall improves on the validation set.${original("Improve recall of the detector.")}`,
    truth: "loss", why: "The precision constraint is gone from the R-lines and from the quoted text." },
  { id: "valid-paraphrase", situation: "first", userMessages: ["검출기 재현율을 올려줘. 정밀도는 50% 이상 유지."],
    request: "Intent: raise the detector's recall.\nR1: Recall improves on the validation set.\nR2: Precision stays at least 50%.\nOriginal request (translated): Raise the detector's recall; keep precision at 50% or more.",
    truth: "no-loss", why: "A faithful translation: nothing is lost, yet no sentence is verbatim." },
  { id: "follow-up-no-new-text", situation: "follow-up", userMessages: [],
    request: "R1: Re-run the failing test and report its output.",
    truth: "no-loss", why: "Main continued on its own after a result; there is no new user text to carry." },
  { id: "concise-follow-up", situation: "follow-up", userMessages: ["Also cover the empty-input case."],
    request: `R3: Empty input returns an empty list.${original("Also cover the empty-input case.")}`,
    truth: "no-loss", why: "A live worker keeps the earlier requirements; the follow-up rightly sends only what is new." },
  { id: "approved-retraction", situation: "follow-up", userMessages: ["Keep precision at least 50%.", "Actually drop the precision constraint, recall matters more."],
    request: `R2 (revised): No precision floor; maximize recall.${original("Actually drop the precision constraint, recall matters more.")}`,
    truth: "no-loss", why: "The user withdrew the earlier constraint; restoring it would be the harmful fix." },
  { id: "earlier-constraint-lost", situation: "follow-up", userMessages: ["Also keep precision at least 50% while you do it.", "Go ahead."],
    request: `R2: Proceed with the recall change.${original("Go ahead.")}`,
    truth: "loss", why: "The constraint in the earlier message reached neither the hand-off nor the worker." },
  { id: "distorted-r-line", situation: "first", userMessages: ["Keep precision at least 50%."],
    request: `R1: Precision around 50% is fine.${original("Keep precision at least 50%.")}`,
    truth: "loss", why: "The quote is verbatim but the R-line weakens it; only a semantic comparison sees the distortion (the worker is told the original prevails)." },
  { id: "image-only", situation: "first", userMessages: [""],
    request: "R1: Explain the error in the attached screenshot.",
    truth: "unverifiable", why: "The message has no text; what the image asked cannot be compared." },
  { id: "truncated-paste", situation: "first", userMessages: [`Review this proposal.\n${points(30)}`],
    request: `R1: Review the proposal's claims.${original(`Review this proposal.\n${points(12)}\n[…]`)}`,
    truth: "unverifiable", why: "Main quoted the start of a long paste; whether the cut points mattered needs their content." },
  { id: "handover-concise", situation: "handover", userMessages: ["Continue where W2 stopped."],
    request: `R1: Finish the migration W2 started.${original("Continue where W2 stopped.")}`,
    truth: "no-loss", why: "The successor is briefed from W2's transcript (renderHandover); the hand-off may stay concise." },
  { id: "replacement-after-unmet", situation: "replacement", userMessages: [],
    request: "Intent: finish what W1 left unmet.\nR1: The flaky test passes 20 runs in a row.",
    truth: "unverifiable", why: "Main hands only the unmet items to a new worker; whether it carried their constraints depends on W1's earlier hand-offs." },
  { id: "post-main-compaction", situation: "post-main-compaction", userMessages: ["Ship it with the 50% precision floor we agreed on."],
    request: `R1: Release the recall change with the precision floor.${original("Ship it with the precision floor we agreed on.")}`,
    truth: "loss", why: "Main wrote from its compaction summary and dropped the number the user restated." },
  { id: "verifier-without-original", situation: "sub-worker", userMessages: ["Keep precision at least 50%."],
    request: "Verify that recall improved and the tests pass.",
    truth: "loss", why: "The verifier never sees the precision floor; orche now appends the orchestrator's Original request (verifierOriginalBlock)." },
];

/** Whether the deterministic policy flags a case: newest message not verbatim, an earlier one absent, or a duplicate R-id. */
export function deterministicFlag(item: EvaluationCase): boolean {
  const signals = handoffSignals(item.request, item.context, item.userMessages);
  const latest = signals.userMessages.at(-1);
  return !!latest && (latest.carry === "absent" || latest.carry === "partial")
    || signals.userMessages.slice(0, -1).some(entry => entry.carry === "absent")
    || signals.duplicateIds.length > 0;
}

export interface PolicyResult { policy: string; status: "run" | "not-run"; truePositive?: number; falsePositive?: number; falseNegative?: number; trueNegative?: number; flaggedUnverifiable?: number; unverifiable?: number; note?: string }

/** The comparison over {@link CASES}: decided cases (loss / no-loss) form the confusion matrix; unverifiable ones are counted apart. */
export function evaluatePolicies(cases: readonly EvaluationCase[] = CASES): PolicyResult[] {
  const tally = (flag: (item: EvaluationCase) => boolean, policy: string): PolicyResult => {
    const result = { policy, status: "run" as const, truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0, flaggedUnverifiable: 0, unverifiable: 0 };
    for (const item of cases) {
      const flagged = flag(item);
      if (item.truth === "unverifiable") { result.unverifiable++; if (flagged) result.flaggedUnverifiable++; }
      else if (item.truth === "loss") { if (flagged) result.truePositive++; else result.falseNegative++; }
      else if (flagged) result.falsePositive++;
      else result.trueNegative++;
    }
    return result;
  };
  return [
    tally(() => false, "current"),
    tally(deterministicFlag, "deterministic"),
    { policy: "semantic-detection", status: "not-run", note: "deferred: no model experiment was run (docs/handoff-evidence.md)" },
    { policy: "detection+fix", status: "not-run", note: "out of scope: automatic fixing, rephrasing or rewriting of requirements is not implemented" },
  ];
}
