import { ModelRuntime, type AgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AgentManager } from '../agent/agent-manager.js';
import type { Outcome } from '../agent/agent-handle.js';
import { createSession } from '../pi/session-factory.js';
import { reportAgent, targetOf } from '../agent/records.js';
import { resolveRoute } from '../orchestration/routing.js';
import { readyTasks, updateTaskStatus, validateBacklog, type TaskItem } from '../orchestration/backlog.js';
import { type RunOptions, type RunReport } from '../orchestration/coordinator.js';
import { resolveRunLimits } from '../orchestration/limits.js';
import type { CoordinatorEvent } from '../orchestration/events.js';
import type { Phase } from '../orchestration/phases.js';

const planSchema = Type.Object({ angles: Type.Array(Type.String({ minLength: 1 }), { minItems: 3, maxItems: 3 }) });
const taskSchema = Type.Object({ id: Type.String({ minLength: 1 }), description: Type.String({ minLength: 1 }), files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), dependsOn: Type.Optional(Type.Array(Type.String())) });
const integrationSchema = Type.Object({ cause: Type.String({ minLength: 1 }), tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 8 }) });
const finalSchema = Type.Object({ summary: Type.String({ minLength: 1 }) });

export async function runBaseline(options: RunOptions): Promise<RunReport> {
  const startedAt = Date.now();
  // The baseline arm has no timeout extension: its deadline below is the fixed `startedAt + overallMs`, so whatever `maxExtensions` a config or caller carries is resolved to 0.
  const limits = resolveRunLimits(options.routes.limits, { ...options.limits, maxExtensions: 0 });
  const emit = (event: CoordinatorEvent) => options.sink?.(event);
  let tasks: readonly TaskItem[] = [], rootCause: string | undefined, phase: Phase | 'INIT' = 'INIT';
  let main: AgentSession | undefined;
  let manager: AgentManager | undefined;
  let serial = 0;
  const mainStats = { requests: 0, models: {} as Record<string, number> };
  let verificationEvidence: unknown;
  const deadline = startedAt + limits.overallMs;
  const remaining = (ms: number) => {
    const value = Math.min(ms, deadline - Date.now());
    if (value <= 0) throw new Error('Baseline overall timeout');
    return value;
  };
  const changePhase = (to: Phase) => { emit({ type: 'phase_changed', timestamp: Date.now(), from: phase, to }); phase = to; };
  emit({ type: 'run_started', timestamp: startedAt, mode: 'baseline', problem: options.problem });
  try {
    const runtime = options.modelRuntime ?? await ModelRuntime.create();
    manager = new AgentManager(runtime, options.records ? { records: options.records } : {});
    manager.subscribe(event => {
      options.sink?.(event);
      if (event.type === 'assignment_outcome' && event.outcome.kind === 'explore') {
        const data = event.outcome.result?.data as { cause?: unknown } | undefined;
        if (typeof data?.cause === 'string') emit({ type: 'root_cause_claimed', timestamp: event.timestamp, agentId: event.outcome.agentId, cause: data.cause, via: 'result' });
      }
    });
    let submitted: unknown;
    let schema: TSchema = planSchema;
    const tool: ToolDefinition = {
      name: 'submit_decision', label: 'Submit decision', description: 'Submit the requested structured decision alone.',
      parameters: Type.Object({ decision: Type.Unknown() }),
      execute: async (_id, args) => {
        const payload = args as { decision: unknown };
        if (!Value.Check(schema, payload.decision)) return { content: [{ type: 'text', text: `Invalid decision: ${JSON.stringify([...Value.Errors(schema, payload.decision)])}` }], details: {}, isError: true };
        submitted = payload.decision;
        return { content: [{ type: 'text', text: 'Decision accepted' }], details: {}, terminate: true };
      },
    };
    // Records are opt-in (`options.records`): without them every baseline session stays in memory.
    main = await createSession({ cwd: options.cwd, route: resolveRoute(options.routes, 'coordinator'), ...targetOf(options.records, { id: 'coordinator', role: 'coordinator', kind: 'coordinator' }), modelRuntime: runtime, tools: ['read', 'grep', 'find', 'ls', 'submit_decision'], customTools: [tool], instructions: 'You are the main fork-join coding coordinator. Workers investigate independently. Wait for every exploration result before integrating. Return structured decisions using submit_decision, alone. Do not implement yourself.' });
    main.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const u = event.message.usage;
        mainStats.requests++;
        const answered = `${event.message.provider}/${event.message.model}`;
        mainStats.models[answered] = (mainStats.models[answered] ?? 0) + 1;
        emit({ type: 'coordinator_usage', timestamp: Date.now(), model: `${event.message.provider}/${event.message.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
      }
    });
    async function decide<T extends TSchema>(next: T, prompt: string): Promise<Static<T>> {
      schema = next; submitted = undefined;
      for (let attempt = 0; attempt <= limits.decisionRepairs; attempt++) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([main!.prompt(`${prompt}\nDecision JSON schema: ${JSON.stringify(next)}\nUse submit_decision({decision: ...}).`), new Promise<never>((_, reject) => { timer = setTimeout(() => { void main!.abort(); reject(new Error('Coordinator decision timeout')); }, remaining(limits.decisionMs)); })]);
        } finally { clearTimeout(timer); }
        if (submitted !== undefined) return submitted as Static<T>;
      }
      throw new Error('Coordinator failed to submit a valid decision');
    }
    async function spawn(role: string, kind: string, prompt: string, tools?: string[]): Promise<string> {
      const id = `baseline-${kind}-${++serial}`;
      await manager!.spawn({ id, role, cwd: options.cwd, route: resolveRoute(options.routes, role), modelRuntime: runtime, peerMessaging: false, ...(tools ? { tools } : {}), instructions: 'Complete only your assignment. No peer communication. Call report_result alone with kind, summary and data. Explore results must include data.cause when identified; verification data must include passed boolean and failures. Respect assigned file ownership.' });
      manager!.assign(id, kind, `${options.problem}\n\n${prompt}`);
      return id;
    }
    async function join(ids: string[], timeout: number): Promise<Outcome[]> {
      const until = Date.now() + remaining(timeout);
      const outcomes: Outcome[] = [];
      const pending = [...ids];
      while (pending.length) {
        const result = await manager!.wait(pending, Math.max(0, Math.min(until - Date.now(), deadline - Date.now())));
        if (result.type === 'timeout') throw new Error(`Worker timeout: ${pending.join(', ')}`);
        if (result.type === 'outcome') { outcomes.push(result.outcome); pending.splice(pending.indexOf(result.outcome.agentId), 1); }
      }
      const failed = outcomes.find(o => o.status !== 'completed');
      if (failed) throw new Error(`Worker ${failed.agentId}: ${failed.status} ${failed.error ?? failed.lastText ?? ''}`);
      return outcomes;
    }
    changePhase('EXPLORE');
    const plan = await decide(planSchema, `Plan exactly three complementary, read-only exploration angles for:\n${options.problem}`);
    const roles = ['explorer-path', 'explorer-cause', 'explorer-repro'];
    const explorers: string[] = [];
    for (let i = 0; i < 3; i++) explorers.push(await spawn(roles[i]!, 'explore', `Read-only investigation: ${plan.angles[i]}. Investigate visible code, logs and tests. Return evidence and data.cause. Do not edit files.`, ['read', 'bash']));
    const exploration = await join(explorers, limits.explorationMs);
    changePhase('CONVERGE');
    const integrated = await decide(integrationSchema, `All explorers finished. Integrate their evidence into one root cause and disjoint-file implementation tasks. Dependencies reference task IDs. Results:\n${JSON.stringify(exploration)}`);
    rootCause = integrated.cause;
    emit({ type: 'root_cause_accepted', timestamp: Date.now(), agentId: 'main', cause: rootCause });
    changePhase('BACKLOG');
    tasks = integrated.tasks.map((task, i) => ({ ...task, owner: `implementer-${i}`, status: 'pending' as const }));
    const issues = validateBacklog(tasks, tasks.map(t => t.owner!));
    if (issues.length) throw new Error(`Invalid baseline backlog: ${JSON.stringify(issues)}`);
    emit({ type: 'backlog_created', timestamp: Date.now(), tasks });
    changePhase('EXECUTE');
    while (tasks.some(task => task.status !== 'done')) {
      const wave = readyTasks(tasks);
      if (!wave.length) throw new Error('Baseline backlog blocked');
      const dispatches: { task: TaskItem; id: string }[] = [];
      for (const task of wave) {
        const role = roles[tasks.findIndex(item => item.id === task.id) % roles.length]!;
        const id = await spawn(role, 'implement', `Root cause: ${rootCause}. Implement task ${task.id}: ${task.description}. You own ONLY ${JSON.stringify(task.files)}. Dependency tasks are finished. Run relevant checks and report result.`);
        tasks = updateTaskStatus(tasks, task.id, 'running');
        emit({ type: 'task_dispatched', timestamp: Date.now(), taskId: task.id, agentId: id });
        dispatches.push({ task, id });
      }
      const outcomes = await join(dispatches.map(d => d.id), limits.assignmentMs);
      for (const { task, id } of dispatches) {
        const outcome = outcomes.find(o => o.agentId === id)!;
        const data = outcome.result?.data as { status?: unknown } | undefined;
        const status = outcome.status === 'completed' && data?.status !== 'blocked' ? 'done' : 'blocked';
        tasks = updateTaskStatus(tasks, task.id, status);
        emit({ type: 'task_finished', timestamp: Date.now(), taskId: task.id, agentId: id, status });
      }
    }
    for (let round = 0; round <= limits.maxFixRounds; round++) {
      changePhase('VERIFY');
      const id = await spawn('verifier', 'verify', `Independently inspect the fix and run visible tests. Do not edit. Return data {passed:boolean, failures?:string} with genuine observed evidence. Root cause: ${rootCause}`, ['read', 'bash']);
      const [outcome] = await join([id], limits.assignmentMs);
      verificationEvidence = outcome!.result;
      const data = outcome!.result?.data as { passed?: unknown; failures?: unknown } | undefined;
      const passed = data?.passed === true;
      emit({ type: 'verification', timestamp: Date.now(), passed, round, summary: outcome!.result!.summary });
      if (passed) break;
      if (round === limits.maxFixRounds) throw new Error(`Verification failed: ${outcome!.result!.summary}`);
      changePhase('EXECUTE');
      const fixer = await spawn('explorer-cause', 'fix', `Repair verification failures. Root cause: ${rootCause}. Findings: ${JSON.stringify(outcome!.result)}. You own the full visible workspace for this serial repair.`);
      await join([fixer], limits.assignmentMs);
    }
    const final = await decide(finalSchema, `All implementation and independent verification completed. Summarize the root cause, fix and validation. Root cause: ${rootCause}. Tasks: ${JSON.stringify(tasks)}. Verification evidence: ${JSON.stringify(verificationEvidence)}`);
    changePhase('DONE');
    const finishedAt = Date.now();
    emit({ type: 'run_finished', timestamp: finishedAt, status: 'done', summary: final.summary });
    return { status: 'done', taskClass: 'diagnose_fix', answer: final.summary, summary: final.summary, rootCause, tasks, startedAt, finishedAt };
  } catch (error) {
    const finishedAt = Date.now(), summary = error instanceof Error ? error.message : String(error);
    emit({ type: 'run_finished', timestamp: finishedAt, status: 'failed', summary });
    return { status: 'failed', taskClass: 'diagnose_fix', answer: summary, summary, ...(rootCause ? { rootCause } : {}), tasks, startedAt, finishedAt };
  } finally {
    await manager?.dispose();
    main?.dispose();
    if (main && options.records?.onAgent) {
      const route = resolveRoute(options.routes, 'coordinator');
      reportAgent(options.records, {
        id: 'coordinator', role: 'coordinator', kind: 'coordinator', model: route.model, ...(route.thinking ? { thinking: route.thinking } : {}),
        requests: mainStats.requests, models: mainStats.models, durationMs: Math.max(0, Date.now() - startedAt), startedAt, status: (phase as string) === 'DONE' ? 'completed' : 'failed',
        ...(main.sessionFile ? { sessionFile: main.sessionFile } : {}),
      });
    }
  }
}
