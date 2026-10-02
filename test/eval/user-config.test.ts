import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRouteConfig, parseRouteConfig } from '../../src/orchestration/routing.js';

const configPath = fileURLToPath(new URL('../../results/advisor-study/user-orche.config.json', import.meta.url));

describe('proposed advisor study user config', () => {
  it('loads through the route parser and preserves every production route', async () => {
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    const config = await loadRouteConfig(configPath);
    expect(config).toEqual(parseRouteConfig(raw));
    expect(config.providerExtensions).toEqual(['npm:@router-for-me/pi-cliproxyapi-provider']);
    expect(config.default).toEqual({ model: 'cliproxyapi/claude-opus-5-5', thinking: 'high', extendedContext: true });
    expect(config.routes).toEqual({
      coordinator: { model: 'cliproxyapi/claude-opus-5-5', thinking: 'xhigh', extendedContext: true },
      'explorer-path': { model: 'cliproxyapi/gpt-6.1-sol', thinking: 'high', extendedContext: true },
      'explorer-cause': { model: 'cliproxyapi/claude-opus-5-5', thinking: 'xhigh' },
      'explorer-repro': { model: 'cliproxyapi/gpt-6-luna', thinking: 'medium' },
      implementer: { model: 'cliproxyapi/gpt-6.1-sol', thinking: 'high', extendedContext: true },
      analyst: { model: 'cliproxyapi/gpt-6-astra', thinking: 'max' },
      verifier: { model: 'cliproxyapi/claude-sonnet-5-5', thinking: 'medium' },
      advisor: { model: 'cliproxyapi/claude-opus-5-5', thinking: 'xhigh' },
      'advisor-plan': { model: 'cliproxyapi/gpt-6-astra', thinking: 'xhigh' },
      'game-asset': { model: 'cliproxyapi/claude-opus-5-5', thinking: 'high', extendedContext: true },
      video: { model: 'cliproxyapi/claude-opus-5-5', thinking: 'high', extendedContext: true },
    });
  });

  it('expands both enabled presets with the exact triggers, routes and audit budgets', async () => {
    const { advisors } = await loadRouteConfig(configPath);
    expect(advisors).toHaveLength(2);
    expect(advisors?.[0]).toEqual({
      name: 'plan-review', enabled: true, route: 'advisor-plan', domains: ['plan'], targets: ['coordinator'],
      triggers: [{ on: 'coordinator_decision', decisions: ['assign'], await: true }],
      cooldownMs: 0, maxCallsPerRun: 4, maxCallsPerTarget: 4,
    });
    expect(advisors?.[1]).toEqual({
      name: 'verification-audit', enabled: true, route: 'advisor', domains: ['verification'], targets: ['coordinator'],
      triggers: [{ on: 'assignment_result', kinds: ['implement', 'fix', 'verify'] }, { on: 'before_complete' }],
      cooldownMs: 0, maxCallsPerRun: 8, maxCallsPerTarget: 8,
    });
  });
});
