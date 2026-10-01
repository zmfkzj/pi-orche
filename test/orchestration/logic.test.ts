import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedupeProposals, isBacklogBlocked, isBacklogDone, readyTasks, updateTaskStatus, validateBacklog, type TaskItem } from "../../src/orchestration/backlog.js";
import { createPhaseState, parseCoordinatorDecision, planConvergence, transition, type CoordinatorDecision, type Phase, type PhaseState } from "../../src/orchestration/phases.js";
import { applyRouteOverrides, loadRouteConfig, parseRouteConfig, parseRouteOverride, resolveRoute } from "../../src/orchestration/routing.js";
import { proposalPrompt, verificationPrompt } from "../../src/orchestration/prompts.js";
import { defaultTeam, explorerRolesFor, resolveTeam } from "../../src/orchestration/team.js";
import { workerCountGuidance } from "../../src/orchestration/run/decisions.js";

const workers = [{ agentId: "a", status: "idle" }, { agentId: "b", status: "running" }] as const;
const root = { cause: "Incorrect comparison", sourceAgentId: "a", evidence: ["boundary repro"] };
const task = (id: string, owner = "a", dependsOn: readonly string[] = []): TaskItem => ({ id, owner, dependsOn, files: [`src/${id}.ts`], description: id, status: "pending" });
function step(state: PhaseState, decision: CoordinatorDecision): PhaseState {
  const result = transition(state, decision, workers);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.state;
}
function backlog(): PhaseState {
  return step(step(createPhaseState(), { type: "root_cause_accepted", ...root }), { type: "collect_backlog" });
}

describe("phase decisions", () => {
  it("runs all phases and emits immediate convergence, ownership and verification effects", () => {
    let state = createPhaseState();
    state = step(state, { type: "continue_exploration" });
    const accepted = transition(state, { type: "root_cause_accepted", ...root }, workers);
    expect(accepted).toMatchObject({ ok: true, state: { phase: "CONVERGE" }, effects: [{ type: "assign_proposal", agentId: "a" }, { type: "redirect", agentId: "b" }] });
    state = step(state, { type: "root_cause_accepted", ...root });
    state = step(state, { type: "collect_backlog" });
    const assigned = transition(state, { type: "assign", tasks: [task("fix")] }, workers);
    expect(assigned).toMatchObject({ ok: true, effects: [{ type: "assign_task", agentId: "a" }] });
    state = step(state, { type: "assign", tasks: [task("fix")] });
    expect(transition(state, { type: "verify" })).toEqual({ ok: false, error: { type: "unfinished_backlog" } });
    state = { ...state, tasks: updateTaskStatus(state.tasks, "fix", "done") };
    state = step(state, { type: "verify" });
    state = step(state, { type: "complete", summary: "Fixed and verified" });
    expect(state).toMatchObject({ phase: "DONE", summary: "Fixed and verified" });
  });
  it("rejects illegal decisions in every phase including terminal states", () => {
    const legal: Record<Phase, string[]> = { EXPLORE: ["classify", "continue_exploration", "root_cause_accepted", "fail"], CONVERGE: ["collect_backlog", "fail"], BACKLOG: ["assign", "fail"], EXECUTE: ["verify", "fail"], VERIFY: ["verification_failed", "complete", "fail"], DONE: [], FAILED: [] };
    const decisions: CoordinatorDecision[] = [{ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "Clear change" }, { type: "answer", answer: "Answer", summary: "summary" }, { type: "answer_from_worker", sourceAgentId: "a", summary: "approved" }, { type: "continue_exploration" }, { type: "root_cause_accepted", ...root }, { type: "collect_backlog" }, { type: "assign", tasks: [] }, { type: "verify" }, { type: "verification_failed", reason: "broken" }, { type: "complete", summary: "ok" }, { type: "fail", reason: "bad" }];
    for (const phase of Object.keys(legal) as Phase[]) for (const decision of decisions) {
      if (!legal[phase].includes(decision.type)) expect(transition({ ...createPhaseState(), phase }, decision)).toEqual({ ok: false, error: { type: "illegal_transition", phase, decision: decision.type } });
    }
  });
  it("allows only two repair rounds and terminates on the third failure", () => {
    let state = backlog();
    for (let round = 0; round < 3; round++) {
      state = step(state, { type: "assign", tasks: [{ ...task("fix"), status: "done" }] });
      state = step(state, { type: "verify" });
      state = step(state, { type: "verification_failed", reason: `failure ${round}` });
      expect(state.phase).toBe(round === 2 ? "FAILED" : "BACKLOG");
    }
    expect(state).toMatchObject({ fixRounds: 2, failure: "failure 2" });
    const noRetries = { ...createPhaseState(0), phase: "VERIFY" as const };
    expect(step(noRetries, { type: "verification_failed", reason: "fail" }).phase).toBe("FAILED");
    expect(() => createPhaseState(-1)).toThrow();
  });
  it("reuses source/idle/running workers and stops only unneeded workers", () => {
    expect(planConvergence([...workers, { agentId: "c", status: "running" }], root, ["a", "b"])).toMatchObject([
      { type: "assign_proposal", agentId: "a" }, { type: "redirect", agentId: "b" }, { type: "stop", agentId: "c" },
    ]);
    expect(planConvergence([{ agentId: "a", status: "running" }], root)).toMatchObject([{ type: "redirect", agentId: "a" }]);
  });
  it("rejects untrusted structured output and invalid assignments", () => {
    expect(parseCoordinatorDecision({ type: "root_cause_accepted", ...root }, "EXPLORE")).toEqual({ type: "root_cause_accepted", ...root });
    for (const value of [{ type: "complete", summary: "ok" }, { type: "root_cause_accepted", ...root, evidence: [] }, { type: "continue_exploration", text: "extra" }, "continue_exploration"])
      expect(() => parseCoordinatorDecision(value, "EXPLORE")).toThrow();
    expect(transition(backlog(), { type: "assign", tasks: [task("bad", "unknown")] }, workers)).toMatchObject({ ok: false, error: { type: "invalid_backlog" } });
  });
  it("keeps classified read-only answers out of every change phase", () => {
    const classified = step(createPhaseState(), { type: "classify", taskClass: "answer", workerCount: 1, language: "ko", reason: "Read-only explanation" });
    expect(classified).toMatchObject({ phase: "EXPLORE", taskClass: "answer", workerCount: 1, language: "ko" });
    const illegal: CoordinatorDecision[] = [
      { type: "root_cause_accepted", ...root }, { type: "collect_backlog" },
      { type: "assign", tasks: [task("change")] }, { type: "verify" },
      { type: "complete", summary: "unsupported completion" },
      { type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "Reclassification" },
    ];
    for (const decision of illegal) {
      expect(transition(classified, decision, workers)).toMatchObject({ ok: false, error: { type: "illegal_transition" } });
    }
    const answer = { type: "answer" as const, answer: "코드 근거에 기반한 설명", summary: "설명 완료" };
    expect(step(classified, answer)).toMatchObject({ phase: "DONE", answer: answer.answer, summary: answer.summary });
    expect(transition(createPhaseState(), answer)).toMatchObject({ ok: false, error: { type: "illegal_transition" } });
    expect(() => parseCoordinatorDecision({ type: "root_cause_accepted", ...root }, "EXPLORE", "answer")).toThrow();
  });
  it("allows direct classified changes but never skips mandatory verification", () => {
    let state = step(createPhaseState(), { type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "Clear requested change" });
    expect(state.phase).toBe("BACKLOG");
    expect(transition(state, { type: "root_cause_accepted", ...root })).toMatchObject({ ok: false, error: { type: "illegal_transition" } });
    state = step(state, { type: "assign", tasks: [task("change")] });
    expect(transition(state, { type: "complete", summary: "unverified" })).toMatchObject({ ok: false, error: { type: "illegal_transition" } });
    expect(transition(state, { type: "answer", answer: "unverified", summary: "unverified" })).toMatchObject({ ok: false, error: { type: "illegal_transition" } });
  });
  it("bounds classification worker selection to one through three", () => {
    for (const workerCount of [0, 4, 1.5]) {
      const classification = { type: "classify" as const, taskClass: "change" as const, workerCount, language: "en", reason: "Clear change" };
      expect(transition(createPhaseState(), classification)).toMatchObject({ ok: false, error: { type: "invalid_classification" } });
      expect(() => parseCoordinatorDecision(classification, "EXPLORE")).toThrow();
    }
  });
  it("passes through only an existing completed worker answer, preserving its full text", () => {
    const state = step(createPhaseState(), { type: "classify", taskClass: "answer", workerCount: 1, language: "ko", reason: "Read-only explanation" });
    const original = "# 환불 설명\n\n코드 근거: src/refunds.js:14–29.\n경계 조건과 원본 데이터의 보존을 설명합니다.";
    const approval = { type: "answer_from_worker" as const, sourceAgentId: "a", summary: "설명 승인" };
    expect(transition(state, approval, [{ agentId: "a", status: "idle", answer: original }])).toMatchObject({ ok: true, state: { phase: "DONE", answer: original } });
    expect(transition(state, approval, workers)).toMatchObject({ ok: false, error: { type: "invalid_answer_source", agentId: "a" } });
    expect(transition(state, { ...approval, sourceAgentId: "unknown" }, workers)).toMatchObject({ ok: false, error: { type: "invalid_answer_source", agentId: "unknown" } });
    expect(transition(state, approval, [{ agentId: "a", status: "idle", answer: "  " }])).toMatchObject({ ok: false, error: { type: "invalid_answer_source" } });
  });
  it("normalizes recursive areas before detecting real cross-worker ownership conflicts", () => {
    const state = backlog();
    const tasks = [{ ...task("shared"), files: ["./src/**"] }, { ...task("caller", "b"), files: ["src/tax.js"] }];
    expect(transition(state, { type: "assign", tasks }, workers)).toMatchObject({
      ok: false, error: { type: "invalid_backlog", issues: [{ type: "file_overlap", taskIds: ["shared", "caller"], files: ["src/", "src/tax.js"] }] },
    });
    const sameOwner = [{ ...task("shared"), files: ["src/**/*", "test\\**"] }];
    const assigned = transition(state, { type: "assign", tasks: sameOwner }, workers);
    expect(assigned).toMatchObject({ ok: true, state: { tasks: [{ files: ["src/", "test/"] }] } });
    expect(tasks[0]!.files).toEqual(["./src/**"]);
  });
  it("replan returns a blocked EXECUTE backlog to BACKLOG within the fix cap, then fails", () => {
    const executing = step(backlog(), { type: "assign", tasks: [task("t")] });
    expect(transition(executing, { type: "replan", reason: "interface missing" })).toMatchObject({ ok: true, state: { phase: "BACKLOG", fixRounds: 1 } });
    const exhausted = { ...executing, fixRounds: executing.maxFixRounds };
    expect(transition(exhausted, { type: "replan", reason: "still blocked" })).toMatchObject({ ok: true, state: { phase: "FAILED", failure: "still blocked" } });
    expect(transition(backlog(), { type: "replan", reason: "x" })).toMatchObject({ ok: false, error: { type: "illegal_transition" } });
    expect(parseCoordinatorDecision({ type: "replan", reason: "x" }, "EXECUTE")).toEqual({ type: "replan", reason: "x" });
  });
  it("rejects ambiguous unsupported ownership globs instead of silently failing the write audit", () => {
    const tasks = [{ ...task("ambiguous"), files: ["src/*.js"] }];
    expect(transition(backlog(), { type: "assign", tasks }, workers)).toMatchObject({ ok: false, error: { type: "invalid_ownership" } });
    expect(() => parseCoordinatorDecision({ type: "assign", tasks }, "BACKLOG")).toThrow("Unsupported ownership path");
  });
});

describe("canonical backlog", () => {
  it("dedupes normalized title and file sets while keeping attribution and dependency refs", () => {
    const first = { title: " Fix   Login ", description: "first", files: ["./src/auth.ts", "src/b.ts"], dependsOn: ["base"] };
    const second = { title: "fix login", description: "second", files: ["src/b.ts", "src/auth.ts"], dependsOn: ["schema"] };
    const result = dedupeProposals([{ sourceAgentId: "a", items: [first] }, { sourceAgentId: "b", items: [second] }]);
    expect(result).toEqual([{ ...first, files: ["src/auth.ts", "src/b.ts"], dependsOn: ["base", "schema"], sourceAgentIds: ["a", "b"] }]);
    expect(first.files).toEqual(["./src/auth.ts", "src/b.ts"]);
    expect(dedupeProposals([{ sourceAgentId: "a", items: [first, { ...first, files: ["src/other.ts"] }] }])).toHaveLength(2);
  });
  it("finds unknown/missing owners, missing deps and dependency cycles", () => {
    const missing = { id: "missing", description: "x", files: [], status: "pending" as const };
    const issues = validateBacklog([task("a", "alien", ["b", "absent"]), task("b", "a", ["a"]), missing], ["a"]);
    expect(issues).toEqual(expect.arrayContaining([
      { type: "unknown_owner", taskId: "a", owner: "alien" }, { type: "missing_owner", taskId: "missing" },
      { type: "unknown_dependency", taskId: "a", dependencyId: "absent" }, { type: "dependency_cycle", taskIds: ["a", "b", "a"] },
    ]));
    expect(validateBacklog([task("self", "a", ["self"])], ["a"])).toContainEqual({ type: "dependency_cycle", taskIds: ["self", "self"] });
  });
  it("enforces exact and directory-prefix ownership without false sibling matches", () => {
    const a = { ...task("a"), files: ["src/auth/", "src/shared.ts"] };
    const b = { ...task("b", "b"), files: ["src/auth/x.ts", "./src/shared.ts", "src/authentication/x.ts"] };
    expect(validateBacklog([a, b], ["a", "b"]).filter(issue => issue.type === "file_overlap")).toEqual([
      { type: "file_overlap", taskIds: ["a", "b"], files: ["src/auth/", "src/auth/x.ts"] },
      { type: "file_overlap", taskIds: ["a", "b"], files: ["src/shared.ts", "./src/shared.ts"] },
    ]);
    expect(validateBacklog([a, { ...b, owner: "a" }], ["a"])).toEqual([]);
  });
  it("respects dependency completion, retains stable readiness order and detects stalled work", () => {
    const tasks = [task("dependent", "a", ["base"]), task("base"), task("independent")];
    expect(readyTasks(tasks).map(item => item.id)).toEqual(["base", "independent"]);
    const doneBase = updateTaskStatus(tasks, "base", "done");
    expect(readyTasks(doneBase).map(item => item.id)).toEqual(["dependent", "independent"]);
    expect(tasks[1]!.status).toBe("pending");
    expect(() => updateTaskStatus(tasks, "absent", "done")).toThrow("Unknown task");
    expect(isBacklogBlocked([{ ...task("base"), status: "blocked" }, task("dependent", "a", ["base"])])).toBe(true);
    expect(isBacklogBlocked([{ ...task("base"), status: "running" }])).toBe(false);
    expect(isBacklogDone(doneBase)).toBe(false);
    expect(isBacklogDone(doneBase.map(item => ({ ...item, status: "done" })))).toBe(true);
    expect(isBacklogBlocked([])).toBe(false);
  });
});

describe("model routing", () => {
  it("uses role route then fallback, without inherited role lookups", () => {
    const config = parseRouteConfig({ routes: { scout: { model: "provider/fast", thinking: "low" } }, default: { model: "other/fallback" } });
    expect(resolveRoute(config, "scout")).toEqual({ role: "scout", model: "provider/fast", thinking: "low" });
    expect(resolveRoute(config, "toString")).toEqual({ role: "toString", model: "other/fallback" });
    expect(() => resolveRoute(parseRouteConfig({ routes: {} }), "missing")).toThrow("no default");
  });
  it("rejects invalid model refs, effort values and config shapes with useful errors", () => {
    for (const model of ["model", "/model", "provider/", "provider/model:low", "a /b"])
      expect(() => parseRouteConfig({ routes: { worker: { model } } })).toThrow("config.routes.worker.model");
    expect(() => parseRouteConfig({ routes: {}, default: { model: "p/m", thinking: "extreme" } })).toThrow("thinking");
    expect(() => parseRouteConfig({ routes: [] })).toThrow("config.routes");
    expect(() => parseRouteConfig({ routes: {}, typo: true })).toThrow("unknown field");
  });
  it("parses the worker team and bounds classification by its maxWorkers", () => {
    expect(parseRouteConfig({ routes: {}, workers: { maxWorkers: 5, explorerRoles: ["explorer-a", "explorer-b"], answerAngles: ["one"] } }).workers)
      .toEqual({ maxWorkers: 5, explorerRoles: ["explorer-a", "explorer-b"], answerAngles: ["one"] });
    for (const workers of [{ maxWorkers: 0 }, { maxWorkers: 9 }, { maxWorkers: 2.5 }, { explorerRoles: [] }, { explorerRoles: ["has space"] }, { answerAngles: ["a", "a"] }, { typo: 1 }, []])
      expect(() => parseRouteConfig({ routes: {}, workers })).toThrow("config.workers");
    const classify = (workerCount: number) => ({ type: "classify" as const, taskClass: "change" as const, workerCount, language: "en", reason: "r" });
    expect(transition(createPhaseState(), classify(4))).toMatchObject({ ok: false, error: { type: "invalid_classification" } });
    expect(transition(createPhaseState(1, 5), classify(5))).toMatchObject({ ok: true, state: { workerCount: 5 } });
    expect(() => parseCoordinatorDecision(classify(5), "EXPLORE")).toThrow();
    expect(parseCoordinatorDecision(classify(5), "EXPLORE", undefined, 5)).toEqual(classify(5));
    expect(explorerRolesFor(resolveTeam({ explorerRoles: ["x", "y"] }), 3)).toEqual(["x", "y", "x"]);
    expect(resolveTeam()).toEqual(defaultTeam);
    expect(workerCountGuidance(1)).toBe("workerCount MUST be 1.");
    expect(workerCountGuidance(5)).toContain("1–5");
  });
  it("parses verifyCommands and the verifier uses them instead of discovering checks", () => {
    expect(parseRouteConfig({ routes: {}, verifyCommands: [" npm test ", "npm run lint"] }).verifyCommands).toEqual(["npm test", "npm run lint"]);
    for (const verifyCommands of [[], [""], "npm test", Array(9).fill("x")])
      expect(() => parseRouteConfig({ routes: {}, verifyCommands })).toThrow("config.verifyCommands");
    expect(verificationPrompt("p", [], ["npm test"])).toContain('Run the configured project checks via bash: "npm test"');
    const discovered = verificationPrompt("p", []);
    expect(discovered).toContain("Discover the project's own test and check commands");
    expect(discovered).not.toContain("node --test");
    expect(proposalPrompt("cause", [])).toContain("dependsOn:[titles of other items in this proposal]");
  });
  it("parses overrides with optional thinking and applies last override immutably", () => {
    expect(parseRouteOverride("investigator=openai/gpt-6-luna:low")).toEqual({ role: "investigator", model: "openai/gpt-6-luna", thinking: "low" });
    expect(parseRouteOverride("worker=p/m")).toEqual({ role: "worker", model: "p/m" });
    for (const invalid of ["=p/m", "role=bad", "role=p/m:bad", "role=p/m:low:high", "role=p/m=extra"]) expect(() => parseRouteOverride(invalid)).toThrow();
    const original = parseRouteConfig({ routes: { worker: { model: "p/old" } } });
    const changed = applyRouteOverrides(original, ["worker=p/first:low", "worker=p/last"]);
    expect(resolveRoute(changed, "worker")).toEqual({ role: "worker", model: "p/last" });
    expect(resolveRoute(original, "worker").model).toBe("p/old");
  });
  it("loads JSON routes and reports missing files and malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orche-routes-"));
    const path = join(directory, "routes.json");
    try {
      await writeFile(path, JSON.stringify({ routes: { test: { model: "p/m" } } }));
      expect(resolveRoute(await loadRouteConfig(path), "test")).toEqual({ role: "test", model: "p/m" });
      await writeFile(path, "{");
      await expect(loadRouteConfig(path)).rejects.toThrow("Cannot load route config");
      await expect(loadRouteConfig(join(directory, "absent"))).rejects.toThrow("Cannot load route config");
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
