/**
 * Execution-policy router evaluated for the new single workflow (Phase 2 of docs/specialist-orchestration.md). Not product code:
 * the offline G-R evaluation (experiments/routing/evaluate.ts) found the classifier route below the main model's own choice.
 *
 * The router does not solve or split work. It asks a classifier (TypeSafe Jev) observable facts about one request: how it
 * relates to the previous reply, whether it reports a malfunction, whether it asks for (or authorizes) a change, whether
 * several distinct candidates would be worth producing. Deterministic rules turn those facts into a topology. jev_router
 * failed by asking Jev a value judgment ("would orchestration help?") from the request text alone and routed almost every
 * request to orchestration; here the counterfactual stays out of the classifier, and follow-ups get the previous reply's tail.
 */
import type { ClassifierAnswer, ClassifierQuestion, ClassifierResult } from "@earendil-works/pi-ai";

export type Topology = "respond" | "investigation" | "execution" | "creation";
export const TOPOLOGIES: readonly Topology[] = ["respond", "investigation", "execution", "creation"];
export type Turn = "new" | "approval" | "correction" | "constraint" | "report" | "question" | "reformat";
export type Intent = "understand" | "decide" | "modify" | "create" | "operate";
export type Domain = "code" | "infra" | "research" | "asset" | "document" | "general";
export type Level = "low" | "medium" | "high";
export interface Descriptor {
  turn: Turn;
  bugReport: boolean;
  changeAuthorized: boolean;
  divergence: boolean;
  intent: Intent;
  domain: Domain;
  needsRetrieval: boolean;
  risk: Level;
  uncertainty: Level;
}
export interface RouterInput {
  /** The request: the main session's hand-off in production, the raw user message offline. */
  request: string;
  /** The end of the previous assistant reply, for follow-up messages. */
  previous?: string;
}
export interface RouterOptions {
  /** What a bare bug report (logs or errors without an instruction) means: fix it (default) or diagnose and propose. */
  bugReports: "fix" | "diagnose";
}
export const DEFAULT_ROUTER_OPTIONS: Readonly<RouterOptions> = { bugReports: "fix" };

const LEVELS: readonly Level[] = ["low", "medium", "high"];
export const ROUTER_QUESTIONS: Record<keyof Descriptor, ClassifierQuestion> = {
  turn: { type: "choice", instructions: "`previous` is the end of the assistant's previous reply in this conversation; it is absent for a first message. How does `request` relate to it?", criteria: {
    new: "A new task or question, not a reaction to the previous reply. Always this when `previous` is absent.",
    approval: "Approves or tells to carry out what the previous reply proposed or asked, for example 'yes', 'do all of it', 'proceed', or choosing among offered options.",
    correction: "Says the previous work misunderstood the intent or took a wrong approach, and corrects it.",
    constraint: "Adds a condition or a limit to the ongoing work.",
    report: "Reports that the result of the previous work is wrong, missing or does not work.",
    question: "Asks a question about the previous reply or its result.",
    reformat: "Asks to restate the previous reply in another form or language, without new work.",
  } },
  bugReport: { type: "bool", instructions: "Does `request` report a malfunction (an error message, a log, a crash, or something that does not work) without saying what to do about it?", criteria: {
    true: "Reports a malfunction and gives no instruction, or only asks why or whether it can be fixed.",
    false: "No malfunction is reported, or the request says what to do (for example: analyze the cause, fix it, explain it).",
  } },
  changeAuthorized: { type: "bool", instructions: "Does `request` ask for, or already authorize, a change to files, code, configuration, assets or a running system, including 'fix it if needed' or 'review and rewrite'? Asking only for an explanation, analysis, review, evaluation, opinion, proposal, plan, search or location is not a change.", criteria: {
    true: "Asks for or authorizes a change.",
    false: "Asks only for information, analysis, an opinion, a proposal or a plan.",
  } },
  divergence: { type: "bool", instructions: "Is the requested result an open-ended creative artifact, such as an image, icon, thumbnail, cover, skin, visual theme, effect, UI look, name or slogan, where several distinct candidates would be worth producing and comparing?", criteria: {
    true: "An open-ended creative artifact.",
    false: "A result that is specified or has one correct form, including code, configuration, documents and plans.",
  } },
  intent: { type: "choice", instructions: "What does `request` mainly want?", criteria: {
    understand: "An explanation, analysis, review, search or location.",
    decide: "A comparison, recommendation, design or plan to choose from.",
    modify: "A change to code, files, documents or configuration.",
    create: "A new creative artifact: image, asset, visual theme, text or idea.",
    operate: "An action on a running system, repository or environment: deploy, git operations, install, start or stop.",
  } },
  domain: { type: "choice", instructions: "Which domain does `request` belong to?", criteria: {
    code: "Source code and its tests.",
    infra: "Servers, containers, networks, environments, installation, repositories and hosting.",
    research: "Papers, external tools or technologies, comparisons of approaches.",
    asset: "Game or design assets: images, models, sounds, visual themes.",
    document: "Documentation, specifications or plans.",
    general: "Anything else.",
  } },
  needsRetrieval: { type: "bool", instructions: "Does answering or doing `request` need information that is not in `request` itself (the repository, a running system, documents or the web)?", criteria: { true: "Needs outside information.", false: "Everything needed is in the request." } },
  risk: { type: "score", instructions: "How costly would a wrong result be: data loss, security, outage, money, or hard to undo?", criteria: ["low", "medium", "high"] },
  uncertainty: { type: "score", instructions: "How unclear are the requirements, the cause or the approach?", criteria: ["low", "medium", "high"] },
};

/** The topology of a request. First matching rule wins; a first message has no turn other than `new`. */
export function topologyOf(descriptor: Descriptor, input: Pick<RouterInput, "previous">, options: RouterOptions = DEFAULT_ROUTER_OPTIONS): Topology {
  const turn = input.previous ? descriptor.turn : "new";
  if (turn === "reformat") return "respond";
  if (turn === "approval") return "execution";
  if (turn === "report" || descriptor.bugReport) return options.bugReports === "fix" ? "execution" : "investigation";
  if (!descriptor.changeAuthorized) return "investigation";
  return descriptor.divergence && (descriptor.intent === "create" || descriptor.domain === "asset") ? "creation" : "execution";
}

// ---- rules-only descriptor (keyword heuristics, Korean and English; the baseline Jev must beat) ----
const ASSET = /(이미지|그림|썸네일|아이콘|엠블럼|커버|배너|광고|스킨|테마|이펙트|효과|로고|에셋|일러스트|폰트|사운드|비주얼|시각|그래픽|맵|지형|\b(?:image|icon|thumbnail|logo|banner|skin|theme|effect|asset|sprite|texture|sound)s?\b)/i;
const MAKE = /(만들|제작|생성|그려|업데이트|업그레이드|개선|적용|교체|바꿔|\b(?:make|create|design|draw|generate|update|upgrade|improve|replace)\b)/i;
const CHANGE = /(수정|고쳐|고치|변경|바꿔|바꾸|추가|구현|만들|작성|재작성|삭제|제거|지워|이동|옮겨|합쳐|합치|통합|동기화|적용|설치|업데이트|업그레이드|푸시|커밋|배포|생성|등록|교체|정리|재구현|재구축|리팩터|마이그레|확장|부여|붙여|넣어|올려|\bpush\b|\bcommit\b|\b(?:fix|add|implement|change|update|remove|delete|create|write|rewrite|rename|move|install|upgrade|sync|merge|deploy|refactor|migrate|configure)\b)/i;
const ASK = /(\?|？|어때|알려\s*줘|설명|분석|검토|리뷰|평가|비교|조사|리서치|찾아\s*줘|확인\s*해\s*줘|궁금|제안|추천|계획|방법|어떻게|왜|뭐야|뭔지|있니|있나|없나|할\s*수\s*있|리스트업|\b(?:explain|why|how|what|which|compare|evaluate|analy[sz]e|review|plan|propose|suggest|recommend|research|find)\b)/i;
const PLAN_ONLY = /(계획|제안|방법|어때|검토\s*해\s*줘|평가\s*해\s*줘|비교\s*해\s*줘|리서치|조사\s*해\s*줘|어떻게|\b(?:plan|propose|suggest)\b)/i;
const ORDER = /(해\s*줘|해라|하세요|해\.?$|진행|수행|하자|부탁|\b(?:please|do it|go ahead)\b)/im;
const MALFUNCTION = /(\berror\b|exception|traceback|uncaught|crash|failed|failure|\bwarn(?:ing)?\b|에러|오류|실패|안\s*돼|안\s*됨|안\s*나와|안\s*보여|안\s*떠|안\s*뜸|안\s*뜨|멈췄|멈춰|죽어|깨져|타임아웃|timed out)/i;
const INSTRUCTION = /(분석|원인|찾아|고쳐|수정|해결|알려|설명|확인|검토|봐\s*줘|\b(?:fix|analy[sz]e|explain|find|check)\b)/i;
const REFORMAT = /(한글로|영어로|번역|다시\s*(?:출력|써|작성|정리)|재출력|요약\s*해|\b(?:translate|rephrase|summari[sz]e)\b)/i;
const APPROVAL = /^\s*(네|예|응|ㅇㅇ|ㅇㅋ|좋아|좋습니다|오케이|ok(?:ay)?|yes|go|진행|다\s*수행|다\s*해|그렇게|그대로|ㄱㄱ|\d(?:\s*[,.)]|\s*번)?)/i;
const CORRECTION = /(아니야|아니라|아니고|그게\s*아니|뜻이었|의도는|잘못\s*(?:이해|됐)|\b(?:not what|i meant)\b)/i;
const CONSTRAINT = /(말고|하지\s*마|사용하지\s*말|쓰지\s*마|건드리지|유지|없어야|계속\s*문제|\b(?:don't|do not|without|keep)\b)/i;
const OPERATE = /(푸시|\bpush\b|배포|deploy|동기화|\bsync\b|설치|install|커밋|commit|브랜치|branch|컨테이너|docker|ssh|실행\s*해|재시작|restart)/i;
const RESEARCH = /(논문|arxiv|리서치|research|https?:\/\/|라이브러리|패키지|\b(?:library|package|framework)\b)/i;
const DOCUMENT = /(문서|\.md\b|readme|agents\.md|기획서|스펙|명세|\b(?:docs?|document|spec)\b)/i;

/** Keyword heuristics for the same facts the classifier answers. */
export function rulesDescriptor(input: RouterInput): Descriptor {
  const text = input.request.trim();
  const head = text.slice(0, 600);
  const short = text.length <= 60;
  let turn: Turn = "new";
  if (input.previous) {
    if (short && REFORMAT.test(text)) turn = "reformat";
    else if (short && APPROVAL.test(text)) turn = "approval";
    else if (CORRECTION.test(head)) turn = "correction";
    else if (MALFUNCTION.test(head) && !ORDER.test(head)) turn = "report";
    else if (/[?？]\s*$/.test(text)) turn = "question";
    else if (CONSTRAINT.test(head)) turn = "constraint";
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const logLike = lines.length >= 4 && lines.filter(line => MALFUNCTION.test(line) || /^\s*(?:at |\d{4}-\d\d-\d\d|\[|[A-Za-z_]+:|>|\$|➜)/.test(line)).length >= 3;
  const instructed = INSTRUCTION.test(head.replace(MALFUNCTION, " ")) && ORDER.test(head);
  const bugReport = (MALFUNCTION.test(head) || logLike) && !instructed;
  const asked = ASK.test(head);
  const ordered = ORDER.test(head) || /[.!]\s*$/.test(text) || !/[?？]\s*$/.test(text);
  const changeWord = CHANGE.test(head);
  const changeAuthorized = changeWord && ordered && !(asked && PLAN_ONLY.test(head) && !/(진행|수행|적용해|수정해|고쳐|구현해|작성해|만들어)/.test(head));
  const divergence = ASSET.test(head) && MAKE.test(head);
  const intent: Intent = divergence ? "create" : changeAuthorized ? OPERATE.test(head) && !/(수정|구현|작성|추가|고쳐)/.test(head) ? "operate" : "modify" : PLAN_ONLY.test(head) ? "decide" : "understand";
  const domain: Domain = divergence || (ASSET.test(head) && !changeAuthorized) ? "asset" : RESEARCH.test(head) ? "research" : DOCUMENT.test(head) ? "document" : OPERATE.test(head) ? "infra" : "code";
  return { turn, bugReport, changeAuthorized, divergence, intent, domain, needsRetrieval: true, risk: "medium", uncertainty: bugReport ? "high" : "medium" };
}

// ---- classifier adapter ----
export interface Gate { minChoiceConfidence: number; minChoiceMargin: number; boolTrue: number; boolFalse: number; minScoreConfidence: number }
export const DEFAULT_GATE: Readonly<Gate> = { minChoiceConfidence: 0.6, minChoiceMargin: 0.2, boolTrue: 0.7, boolFalse: 0.3, minScoreConfidence: 0.6 };
/** Values used for a field the classifier did not answer clearly: no change, no candidates, no bug report (the safe side). */
export const CONSERVATIVE: Readonly<Pick<Descriptor, "bugReport" | "changeAuthorized" | "divergence">> = { bugReport: false, changeAuthorized: false, divergence: false };

export interface ClassifiedField<T> { value: T; accepted: boolean; detail: number | Record<string, number> }
export type Classified = { [K in keyof Descriptor]?: ClassifiedField<Descriptor[K]> };

/** Read the classifier's answers and gate each one; fields without an answer are absent. */
export function readAnswers(answers: Record<string, ClassifierAnswer>, gate: Gate = DEFAULT_GATE): Classified {
  const out: Record<string, ClassifiedField<unknown>> = {};
  for (const [key, question] of Object.entries(ROUTER_QUESTIONS)) {
    const answer = answers[key];
    if (!answer || answer.type !== question.type) continue;
    if (answer.type === "choice") {
      const ranked = Object.values(answer.probabilities).sort((a, b) => b - a);
      out[key] = { value: answer.choice, accepted: answer.confidence >= gate.minChoiceConfidence && (ranked[0] ?? 0) - (ranked[1] ?? 0) >= gate.minChoiceMargin, detail: answer.probabilities };
    } else if (answer.type === "bool") {
      out[key] = { value: answer.probability >= 0.5, accepted: answer.probability >= gate.boolTrue || answer.probability <= gate.boolFalse, detail: answer.probability };
    } else {
      out[key] = { value: LEVELS[Math.max(0, Math.min(LEVELS.length - 1, Math.round(answer.score)))]!, accepted: answer.confidence >= gate.minScoreConfidence, detail: answer.score };
    }
  }
  return out as Classified;
}

/**
 * A descriptor from gated classifier fields. `gated: false` takes every answer as it is (the raw classifier);
 * otherwise an unclear field falls back to the conservative value (booleans) or the rules descriptor (the rest).
 */
export function descriptorOf(classified: Classified, rules: Descriptor, mode: { gated: boolean }): Descriptor {
  const pick = <K extends keyof Descriptor>(key: K): Descriptor[K] => {
    const field = classified[key] as ClassifiedField<Descriptor[K]> | undefined;
    if (field && (field.accepted || !mode.gated)) return field.value;
    return key in CONSERVATIVE ? CONSERVATIVE[key as keyof typeof CONSERVATIVE] as Descriptor[K] : rules[key];
  };
  return { turn: pick("turn"), bugReport: pick("bugReport"), changeAuthorized: pick("changeAuthorized"), divergence: pick("divergence"), intent: pick("intent"),
    domain: pick("domain"), needsRetrieval: pick("needsRetrieval"), risk: pick("risk"), uncertainty: pick("uncertainty") };
}

/** The classifier's state for one request: the request and, for follow-ups, the previous reply's tail. Nothing else is sent. */
export function classifierState(input: RouterInput): { request: string; previous?: string } {
  const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
  return { request: clip(input.request.trim(), 16_000), ...(input.previous?.trim() ? { previous: clip(input.previous.trim().slice(-800), 800) } : {}) };
}

/** The result of a classifier call, or why there is none (the caller then routes by the rules descriptor). */
export function classifierOutcome(result: ClassifierResult | undefined, error?: unknown): { answers?: Record<string, ClassifierAnswer>; error?: string } {
  if (error !== undefined) return { error: error instanceof Error ? error.message : String(error) };
  if (!result) return { error: "no classifier" };
  if (result.stopReason !== "stop") return { error: result.errorMessage ?? result.stopReason };
  return { answers: result.answers };
}
