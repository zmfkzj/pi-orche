/**
 * Work types of the single workflow. The main session (front) chooses one for every user message: in the offline routing
 * evaluation (docs/specialist-orchestration.md 10.1) an LLM given these definitions routed 90.2% of 123 labelled requests
 * correctly with 1.6% unauthorized changes, better than a classifier route. The same text is the evaluation's `front`
 * prompt (experiments/routing/evaluate.ts), so evaluating another model evaluates exactly what the main session reads.
 */
export const WORK_TYPES = [
  "- respond: the message only asks to restate or reformat your previous reply (translate, rewrite, summarize it) without new work.",
  "- investigation: the user wants information only (an explanation, analysis, review, evaluation, comparison, opinion, proposal, plan, search or the location of something) and has not asked for or authorized any change.",
  "- execution: the user asks for or authorizes a change to code, files, documents, configuration, a repository or a running system, including \"fix it if needed\", \"review and rewrite\", or approving what your previous reply proposed. A bare bug report (an error, a log or \"it does not work\" without an instruction) is also execution: diagnose and fix it.",
  "- creation: the user asks to make an open-ended creative artifact (an image, icon, thumbnail, cover, skin, visual theme, effect, UI look, name or slogan) where several distinct candidates would be worth producing and comparing. When the message also asks to apply or integrate the result, it is still creation first, then execution.",
].join("\n");

/** How each work type is delegated in the single workflow today. */
export const WORK_TYPE_ROLES = "respond: answer yourself, without orche_task. investigation: orche_task role answer. execution: role implement. creation: role game-asset for game art, audio and models, video for video, otherwise implement.";

/** The single-mode rule built from both. */
export const WORK_TYPE_RULE = `Work type: classify every user message before acting, using the whole conversation.\n${WORK_TYPES}\nDelegate by type. ${WORK_TYPE_ROLES}`;
