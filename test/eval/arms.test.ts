import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildStudyArm, piRoutes, studyArmMetadata, studyArms } from '../../src/eval/arms.js';
import { captureArmPayload, extractPiRequestUsage, requestActor, runPiChild } from '../../src/eval/pi-runner.js';
import { runOrchestrated } from '../../src/orchestration/coordinator.js';
import { allowedPairs, verifyRequests } from '../../results/advisor-study/verify-arms.js';

vi.mock('@earendil-works/pi-coding-agent', async importOriginal => ({ ...await importOriginal<typeof import('@earendil-works/pi-coding-agent')>(), ModelRuntime: { create: async () => ({ streamSimple: vi.fn() }) } }));
vi.mock('../../src/orchestration/coordinator.js', () => ({ runOrchestrated: vi.fn(async () => ({ status: 'done', summary: 'Done.' })) }));
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');
const row = (model: string, effort: string, actor?: string) => ({ type: 'provider_request', id: 1, sessionId: 's', model, effort, ...(actor ? { actor } : {}) });

describe('study arm registry', () => {
  it('keeps prompt arms unchanged and makes A0 identical to C0 except for its name', () => {
    expect(Object.keys(studyArms)).toEqual(['C0','C1','C2','A0','A1','A2']);
    for (const name of ['C0','C1','C2','A0']) {
      const arm = buildStudyArm(name);
      expect(arm.routes).toEqual(piRoutes);
      expect(arm.advisors).toEqual([]);
      expect(arm.providerExtensions).toEqual([]);
    }
    expect(buildStudyArm('A0').promptVariant).toBe('C0');
    expect(() => buildStudyArm('a1')).toThrow('Unknown study arm');
  });
  it('overrides every non-advisor route in every arm and auto-loads the proxy extension', () => {
    const baseModel = 'cliproxyapi/gpt-6.1-sol';
    for (const name of Object.keys(studyArms)) {
      const arm = buildStudyArm(name, baseModel);
      expect(arm.baseModel).toBe(baseModel);
      for (const [role, route] of Object.entries(arm.routes.routes)) {
        if (!Object.hasOwn(arm.advisorRoutes, role)) expect(route).toEqual({ model: baseModel, thinking: 'high' });
      }
      expect(arm.routes.default).toEqual({ model: baseModel, thinking: 'high' });
      expect(arm.routes.providerExtensions).toEqual(['npm:@router-for-me/pi-cliproxyapi-provider']);
      expect(allowedPairs(arm)).toEqual(arm.allowedModelEffortPairs);
      expect(allowedPairs(arm)[0]).toEqual({ actor: 'non-advisor', model: baseModel, effort: 'high' });
      const rows = arm.allowedModelEffortPairs.map(pair => row(pair.model, pair.effort, pair.actor));
      expect(verifyRequests(rows, arm, []).ok).toBe(true);
      expect(extractPiRequestUsage(jsonl(rows), arm).validModelEffort).toBe(true);
      expect(verifyRequests([row('openai/gpt-6.1-sol', 'high')], arm, []).ok).toBe(false);
    }
  });
  it('expands and resolves the exact production advisor presets without changing other roles', () => {
    const arm = buildStudyArm('A1');
    expect(arm.promptVariant).toBe('C0');
    for (const [role, route] of Object.entries(piRoutes.routes)) expect(arm.routes.routes[role]).toEqual(route);
    expect(arm.routes.default).toEqual(piRoutes.default);
    expect(arm.advisorRoutes).toEqual({ advisor: { model: 'cliproxyapi/claude-opus-5-5', thinking: 'xhigh' }, 'advisor-plan': { model: 'cliproxyapi/gpt-6-astra', thinking: 'xhigh' } });
    expect(arm.providerExtensions).toEqual(['npm:@router-for-me/pi-cliproxyapi-provider']);
    expect(arm.advisors).toMatchObject([
      { name: 'plan-review', route: 'advisor-plan', domains: [{ id: 'plan', instructions: expect.any(String) }], targets: ['coordinator'], triggers: [{ on: 'coordinator_decision', decisions: ['assign'], await: true }], maxCallsPerRun: 4, maxCallsPerTarget: 4, timeoutMs: 90000 },
      { name: 'verification-audit', route: 'advisor', domains: [{ id: 'verification', instructions: expect.any(String) }], targets: ['coordinator'], triggers: [{ on: 'assignment_result', kinds: ['implement','fix','verify'] }, { on: 'before_complete' }], maxCallsPerRun: 8, maxCallsPerTarget: 8 },
    ]);
    expect(arm.routes.advisors?.every(advisor => advisor.enabled === true)).toBe(true);
    expect(arm.allowedModelEffortPairs).toHaveLength(3);
  });
  it('A2 differs from A1 only in the verification-audit route (cheap production advisor)', () => {
    const a1 = buildStudyArm('A1', 'cliproxyapi/gpt-6.1-sol'), a2 = buildStudyArm('A2', 'cliproxyapi/gpt-6.1-sol');
    expect(a2.promptVariant).toBe('C0');
    expect(a2.advisorRoutes).toEqual({ advisor: { model: 'cliproxyapi/gpt-6-luna', thinking: 'low' }, 'advisor-plan': { model: 'cliproxyapi/gpt-6-astra', thinking: 'xhigh' } });
    const { advisor: _a1, ...a1Rest } = a1.routes.routes, { advisor: _a2, ...a2Rest } = a2.routes.routes;
    expect(a2Rest).toEqual(a1Rest);
    expect(a2.routes.default).toEqual(a1.routes.default);
    expect(a2.routes.providerExtensions).toEqual(a1.routes.providerExtensions);
    expect(a2.advisors).toEqual(a1.advisors);
    expect(a2.allowedModelEffortPairs).toEqual([
      { actor: 'non-advisor', model: 'cliproxyapi/gpt-6.1-sol', effort: 'high' },
      { actor: 'advisor:plan-review', model: 'cliproxyapi/gpt-6-astra', effort: 'xhigh', route: 'advisor-plan' },
      { actor: 'advisor:verification-audit', model: 'cliproxyapi/gpt-6-luna', effort: 'low', route: 'advisor' },
    ]);
    expect(extractPiRequestUsage(jsonl([row('cliproxyapi/gpt-6-luna','low','advisor:verification-audit')]), a2).validModelEffort).toBe(true);
    for (const invalid of [row('cliproxyapi/gpt-6-luna','low'), row('cliproxyapi/claude-opus-5-5','xhigh','advisor:verification-audit'), row('cliproxyapi/gpt-6-luna','low','advisor:plan-review')]) expect(extractPiRequestUsage(jsonl([invalid]), a2).validModelEffort).toBe(false);
    expect(extractPiRequestUsage(jsonl([row('cliproxyapi/gpt-6-luna','low','advisor:verification-audit')]), a1).validModelEffort).toBe(false);
  });
  it('records the resolved arm in runner command/overlay and passes its routes', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'arm-runner-'));
    try {
      const result = await runPiChild({ arm: 'A1', baseModel: 'cliproxyapi/gpt-6.1-sol', cwd: outDir, outDir, instruction: 'test', timeoutSec: 1 });
      const metadata = studyArmMetadata(buildStudyArm('A1', 'cliproxyapi/gpt-6.1-sol'));
      expect(result.status).toBe('done');
      expect(result.overlay).toMatchObject({ arm: metadata, providerExtensions: metadata.providerExtensions });
      expect(JSON.parse(result.command[1]!)).toMatchObject({ arm: metadata, promptVariant: 'C0', routes: buildStudyArm('A1', metadata.baseModel).routes });
      expect(runOrchestrated).toHaveBeenCalledWith(expect.objectContaining({ routes: buildStudyArm('A1', metadata.baseModel).routes }));
      expect(JSON.parse(await readFile(join(outDir, 'prompt-variant.json'), 'utf8')).name).toBe('C0');
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });
});

describe('arm-aware request validation', () => {
  it('attributes advisors in both shorthand and normalized system transcripts without trusting user text', () => {
    const prompt = 'You are advisor "plan-review" inside a multi-agent coding run.';
    const tool = { name: 'advisor_verdict', description: 'verdict', parameters: {} };
    expect(requestActor({ systemPrompt: prompt, tools: [tool], messages: [] })).toBe('advisor:plan-review');
    expect(requestActor({ messages: [{ role: 'system', content: 'Base', sections: { addendum: prompt }, toolsAdded: [tool], timestamp: 0 }] })).toBe('advisor:plan-review');
    expect(requestActor({ messages: [{ role: 'system', content: prompt, toolsAdded: [tool], timestamp: 0 }, { role: 'system', content: '', toolsRemoved: [{ name: tool.name }], timestamp: 1 }] })).toBe('non-advisor');
    expect(requestActor({ tools: [tool], messages: [{ role: 'user', content: prompt, timestamp: 0 }] })).toBe('non-advisor');
    expect(requestActor({ systemPrompt: prompt, messages: [] })).toBe('non-advisor');
  });
  it('retains strict sol/high validation for C0-C2 and A0', () => {
    for (const name of ['C0','C1','C2','A0']) {
      expect(extractPiRequestUsage(jsonl([row('openai/gpt-6.1-sol','high')]), buildStudyArm(name)).validModelEffort).toBe(true);
      expect(extractPiRequestUsage(jsonl([row('cliproxyapi/claude-opus-5-5','xhigh','advisor:verification-audit')]), buildStudyArm(name)).validModelEffort).toBe(false);
      expect(extractPiRequestUsage(jsonl([row('openai/gpt-6.1-sol','medium')]), buildStudyArm(name)).validModelEffort).toBe(false);
    }
  });
  it('allows configured advisors only with independent actor attribution', () => {
    const arm = buildStudyArm('A1');
    for (const pair of arm.allowedModelEffortPairs) expect(extractPiRequestUsage(jsonl([row(pair.model,pair.effort,pair.actor)]), arm).validModelEffort).toBe(true);
    for (const invalid of [row('cliproxyapi/claude-opus-5-5','xhigh'), row('cliproxyapi/claude-opus-5-5','high','advisor:verification-audit'), row('cliproxyapi/gpt-6-astra','xhigh','advisor:verification-audit'), row('openai/gpt-6.1-sol','xhigh')]) expect(extractPiRequestUsage(jsonl([invalid]), arm).validModelEffort).toBe(false);
  });
  it('captures Responses and Anthropic-style wire efforts, normalizing only catalog-declared advisor mappings', () => {
    const arm = buildStudyArm('A1'), model = { provider: 'cliproxyapi', id: 'claude-opus-5-5' };
    const payload = { model: model.id, reasoning: { effort: 'xhigh' } };
    expect(captureArmPayload(payload, model, arm, 'advisor:verification-audit')).toMatchObject({ effort: 'xhigh', wireEffort: 'xhigh', effortSource: 'reasoning.effort', matchedPair: { actor: 'advisor:verification-audit' } });
    expect(captureArmPayload({ model: model.id, output_config: { effort: 'max' } }, { ...model, thinkingLevelMap: { xhigh: 'max' } }, arm, 'advisor:verification-audit')).toMatchObject({ effort: 'xhigh', wireEffort: 'max', effortSource: 'output_config.effort', matchedPair: { effort: 'xhigh' } });
    expect(captureArmPayload({ model: model.id, output_config: { effort: 'max' } }, model, arm, 'advisor:verification-audit').matchedPair).toBeNull();
    expect(captureArmPayload({ model: 'gpt-6.1-sol', output_config: { effort: 'high' } }, { provider: 'openai', id: 'gpt-6.1-sol' }, arm).matchedPair).toBeNull();
    expect(captureArmPayload({ model: model.id }, model, arm, 'advisor:verification-audit').matchedPair).toBeNull();
  });
  it('accepts Chat Completions reasoning_effort for a configured proxy base without changing wire facts', () => {
    const arm = buildStudyArm('A0', 'cliproxyapi/gpt-6.1-sol');
    const captured = captureArmPayload({ model: 'gpt-6.1-sol', reasoning_effort: 'high' }, { provider: 'cliproxyapi', id: 'gpt-6.1-sol' }, arm);
    expect(captured).toMatchObject({ model: arm.baseModel, effort: 'high', wireEffort: 'high', effortSource: 'reasoning_effort', matchedPair: { actor: 'non-advisor', model: arm.baseModel, effort: 'high' } });
    expect(verifyRequests([{ type: 'provider_request', id: 1, ...captured }], arm, []).ok).toBe(true);
  });
});
