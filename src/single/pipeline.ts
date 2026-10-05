/**
 * The specialist calls of the single workflow's v2 pipeline (docs/specialist-orchestration.md, Phase 3): the Framer before an
 * implement assignment and the Verifier after a risky result. Both are one-shot sessions (src/specialists/session.ts) on the
 * route the worker uses (the main model and thinking unless `routes.framer` / `routes.checker` are configured).
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelRoute, RouteConfig } from "../orchestration/routing.js";
import { resolveRoute } from "../orchestration/routing.js";
import { READ_ONLY_TOOL_NAMES } from "../tools/index.js";
import { createCodeNavTool } from "../tools/code-nav.js";
import { runSpecialistSession, type SpecialistOutcome } from "../specialists/session.js";
import { checkFrame, frameSchema, FRAMER_INSTRUCTIONS, framerPrompt, type Frame, type FramerInput } from "./frame.js";
import { checkReport, checkSchema, VERIFIER_INSTRUCTIONS, verifierGuard, verifierPrompt, type Check, type VerifierInput } from "./check.js";
import { checkCritique, CRITIC_INSTRUCTIONS, criticPrompt, critiqueSchema, type Critique, type CriticInput } from "../workflow/critique.js";
import { checkSelection, selectionSchema, SELECTOR_INSTRUCTIONS, selectorPrompt, type Selection, type SelectorInput } from "../workflow/divergence.js";

export const SPECIALIST_LIMITS = {
  framer: { grounded: { maxTurns: 16, timeoutMs: 6 * 60_000 }, spec: { maxTurns: 3, timeoutMs: 3 * 60_000 } },
  checker: { maxTurns: 40, timeoutMs: 15 * 60_000 },
  critic: { maxTurns: 24, timeoutMs: 8 * 60_000 },
} as const;

export interface SpecialistContext {
  runtime: ModelRuntime;
  cwd: string;
  signal: AbortSignal;
  /** The worker's route: the specialist uses it unless a route for its role is configured. */
  workerRoute: ModelRoute;
  routes: RouteConfig;
  /** Give the specialist the code_nav tool (single.nav). */
  nav?: boolean;
  inheritedContextWindow?: number;
  sessionFile?: string;
  onTool?: (name: string) => void;
}

/** `routes.<role>` when configured, else the worker's model and thinking (normally the main session's). The answer and creation critics share `routes.critic`. */
export function specialistRoute(role: "framer" | "checker" | "critic", routes: RouteConfig, workerRoute: ModelRoute): ModelRoute {
  if (Object.hasOwn(routes.routes, role)) return resolveRoute(routes, role);
  return { ...workerRoute, role };
}

export function runFramer(ctx: SpecialistContext, input: FramerInput & { actor: string }): Promise<SpecialistOutcome<Frame>> {
  const route = specialistRoute("framer", ctx.routes, ctx.workerRoute);
  const limits = input.grounded ? SPECIALIST_LIMITS.framer.grounded : SPECIALIST_LIMITS.framer.spec;
  return runSpecialistSession({
    actor: input.actor, route, runtime: ctx.runtime, cwd: ctx.cwd, signal: ctx.signal,
    instructions: FRAMER_INSTRUCTIONS, prompt: framerPrompt(input),
    tools: input.grounded ? [...READ_ONLY_TOOL_NAMES, ...(ctx.nav ? ["code_nav"] : [])] : [],
    ...(input.grounded && ctx.nav ? { customTools: [createCodeNavTool(ctx.cwd)] } : {}),
    report: {
      name: "report_frame", label: "Report frame",
      description: "Submit the task contract once: goal, requirements (explicit, implied, edge) with acceptance, ambiguities with the recommended reading, invariants, locations.",
      parameters: frameSchema, check: frame => checkFrame(frame, input.request),
    },
    maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMs,
    ...(ctx.inheritedContextWindow && !Object.hasOwn(ctx.routes.routes, "framer") ? { inheritedContextWindow: ctx.inheritedContextWindow } : {}),
    ...(ctx.sessionFile ? { sessionFile: ctx.sessionFile } : {}),
    ...(ctx.onTool ? { onTool: ctx.onTool } : {}),
  });
}

export function runVerifier(ctx: SpecialistContext, input: VerifierInput & { actor: string }): Promise<SpecialistOutcome<Check>> {
  const route = specialistRoute("checker", ctx.routes, ctx.workerRoute);
  return runSpecialistSession({
    actor: input.actor, route, runtime: ctx.runtime, cwd: ctx.cwd, signal: ctx.signal,
    instructions: VERIFIER_INSTRUCTIONS, prompt: verifierPrompt(input),
    tools: [...READ_ONLY_TOOL_NAMES, "bash", "write", "edit", ...(ctx.nav ? ["code_nav"] : [])],
    ...(ctx.nav ? { customTools: [createCodeNavTool(ctx.cwd)] } : {}),
    toolGuard: verifierGuard(ctx.cwd, input.scratch),
    report: {
      name: "report_check", label: "Report check",
      description: "Submit the verification once: verdict, requirement trace, findings (blocking ones with probe or quote), the project checks you ran.",
      parameters: checkSchema, check: check => checkReport(check, input.scratch),
    },
    maxTurns: SPECIALIST_LIMITS.checker.maxTurns, timeoutMs: SPECIALIST_LIMITS.checker.timeoutMs,
    ...(ctx.inheritedContextWindow && !Object.hasOwn(ctx.routes.routes, "checker") ? { inheritedContextWindow: ctx.inheritedContextWindow } : {}),
    ...(ctx.sessionFile ? { sessionFile: ctx.sessionFile } : {}),
    ...(ctx.onTool ? { onTool: ctx.onTool } : {}),
  });
}

/** The investigation policy's Critic: read-only, one critique of an answer it did not write (src/workflow/critique.ts). */
export function runCritic(ctx: SpecialistContext, input: CriticInput & { actor: string }): Promise<SpecialistOutcome<Critique>> {
  const route = specialistRoute("critic", ctx.routes, ctx.workerRoute);
  return runSpecialistSession({
    actor: input.actor, route, runtime: ctx.runtime, cwd: ctx.cwd, signal: ctx.signal,
    instructions: CRITIC_INSTRUCTIONS, prompt: criticPrompt(input),
    tools: [...READ_ONLY_TOOL_NAMES, ...(ctx.nav ? ["code_nav"] : [])],
    ...(ctx.nav ? { customTools: [createCodeNavTool(ctx.cwd)] } : {}),
    report: {
      name: "report_critique", label: "Report critique",
      description: "Submit the critique once: verdict and at most six findings (material ones with located evidence).",
      parameters: critiqueSchema, check: critiqueValue => checkCritique(critiqueValue),
    },
    maxTurns: SPECIALIST_LIMITS.critic.maxTurns, timeoutMs: SPECIALIST_LIMITS.critic.timeoutMs,
    ...(ctx.inheritedContextWindow && !Object.hasOwn(ctx.routes.routes, "critic") ? { inheritedContextWindow: ctx.inheritedContextWindow } : {}),
    ...(ctx.sessionFile ? { sessionFile: ctx.sessionFile } : {}),
    ...(ctx.onTool ? { onTool: ctx.onTool } : {}),
  });
}

/** The creation policy's Critic: read-only (images through read), scores blind candidates and selects one (src/workflow/divergence.ts). */
export function runSelector(ctx: SpecialistContext, input: SelectorInput & { actor: string }): Promise<SpecialistOutcome<Selection>> {
  const route = specialistRoute("critic", ctx.routes, ctx.workerRoute);
  return runSpecialistSession({
    actor: input.actor, route, runtime: ctx.runtime, cwd: ctx.cwd, signal: ctx.signal,
    instructions: SELECTOR_INSTRUCTIONS, prompt: selectorPrompt(input),
    tools: [...READ_ONLY_TOOL_NAMES],
    report: {
      name: "report_selection", label: "Report selection",
      description: "Submit the comparison once: scores per candidate label, the selected label, refinements, what to borrow.",
      parameters: selectionSchema, check: selection => checkSelection(selection, input.presented.length),
    },
    maxTurns: SPECIALIST_LIMITS.critic.maxTurns, timeoutMs: SPECIALIST_LIMITS.critic.timeoutMs,
    ...(ctx.inheritedContextWindow && !Object.hasOwn(ctx.routes.routes, "critic") ? { inheritedContextWindow: ctx.inheritedContextWindow } : {}),
    ...(ctx.sessionFile ? { sessionFile: ctx.sessionFile } : {}),
    ...(ctx.onTool ? { onTool: ctx.onTool } : {}),
  });
}
