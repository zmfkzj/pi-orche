import { resolveAdvisor, type ResolvedAdvisor } from '../advisor/config.js';
import { parseRouteConfig, type RouteConfig, type RouteSettings } from '../orchestration/routing.js';

export const piModel = 'openai/gpt-6.1-sol';
const baseRoles = ['coordinator', 'explorer-path', 'explorer-cause', 'explorer-repro', 'verifier', 'implementer', 'answer'];
const providerExtensionMap: Readonly<Record<string, string>> = { cliproxyapi: 'npm:@router-for-me/pi-cliproxyapi-provider' };
export function validateBaseModel(model: string): string {
  if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error('base-model must be <provider/modelId>');
  return model;
}
function baseRoutes(baseModel: string): RouteConfig {
  validateBaseModel(baseModel);
  const extension = providerExtensionMap[baseModel.split('/')[0]!];
  return parseRouteConfig({ routes: Object.fromEntries(baseRoles.map(role => [role, { model: baseModel, thinking: 'high' }])), default: { model: baseModel, thinking: 'high' }, ...(extension ? { providerExtensions: [extension] } : {}) });
}
export const piRoutes = baseRoutes(piModel);
export const promptVariants: Readonly<Record<string, string | null>> = { C0: null, C1: 'prompts/c1-engineering-discipline.md', C2: 'prompts/c2-omp-derived.md' };
export const studyArms: Readonly<Record<string, { promptVariant: string; advisors: boolean }>> = { C0: { promptVariant: 'C0', advisors: false }, C1: { promptVariant: 'C1', advisors: false }, C2: { promptVariant: 'C2', advisors: false }, A0: { promptVariant: 'C0', advisors: false }, A1: { promptVariant: 'C0', advisors: true } };
export interface AllowedModelEffortPair { actor: string; model: string; effort: string; route?: string }
export interface StudyArmMetadata { name: string; baseModel: string; promptVariant: string; advisors: ResolvedAdvisor[]; advisorRoutes: Record<string, RouteSettings>; providerExtensions: readonly string[]; allowedModelEffortPairs: AllowedModelEffortPair[] }
export interface StudyArm extends StudyArmMetadata { routes: RouteConfig }

/** Presets are parsed before use; malformed arm configuration must never silently disable advisors. */
export function buildStudyArm(name: string, baseModel = piModel): StudyArm {
  if (!Object.hasOwn(studyArms, name)) throw new Error(`Unknown study arm ${name}; expected ${Object.keys(studyArms).join(', ')}`);
  const definition = studyArms[name]!;
  const piRoutes = baseRoutes(baseModel);
  const routes = parseRouteConfig(definition.advisors ? {
    ...piRoutes,
    routes: { ...piRoutes.routes, advisor: { model: 'cliproxyapi/claude-opus-5-5', thinking: 'xhigh' }, 'advisor-plan': { model: 'cliproxyapi/gpt-6-astra', thinking: 'xhigh' } },
    providerExtensions: ['npm:@router-for-me/pi-cliproxyapi-provider'],
    advisors: [
      { preset: 'plan-review', enabled: true, route: 'advisor-plan', triggers: [{ on: 'coordinator_decision', decisions: ['assign'], await: true }] },
      { preset: 'verification-audit', enabled: true, route: 'advisor', triggers: [{ on: 'assignment_result', kinds: ['implement','fix','verify'] }, { on: 'before_complete' }], maxCallsPerRun: 8, maxCallsPerTarget: 8 },
    ],
  } : piRoutes);
  const advisors = (routes.advisors ?? []).filter(advisor => advisor.enabled !== false).map(resolveAdvisor);
  const advisorRoutes = Object.fromEntries(advisors.map(advisor => {
    const route = routes.routes[advisor.route];
    if (!route?.thinking) throw new Error(`Study arm ${name}: missing advisor route/effort ${advisor.route}`);
    return [advisor.route, route];
  }));
  const allowedModelEffortPairs = [{ actor: 'non-advisor', model: routes.default!.model, effort: routes.default!.thinking! }, ...advisors.map(advisor => ({ actor: `advisor:${advisor.name}`, model: advisorRoutes[advisor.route]!.model, effort: advisorRoutes[advisor.route]!.thinking!, route: advisor.route }))];
  return { name, baseModel, promptVariant: definition.promptVariant, routes, advisors, advisorRoutes, providerExtensions: routes.providerExtensions ?? [], allowedModelEffortPairs };
}
export function studyArmMetadata({ routes: _routes, ...metadata }: StudyArm): StudyArmMetadata { return metadata; }
export function matchArmRequest(arm: StudyArmMetadata, model: string, effort: string | null, actor = 'non-advisor'): AllowedModelEffortPair | undefined {
  return arm.allowedModelEffortPairs.find(pair => pair.actor === actor && pair.model === model && pair.effort === effort);
}
