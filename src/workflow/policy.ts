/**
 * Work Type → Workflow Policy → Capability sequence → Primary (docs/workflow-policy.md). The front (single-mode main) still classifies
 * every request (src/single/work-types.ts); this module only says, per work type and config, which one-shot capabilities run around the
 * persistent Primary worker. It is a plain sequence with gates, not a graph: `pre` runs before the Primary, `post` after it, each post
 * step only when its gate lets it. Hybrid requests (creation then execution) are consecutive orche_task calls of the front, linked by
 * the result's `Next` line ({@link WorkType} in `then`), not a scheduler.
 *
 * Execution is the existing pipeline renamed: v1 = Primary only, v2 = Framer → Primary → risk-gated Verifier → deterministic recheck.
 * Investigation and creation add one gated capability each (critic; divergent candidates → critic/select → refine), off by default.
 */
import type { SingleSettings } from "../extension/config.js";

export const WORK_TYPES = ["investigation", "execution", "creation"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
/** `refine` is the Primary's second pass on a selected creation candidate; the rest are the capabilities of docs/specialist-orchestration.md 4.1. */
export type Capability = "frame" | "retrieve" | "synthesize" | "execute" | "generate" | "critique" | "verify" | "refine";
/** When a conditional step runs: `auto` decides from the request and the Primary's result, `review` only on an explicit review request. */
export type Gate = "off" | "auto" | "always" | "review";

export interface WorkflowPolicy {
  type: WorkType;
  /** One-shot steps before the Primary (in order). */
  pre: Capability[];
  /** What the persistent Primary worker does. */
  primary: Capability;
  /** Steps after the Primary (in order); each runs only when its gate lets it. */
  post: Capability[];
  gates: Partial<Record<Capability, Gate>>;
  /** Tools the Primary and the specialists get beyond the role's own (retrieve = code_nav). */
  retrieve: { codeNav: boolean };
  /** creation: how many divergent candidates the Primary makes when divergence is on (1 = no divergence). */
  candidates?: number;
}

/** `single.investigation` / `single.creation` in orche.config.json (src/extension/config.ts). Both off by default. */
export interface InvestigationSettings { critic: "off" | "auto" | "always" }
export interface CreationSettings { divergence: "off" | "auto" | "always"; candidates: 2 | 3 }

/** The work type an assignment belongs to: the front's explicit `type`, else what its role implies (none for explore/verify). */
export function workTypeOf(role: string, explicit?: WorkType): WorkType | undefined {
  if (explicit) return explicit;
  if (role === "answer") return "investigation";
  if (role === "implement") return "execution";
  if (role === "game-asset" || role === "video") return "creation";
  return undefined;
}

/** Roles that can carry each work type. `type` that does not fit the role is an argument error (nothing runs). */
const TYPE_ROLES: Readonly<Record<WorkType, readonly string[]>> = {
  investigation: ["answer"],
  execution: ["implement"],
  creation: ["implement", "game-asset", "video"],
};
export function workTypeError(role: string, type: WorkType | undefined): string | undefined {
  if (!type || TYPE_ROLES[type].includes(role)) return undefined;
  return `type ${type} does not fit role ${role}; ${type} uses role ${TYPE_ROLES[type].join(" or ")}.`;
}

/**
 * The policy of one assignment. `requestedCandidates` is the front's `candidates` (used when divergence is `auto`, capped by
 * `creation.candidates`). `standard` says whether the role runs as a standard single-workflow role: only those get the v2 execution
 * pipeline (it needs the task ledger) and, under v2, code_nav.
 */
export function resolvePolicy(type: WorkType, single: SingleSettings, options: { requestedCandidates?: number; standard?: boolean } = {}): WorkflowPolicy {
  const standard = options.standard !== false;
  const retrieve = { codeNav: standard && single.pipeline === "v2" && single.nav };
  if (type === "execution") {
    const v2 = single.pipeline === "v2" && standard;
    return {
      type, primary: "execute", retrieve,
      pre: v2 && single.frame !== "off" ? ["frame"] : [],
      post: v2 ? ["verify"] : [],
      gates: v2 ? { verify: single.checker.gate } : {},
    };
  }
  if (type === "investigation") {
    const critic = single.investigation.critic;
    return {
      type, primary: "synthesize", pre: [], retrieve,
      // The second synthesize is the Primary's answer to the critic's material findings.
      post: critic === "off" ? [] : ["critique", "synthesize"],
      gates: critic === "off" ? {} : { critique: critic },
    };
  }
  const divergence = single.creation.divergence;
  const candidates = divergence === "off" ? 1
    : divergence === "always" ? single.creation.candidates
    : Math.min(Math.max(Math.trunc(options.requestedCandidates ?? 1), 1), single.creation.candidates);
  return {
    type, primary: "generate", pre: [], retrieve,
    post: candidates > 1 ? ["critique", "refine"] : [],
    gates: candidates > 1 ? { critique: divergence } : {},
    candidates,
  };
}

/** One line for results and records, e.g. `Workflow: investigation = synthesize → critique(auto) → synthesize`. */
export function formatPolicy(policy: WorkflowPolicy): string {
  const step = (capability: Capability) => `${capability}${policy.gates[capability] ? `(${policy.gates[capability]})` : ""}`;
  const primary = policy.candidates && policy.candidates > 1 ? `${policy.primary}×${policy.candidates}` : policy.primary;
  return `Workflow: ${policy.type} = ${[...policy.pre.map(step), primary, ...policy.post.map((capability, index) => index === 0 ? step(capability) : capability)].join(" → ")}`;
}
