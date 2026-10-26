import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha } from "../../experiments/mdsd-ab/run.js";
import { acquireLock, driverStatus, runDriver } from "../../experiments/cb-ab/driver.js";
import {
  AGENT, BIN_MOUNT, HOME, PI_CLI, PROVIDER_PKG, REPO, SCRATCH_MOUNT, agentDir, catalogEntry, digestOf, freezeHarness, freezeRuntime, harnessFiles, harnessIntact, loadCase,
  makeTarget, piArgs, pythonWrappers, rootAnchors, sandboxArgs, sandboxCommand, targetMount, venvMount,
} from "../../experiments/cb-ab/env.js";
import {
  auditTranscripts, compliance, contentHashes, explorerIds, finalReport, redactTree, requestViolations, routeFidelity, sessionTranscripts, targetCheck, usageByRole, type WireEntry,
} from "../../experiments/cb-ab/evidence.js";
import { main, parseSandboxCheck, prepare, runUnit, sandboxCheckScript, writeToyCase } from "../../experiments/cb-ab/run.js";
import { summarize, terminalOf } from "../../experiments/cb-ab/summarize.js";
import {
  ARMS, CB_BRIEF, EXPLORER_NAME, GENERIC_BRIEF, LIMITS, MODEL, MODEL_REF, THINKING, armSuffix, diagnosisPrompt, oneShot, orcheConfig, units,
} from "../../experiments/cb-ab/protocol.js";

/**
 * The cb-ab model-run harness (experiments/cb-ab/run.ts, driver.ts, summarize.ts, env.ts, evidence.ts) without any model:
 * protocol invariants as the harness applies them, the schedule, route fidelity, compliance, the audit, the final report, the frozen
 * runtime/harness, the sandbox, the driver (resume, infra retry, stop) and the summary.
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "cb-ab-test-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
const jsonl = (file: string, entries: unknown[]) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n")); };
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const PROMPT = diagnosisPrompt({ repo: "example/x", baseCommit: "abc123", problemStatement: "f() fails for results/ paths\r\nsee https://example.com/issue" });
const ISORT_VENV = join(REPO, "results/advisor-reviewer/cache/swe/pycqa__isort-2491/venv");
const hasBwrap = spawnSync("bwrap", ["--version"]).status === 0 && existsSync(join(HOME, ".nvm")) && existsSync(join(HOME, ".bun"));

describe("protocol invariants as the harness applies them", () => {
  it("A has no suffix; B and C carry their brief verbatim and differ only in brief and explorer name", () => {
    expect(armSuffix("A")).toBe("");
    expect(oneShot("A", PROMPT)).toBe(`/orche strong ${PROMPT}`);
    for (const [arm, brief, other] of [["B", CB_BRIEF, GENERIC_BRIEF], ["C", GENERIC_BRIEF, CB_BRIEF]] as const) {
      const shot = oneShot(arm, PROMPT);
      expect(shot.startsWith(`/orche strong ${PROMPT}\n`)).toBe(true);
      expect(shot).toContain(`BEGIN BRIEF\n${brief}\nEND BRIEF`);
      expect(shot).not.toContain(other);
      expect(shot).toContain(`name: "${EXPLORER_NAME[arm]}", role: "answer"`);
    }
    const neutral = (arm: "B" | "C") => armSuffix(arm).replace(arm === "B" ? CB_BRIEF : GENERIC_BRIEF, "<brief>").replace(EXPLORER_NAME[arm], "<name>");
    expect(neutral("B")).toBe(neutral("C"));
  });

  it("orche config: every tier on Sol/high, no advisor, Bash review off, fixed thinking policy with redecompose, the protocol limits; no xhigh/max anywhere", () => {
    const config = orcheConfig() as any;
    const tier = { model: MODEL_REF, thinking: THINKING };
    expect(MODEL_REF).toBe("cliproxyapi/gpt-6.1-sol");
    expect(THINKING).toBe("high");
    expect(config.default).toEqual(tier);
    expect(Object.keys(config.models).sort()).toEqual(["advisor", "main", "orchestrator", "strong-orchestrator", "strong-worker", "worker"]);
    for (const value of Object.values(config.models)) expect(value).toEqual(tier);
    expect(config.routes).toEqual({});
    expect(config.bashReview).toEqual({ enabled: false });
    expect(config.thinkingPolicy).toEqual({ mode: "fixed", lengthRecovery: "redecompose" });
    expect(config.single).toMatchObject({ advisor: false, ledger: false, spawn: true });
    expect(config.concurrentSessions).toEqual({ enabled: false });
    expect(config.limits).toEqual(LIMITS.orche);
    expect(JSON.stringify(config)).not.toMatch(/xhigh|"max"/);
  });

  it("the unit's agent dir: Sol/high settings, orche.config.json = orcheConfig() exactly, no stored login, the provider pointed at the unit's proxy; the Pi command at high", async () => {
    const dir = await temp(), live = join(dir, "live"), catalog = join(dir, "catalog");
    mkdirSync(live); mkdirSync(catalog);
    writeFileSync(join(live, "cliproxyapi.json"), JSON.stringify({ apiKey: "sk-test-0123456789abcdef", baseUrl: "http://127.0.0.1:8317", providerId: "cliproxyapi" }));
    writeFileSync(join(live, "auth.json"), JSON.stringify({ cliproxyapi: { type: "oauth", access: "access-token-0123456789", refresh: "refresh-token-0123456789" } }));
    writeFileSync(join(catalog, "cliproxyapi-models.json"), JSON.stringify([{ id: MODEL.id }]));
    const agent = agentDir(dir, catalog, "http://127.0.0.1:4444", live);
    expect(JSON.parse(readFileSync(join(agent.dir, "settings.json"), "utf8"))).toMatchObject({ defaultProvider: "cliproxyapi", defaultModel: "gpt-6.1-sol", defaultThinkingLevel: "high", transport: "sse" });
    expect(readFileSync(join(agent.dir, "orche.config.json"), "utf8")).toBe(`${JSON.stringify(orcheConfig(), null, 2)}\n`);
    expect(JSON.parse(readFileSync(join(agent.dir, "auth.json"), "utf8"))).toEqual({});
    expect(JSON.parse(readFileSync(join(agent.dir, "cliproxyapi.json"), "utf8"))).toEqual({ baseUrl: "http://127.0.0.1:4444", providerId: "cliproxyapi" });
    expect(agent.apiKey).toBe("sk-test-0123456789abcdef");
    expect(agent.secrets).toEqual(expect.arrayContaining(["sk-test-0123456789abcdef", "access-token-0123456789", "refresh-token-0123456789"]));
    expect(existsSync(join(agent.dir, "cliproxyapi-models.json"))).toBe(true);
    // No credential is written anywhere in the unit (the key reaches Pi through CLIPROXYAPI_API_KEY only).
    for (const name of readdirSync(agent.dir)) if (name !== "sessions") for (const secret of agent.secrets) expect(readFileSync(join(agent.dir, name), "utf8")).not.toContain(secret);
    const command = piArgs("sid-1", "PROMPT");
    expect(command.slice(-1)).toEqual(["PROMPT"]);
    expect(command.join(" ")).toContain("--model cliproxyapi/gpt-6.1-sol --thinking high --mode json --session-id sid-1");
    expect(command.join(" ")).not.toMatch(/xhigh|\bmax\b/);
  });

  it("catalog: high must map to effort high; the list prices are the entry's", async () => {
    const dir = await temp();
    const entry = { id: MODEL.id, cost: { input: 2, output: 10, cacheRead: 0.1 }, thinkingLevelMap: { high: "high", xhigh: "xhigh" } };
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ models: [entry] }));
    expect(catalogEntry(join(dir, "ok.json")).prices).toEqual({ [MODEL.id]: entry.cost });
    writeFileSync(join(dir, "bad.json"), JSON.stringify([{ ...entry, thinkingLevelMap: { high: "xhigh" } }]));
    expect(() => catalogEntry(join(dir, "bad.json"))).toThrow(/not mapped/);
  });
});

describe("schedule", () => {
  it("is deterministic: 3 cases x 3 arms x 2 repeats, case-major then repeat-major, a seeded arm permutation per block, input order irrelevant", () => {
    const cases = [{ id: "c2", order: 2 }, { id: "c1", order: 1 }, { id: "c3", order: 3 }];
    const first = units(cases), second = units([...cases].reverse());
    expect(first).toEqual(second);
    expect(first).toHaveLength(18);
    expect(first.map(unit => `${unit.caseId}/r${unit.repeat}`)).toEqual(["c1", "c2", "c3"].flatMap(id => [1, 2].flatMap(repeat => Array(3).fill(`${id}/r${repeat}`))));
    for (let block = 0; block < 6; block++) expect(first.slice(block * 3, block * 3 + 3).map(unit => unit.arm).sort()).toEqual([...ARMS]);
    expect(first.every(unit => unit.id === `${unit.caseId}/${unit.arm}/r${unit.repeat}`)).toBe(true);
  });
});

// ---- synthetic transcripts -------------------------------------------------------------------------------------------------------
const assistant = (content: unknown[], model = "gpt-6.1-sol") => ({ type: "message", timestamp: "2026-10-24T00:00:02Z", message: { role: "assistant", provider: "cliproxyapi", model, content } });
const head = (id: string, thinking = "high") => [{ type: "session", id, timestamp: "2026-10-24T00:00:00Z" }, { type: "model_change", provider: "cliproxyapi", modelId: "gpt-6.1-sol" }, { type: "thinking_level_change", thinkingLevel: thinking }];
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const spawnCall = (id: string, args: unknown) => assistant([{ type: "toolCall", id, name: "orche_spawn", arguments: args }]);
const toolResult = (id: string, text: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "orche_spawn", content: [{ type: "text", text }], isError } });
const ok = (id: number, session: string, extra: Partial<WireEntry> = {}): WireEntry => ({ id, method: "POST", model: "gpt-6.1-sol", effort: "high", session, status: 200, respModel: "gpt-6.1-sol", finalModel: "gpt-6.1-sol", usage: { input: 100, cached: 50, output: 10, reasoning: 5 }, costUSD: 0.001, ...extra });

async function runFixture(options: { arm: "A" | "B" | "C"; request?: string; refusedFirst?: boolean; explorerThinking?: string }) {
  const root = await temp();
  const records = join(root, "records/main-sid"), name = options.arm === "A" ? "helper" : EXPLORER_NAME[options.arm];
  const brief = options.arm === "C" ? GENERIC_BRIEF : CB_BRIEF;
  const request = options.request ?? `${brief}\n\n${PROMPT}`;
  const calls = [
    ...(options.refusedFirst ? [spawnCall("c0", { reason: "parallelism", workers: [{ name, role: "answer", request }] }), toolResult("c0", "reason parallelism needs two or more workers", true)] : []),
    spawnCall("c1", { reason: "isolation", workers: [{ name, role: "answer", request }] }), toolResult("c1", `W1.1 ${name}: done`),
    assistant([{ type: "toolCall", id: "r1", name: "report_result", arguments: { kind: "answer", summary: "final defect report" } }]),
  ];
  jsonl(join(records, "workers/W1-2026-10-24T00-00-01-000Z.jsonl"), [...head("w1-sid"), user("Assignment: answer."), ...calls]);
  jsonl(join(records, "workers/W1.1-2026-10-24T00-00-03-000Z.jsonl"), [...head("w11-sid", options.explorerThinking), user(`Assignment: answer.\nYou are sub-worker W1.1 ("${name}") of orchestrator W1, spawned for isolation.`), assistant([{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "python -c 'import tinystats'" } }])]);
  jsonl(join(root, "sessions/--home-arthur-Code-x--/2026-10-24T00-00-00-000Z_main-sid.jsonl"), [...head("main-sid"), user(oneShot(options.arm, PROMPT)), assistant([{ type: "text", text: "done" }])]);
  const tasks = [{ file: "main-sid/t/run.json", run: { kind: "task", worker: { id: "W1" }, status: "done", start: "2026-10-24T00:00:01Z", outcome: { status: "completed", spawned: [{ id: "W1.1", name, role: "answer", reason: "isolation", status: "done", requests: 2, costUSD: 0.5 }] }, agents: [{ id: "W1.1", status: "completed", requests: 2 }] } }];
  const transcripts = sessionTranscripts("main-sid", join(root, "records"), join(root, "sessions"));
  const wire = [ok(1, "main-sid"), ok(2, "w1-sid"), ok(3, "w11-sid", { costUSD: 0.25 }), ok(4, "w11-sid", { costUSD: 0.5 }), { id: 5, method: "GET", path: "/v1/models", status: 200 }];
  return { root, transcripts, tasks, wire };
}

describe("route fidelity on the wire", () => {
  it("classifies wrong model, wrong effort, an xhigh configuration_update, a missing response model and an unattributed request; a clean request has none", async () => {
    const { transcripts, tasks, wire } = await runFixture({ arm: "B" });
    expect(requestViolations(ok(1, "main-sid"))).toEqual([]);
    const bad: WireEntry[] = [
      ok(10, "main-sid", { model: "gpt-6-astra", respModel: "gpt-6-astra", finalModel: "gpt-6-astra" }),
      ok(11, "w1-sid", { effort: "medium" }),
      ok(12, "w1-sid", { updateEfforts: ["high", "xhigh"] }),
      { id: 13, method: "POST", model: "gpt-6.1-sol", effort: "high", session: "w11-sid", status: 502, error: "socket hang up" },
      ok(14, "nobody"),
    ];
    expect(requestViolations(bad[0]!).map(item => item.kind)).toEqual(["model", "response-model"]);
    expect(requestViolations(bad[2]!)).toEqual([{ kind: "update-effort", detail: "configuration_update effort xhigh", wire: 12, session: "w1-sid" }]);
    expect(requestViolations(bad[3]!).map(item => item.kind)).toEqual(["unverifiable"]);
    const explorers = explorerIds("B", transcripts, tasks);
    const clean = routeFidelity(wire, transcripts, explorers);
    expect(clean).toMatchObject({ ok: true, requests: 4, posts: 4, violations: [], byRole: { main: { requests: 1 }, orchestrator: { requests: 1 }, explorer: { requests: 2 } } });
    expect(clean.sessions.map(item => [item.agent, item.role, item.models, item.thinking, item.requests])).toEqual([["main", "main", [MODEL_REF], ["high"], 1], ["W1", "orchestrator", [MODEL_REF], ["high"], 1], ["W1.1", "explorer", [MODEL_REF], ["high"], 2]]);
    const route = routeFidelity([...wire, ...bad], transcripts, explorers);
    expect(route.ok).toBe(false);
    expect(route.byKind).toEqual({ model: 1, "response-model": 1, effort: 1, "update-effort": 1, unverifiable: 1, unattributed: 1 });
    expect(route.violations.find(item => item.kind === "unattributed")).toMatchObject({ wire: 14, role: "unattributed" });
    expect(route.violations.find(item => item.kind === "unverifiable")).toMatchObject({ wire: 13, agent: "W1.1", role: "explorer" });
  });

  it("checks every session's transcript too: a thinking change to xhigh in the explorer is a violation", async () => {
    const { transcripts, tasks, wire } = await runFixture({ arm: "B", explorerThinking: "xhigh" });
    const route = routeFidelity(wire, transcripts, explorerIds("B", transcripts, tasks));
    expect(route.violations).toEqual([expect.objectContaining({ kind: "session-thinking", agent: "W1.1", role: "explorer", detail: "thinking_level_change to xhigh" })]);
  });

  it("usage by role from the wire at list prices (main / orchestrator / explorer)", async () => {
    const { transcripts, tasks, wire } = await runFixture({ arm: "B" });
    const usage = usageByRole([...wire, ok(9, "nobody")], transcripts, explorerIds("B", transcripts, tasks));
    expect(usage.main).toMatchObject({ requests: 1, input: 100, cached: 50, output: 10, reasoning: 5, costUSD: 0.001 });
    expect(usage.orchestrator?.requests).toBe(1);
    expect(usage.explorer).toMatchObject({ requests: 2, costUSD: 0.75 });
    expect(usage.unattributed?.requests).toBe(1);
    expect(usage.total).toMatchObject({ requests: 5, costUSD: 0.753 });
  });
});

describe("compliance detector", () => {
  it("B: one isolation spawn of contract-backward with the brief and the prompt verbatim, its id, status, requests and cost", async () => {
    const { transcripts, tasks, wire } = await runFixture({ arm: "B" });
    const result = compliance("B", PROMPT, transcripts, tasks, wire);
    expect(result.spawns).toEqual([{ agent: "W1", at: "2026-10-24T00:00:02Z", reason: "isolation", names: ["contract-backward"], roles: ["answer"], ok: true }]);
    expect(result.explorer).toMatchObject({ name: "contract-backward", calls: 1, accepted: 1, reason: "isolation", role: "answer", workersInCall: 1, briefVerbatim: true, promptVerbatim: true, exact: true, extraChars: 0, ids: ["W1.1"], status: "done", orcheRequests: 2, orcheCostUSD: 0.5, wireRequests: 2, listCostUSD: 0.75, ran: true, form: true, compliant: true });
  });

  it("flags a paraphrased brief, a whitespace-only change and a refused call; C uses its generic brief; A only lists its spawns", async () => {
    const paraphrased = await runFixture({ arm: "B", request: `Use a contract-backward search.\n\n${PROMPT}` });
    expect(compliance("B", PROMPT, paraphrased.transcripts, paraphrased.tasks, paraphrased.wire).explorer).toMatchObject({ briefVerbatim: false, briefNormalized: false, promptVerbatim: true, compliant: false });
    const spaced = await runFixture({ arm: "B", request: `${CB_BRIEF.replace(/\n/g, "\n\n")}\n\n${PROMPT}` });
    expect(compliance("B", PROMPT, spaced.transcripts, spaced.tasks, spaced.wire).explorer).toMatchObject({ briefVerbatim: false, briefNormalized: true, compliant: false });
    const refused = await runFixture({ arm: "B", refusedFirst: true });
    const second = compliance("B", PROMPT, refused.transcripts, refused.tasks, refused.wire);
    expect(second.explorer).toMatchObject({ calls: 2, accepted: 1, ran: true, reason: "isolation", compliant: true });
    expect(second.spawns.map(item => item.ok)).toEqual([false, true]);
    const c = await runFixture({ arm: "C" });
    expect(compliance("C", PROMPT, c.transcripts, c.tasks, c.wire).explorer).toMatchObject({ name: "independent-explorer", briefVerbatim: true, compliant: true });
    expect(compliance("C", PROMPT, (await runFixture({ arm: "B" })).transcripts, c.tasks, c.wire).explorer).toMatchObject({ calls: 0, ran: false, compliant: false });
    const a = await runFixture({ arm: "A" });
    const none = compliance("A", PROMPT, a.transcripts, a.tasks, a.wire);
    expect(none.explorer).toBeUndefined();
    expect(none.spawns).toEqual([expect.objectContaining({ reason: "isolation", names: ["helper"], roles: ["answer"] })]);
  });
});

describe("final report and audit", () => {
  it("freezes the last report of the last completed orche task's worker, not W1's last report", () => {
    const sessions = new Map([["a", { agent: "W1", reports: [{ summary: "W1 partial" }] }], ["b", { agent: "W2", reports: [{ summary: "W2 first" }, { summary: "W2 final" }] }]]);
    const run = (worker: string, start: string, status: string) => ({ run: { worker: { id: worker }, start, status, outcome: { status: status === "done" ? "completed" : "failed" } } });
    expect(finalReport([run("W2", "2026-10-18T04:32:54Z", "done"), run("W1", "2026-10-18T02:49:13Z", "failed"), run("W1", "2026-10-18T03:51:53Z", "failed")], sessions)).toEqual({ summary: "W2 final" });
    expect(finalReport([run("W1", "2026-10-18T02:49:13Z", "done"), run("W2", "2026-10-18T03:00:00Z", "failed")], sessions)).toEqual({ summary: "W1 partial" });
    expect(finalReport([], sessions)).toEqual({ summary: "W1 partial" });
  });

  it("audits tool calls for the repository, results/, fixtures, hidden tests, orche's private records and network fetches; the given prompt and brief are masked", async () => {
    const { root, transcripts } = await runFixture({ arm: "B" });
    expect(auditTranscripts(transcripts, [PROMPT, CB_BRIEF])).toMatchObject({ calls: 3, hits: [], clean: true });
    expect(auditTranscripts(transcripts, []).byRule).toMatchObject({ results: 1 });
    jsonl(join(root, "records/main-sid/workers/W1.2-2026-10-24T00-00-09-000Z.jsonl"), [...head("w12-sid"), user('You are sub-worker W1.2 ("x")'), assistant([
      { type: "toolCall", name: "bash", arguments: { command: "cat /home/arthur/Code/oh-my-pi-extensions/orche/results/cb-ab/rubric.md" } },
      { type: "toolCall", name: "read", arguments: { path: "../../fixtures/advisor-bench/swe/x/hidden/test.patch" } },
      { type: "toolCall", name: "bash", arguments: { command: "ls ~/.pi/agent/orche/records; curl -s https://example.com" } },
      { type: "toolCall", name: "web_fetch", arguments: { url: "https://example.com" } },
      { type: "toolCall", name: "read", arguments: { path: "tests/fixtures/data.json" } },
      { type: "toolCall", name: "orche_task", arguments: { request: "see https://github.com/x/y/issues/1" } },
    ])]);
    const audit = auditTranscripts(sessionTranscripts("main-sid", join(root, "records"), join(root, "sessions")), [PROMPT, CB_BRIEF]);
    expect(audit.calls).toBe(9);
    expect(audit.byRule).toEqual({ repository: 1, results: 1, "frozen-mounts": 1, fixtures: 1, "hidden-or-reference": 1, "agent-private": 1, "network-command": 1, "network-url": 2, "network-tool": 1 });
    expect(audit.hits.every(hit => hit.agent === "W1.2")).toBe(true);
  });
});

describe("frozen runtime and harness", () => {
  it("runtime = git archive HEAD: an uncommitted edit, a staged edit and an untracked file never enter; files hashed from the extracted bytes", async () => {
    const repo = await temp(), out = await temp();
    mkdirSync(join(repo, "src/nested"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n"); writeFileSync(join(repo, "src/nested/c.ts"), "export const c = 3;\n");
    writeFileSync(join(repo, "package.json"), '{"name":"x"}\n'); writeFileSync(join(repo, "tsconfig.json"), "{}\n"); writeFileSync(join(repo, "README.md"), "not frozen\n");
    git(repo, ["init", "-q"]); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2; // uncommitted\n"); writeFileSync(join(repo, "src/b.ts"), "untracked\n");
    writeFileSync(join(repo, "package.json"), '{"name":"staged"}\n'); git(repo, ["add", "package.json"]);
    const runtime = join(out, "runtime");
    const frozen = freezeRuntime(repo, runtime);
    expect(readFileSync(join(runtime, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(runtime, "package.json"), "utf8")).toBe('{"name":"x"}\n');
    expect(existsSync(join(runtime, "src/b.ts"))).toBe(false);
    expect(existsSync(join(runtime, "README.md"))).toBe(false);
    expect(readdirSync(join(runtime, "node_modules"))).toEqual([]);
    const revision = JSON.parse(readFileSync(join(runtime, "REVISION.json"), "utf8"));
    expect(revision).toMatchObject({ source: "git archive HEAD", head: git(repo, ["rev-parse", "HEAD"]).trim(), digest: frozen.digest });
    expect(revision.files).toEqual({ "package.json": sha('{"name":"x"}\n'), "src/a.ts": sha("export const a = 1;\n"), "src/nested/c.ts": sha("export const c = 3;\n"), "tsconfig.json": sha("{}\n") });
    expect(revision.digest).toBe(digestOf(revision.files));
    expect(() => freezeRuntime(repo, runtime)).toThrow(/exists/);
  });

  it("harness: the cb-ab files and their experiments imports (and the spawned proxy) copied with the layout, hashed from the destination bytes, and the copy runs on its own", async () => {
    const out = await temp();
    expect(harnessFiles(REPO)).toEqual(expect.arrayContaining(["experiments/cb-ab/protocol.ts", "experiments/cb-ab/run.ts", "experiments/cb-ab/driver.ts", "experiments/cb-ab/summarize.ts", "experiments/cb-ab/env.ts", "experiments/cb-ab/evidence.ts", "experiments/ultra-ab/protocol.ts", "experiments/mdsd-ab/run.ts", "experiments/mdsd-ab/proxy.mjs"]));
    expect(harnessFiles(REPO).every(file => file.startsWith("experiments/"))).toBe(true);
    const harness = join(out, "harness");
    const frozen = freezeHarness(REPO, harness);
    const manifest = JSON.parse(readFileSync(join(harness, "harness.json"), "utf8"));
    expect(manifest).toMatchObject({ repo: REPO, entry: "experiments/cb-ab/run.ts", digest: frozen.digest });
    for (const [file, digest] of Object.entries(manifest.files)) expect(sha(readFileSync(join(harness, file)))).toBe(digest);
    expect(harnessIntact(harness)).toEqual([]);
    const check = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", join(harness, "experiments/cb-ab/run.ts"), "selfcheck"], { cwd: REPO }).toString());
    expect(check).toMatchObject({ running: join(harness, "experiments/cb-ab/run.ts"), frozenRoot: harness, repo: REPO, changed: [] });
    writeFileSync(join(harness, "experiments/cb-ab/evidence.ts"), `${readFileSync(join(harness, "experiments/cb-ab/evidence.ts"), "utf8")}\n// tampered\n`);
    expect(harnessIntact(harness)).toEqual(["experiments/cb-ab/evidence.ts"]);
    await expect(main(["unit", out, "case", "A", "1"])).rejects.toThrow(/differs from its harness.json: experiments\/cb-ab\/evidence.ts/);
  }, 60_000);

  it("refuses an import that leaves experiments/ (the copy must not need src/)", async () => {
    const repo = await temp();
    mkdirSync(join(repo, "experiments/cb-ab"), { recursive: true }); mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/y.ts"), "export const y = 1;\n");
    writeFileSync(join(repo, "experiments/cb-ab/x.ts"), 'import { y } from "../../src/y.js";\nexport const x = y;\n');
    expect(() => harnessFiles(repo)).toThrow(/outside experiments/);
  });

  it.skipIf(!existsSync(PI_CLI) || !existsSync(PROVIDER_PKG) || !existsSync(join(AGENT, "cliproxyapi-models.json")))("prepare on this repository: runtime equals HEAD (not the working tree), provider, harness, catalog, environment; a second prepare is refused", async () => {
    const study = join(await temp(), "study");
    const environment = prepare(study) as any;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();
    expect(environment.runtime).toMatchObject({ source: "git archive HEAD", head });
    for (const file of execFileSync("git", ["diff", "--name-only", "HEAD", "--", "src"], { cwd: REPO }).toString().split("\n").filter(Boolean).slice(0, 5)) {
      const committed = execFileSync("git", ["show", `HEAD:${file}`], { cwd: REPO });
      if (existsSync(join(study, "runtime", file))) expect(readFileSync(join(study, "runtime", file)).equals(committed)).toBe(true);
    }
    for (const file of execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src"], { cwd: REPO }).toString().split("\n").filter(Boolean)) expect(existsSync(join(study, "runtime", file))).toBe(false);
    expect(environment.catalog.entry.thinkingLevelMap.high).toBe("high");
    expect(environment.prices[MODEL.id]).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
    expect(environment.pi.version).toMatch(/^\d+\.\d+/);
    expect(existsSync(join(study, "provider/package.json"))).toBe(true);
    expect(harnessIntact(join(study, "harness"))).toEqual([]);
    expect(() => prepare(study)).toThrow(/already prepared/);
  }, 60_000);
});

describe("target, wrappers and sandbox", () => {
  it("target: a plain copy without .git; caches and orche's spill counted apart from real changes", async () => {
    const dir = await temp();
    mkdirSync(join(dir, "src/pkg/.git"), { recursive: true }); mkdirSync(join(dir, "src/.git"), { recursive: true });
    writeFileSync(join(dir, "src/pkg/a.py"), "a = 1\n"); writeFileSync(join(dir, "src/.git/HEAD"), "x"); writeFileSync(join(dir, "src/pkg/.git/x"), "y");
    makeTarget(join(dir, "src"), join(dir, "target"));
    const before = contentHashes(join(dir, "target"));
    expect(Object.keys(before)).toEqual(["pkg/a.py"]);
    mkdirSync(join(dir, "target/.pytest_cache"), { recursive: true }); writeFileSync(join(dir, "target/.pytest_cache/v"), "1");
    mkdirSync(join(dir, "target/.orche/artifacts"), { recursive: true }); writeFileSync(join(dir, "target/.orche/artifacts/x.txt"), "out");
    expect(targetCheck(before, contentHashes(join(dir, "target")))).toMatchObject({ unchanged: true, spill: 1, caches: [".pytest_cache/v"], added: [] });
    writeFileSync(join(dir, "target/pkg/a.py"), "a = 2\n"); writeFileSync(join(dir, "target/probe.py"), "");
    expect(targetCheck(before, contentHashes(join(dir, "target")))).toMatchObject({ unchanged: false, changed: ["pkg/a.py"], added: ["probe.py"] });
  });

  it.skipIf(!existsSync(join(ISORT_VENV, "bin/python")))("python wrappers: the venv with PYTHONPATH = the nearest project root (+ pythonPath), no bytecode; pip refuses", async () => {
    const dir = await temp();
    mkdirSync(join(dir, "proj/src/deep"), { recursive: true }); writeFileSync(join(dir, "proj/pyproject.toml"), "");
    expect(rootAnchors(join(dir, "proj"))).toEqual(["pyproject.toml"]);
    pythonWrappers(join(dir, "bin"), { venv: ISORT_VENV, fallbackRoot: "/fallback", anchors: ["pyproject.toml"], pythonPath: "src", binMount: join(dir, "bin") });
    const probe = "import os, sys; print(os.environ['PYTHONPATH']); print(sys.prefix); print(sys.dont_write_bytecode)";
    const env = { PATH: `${join(dir, "bin")}:/usr/bin:/bin` };
    expect(execFileSync(join(dir, "bin/python"), ["-c", probe], { cwd: join(dir, "proj/src/deep"), env }).toString().split("\n").slice(0, 3)).toEqual([`${join(dir, "proj")}/src`, ISORT_VENV, "True"]);
    expect(execFileSync(join(dir, "bin/python3"), ["-c", probe], { cwd: "/", env }).toString().split("\n")[0]).toBe("/fallback/src");
    expect(execFileSync(join(dir, "bin/pytest"), ["--version"], { cwd: join(dir, "proj"), env }).toString()).toMatch(/pytest \d/);
    expect(spawnSync(join(dir, "bin/pip"), ["install", "x"]).status).toBe(1);
  });

  it("sandbox args: private PID namespace, /tmp and home; target and venv at their mounts; the agent dir, wrappers and scratch bound; nothing of this repository but node_modules", async () => {
    const args = sandboxArgs({ agent: "/s/agent", target: "/s/target", projectDir: "proj", venv: "/v/venv", runtime: "/s/runtime", nodeModules: join(REPO, "node_modules"), provider: "/s/provider", scratch: "/s/scratch", bin: "/s/bin" });
    const pairs = (flag: string) => args.flatMap((arg, index) => arg === flag ? [[args[index + 1], args[index + 2]]] : []);
    expect(args.slice(0, 7)).toEqual(["--dev-bind", "/", "/", "--die-with-parent", "--unshare-pid", "--proc", "/proc"]);
    expect(args.indexOf(HOME)).toBeLessThan(args.indexOf("/s/agent"));
    expect(args.indexOf("/tmp")).toBeLessThan(args.indexOf(SCRATCH_MOUNT));
    expect(pairs("--bind")).toEqual([["/s/agent", join(HOME, ".pi/agent")], ["/s/target", targetMount("proj")], ["/s/scratch", SCRATCH_MOUNT]]);
    expect(pairs("--ro-bind")).toEqual(expect.arrayContaining([["/v/venv", venvMount("proj")], ["/s/bin", BIN_MOUNT], ["/s/runtime", join(HOME, ".local/share/orche-runtime")], ["/s/provider", join(HOME, ".local/share/cliproxyapi-provider")]]));
    expect(targetMount("proj")).toBe(join(HOME, "Code/proj"));
    expect(venvMount("proj")).toBe(join(HOME, ".venvs/proj"));
    expect(args.slice(-2)).toEqual(["--chdir", targetMount("proj")]);
    const sources = [...pairs("--bind"), ...pairs("--ro-bind")].map(pair => pair[0]!);
    expect(sources.filter(source => source.startsWith(REPO))).toEqual([join(REPO, "node_modules")]);
  });

  it.skipIf(!hasBwrap || !existsSync(join(ISORT_VENV, "bin/python")))("sandbox live: home hidden (only the mounts), /tmp private, target at ~/Code/<project>, the venv's python on PATH, no git work tree, pip refused, the repository invisible, no host path in the process list", async () => {
    const dir = await temp();
    for (const name of ["agent", "runtime/node_modules", "provider", "scratch"]) mkdirSync(join(dir, name), { recursive: true });
    mkdirSync(join(dir, "target/pkg"), { recursive: true }); writeFileSync(join(dir, "target/pyproject.toml"), ""); writeFileSync(join(dir, "target/pkg/marker.txt"), "visible");
    pythonWrappers(join(dir, "bin"), { venv: venvMount("proj"), fallbackRoot: targetMount("proj"), anchors: ["pyproject.toml"], pythonPath: "." });
    const box = sandboxArgs({ agent: join(dir, "agent"), target: join(dir, "target"), projectDir: "proj", venv: ISORT_VENV, runtime: join(dir, "runtime"), nodeModules: join(REPO, "node_modules"), provider: join(dir, "provider"), scratch: join(dir, "scratch"), bin: join(dir, "bin") });
    const env = { HOME, PATH: [BIN_MOUNT, "/usr/bin", "/bin"].join(":"), TMPDIR: "/tmp/pi-orche" };
    const script = ["/bin/sh", "-c", `${sandboxCheckScript()}\ncat pkg/marker.txt`];
    const run = sandboxCommand(box, join(dir, "sandbox.args"), script);
    expect(run.args.join(" ")).not.toContain(join(dir, "target"));
    const output = execFileSync(run.command, run.args, { env }).toString();
    const parsed = parseSandboxCheck(output, "proj");
    expect(parsed.problems).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(output.trim().endsWith("visible")).toBe(true);
    expect(Number(parsed.values.processes)).toBeLessThan(10);
    expect(parsed.values["pid1-options"]).toBe("--args 3 --");
    // Started with the arguments on its command line instead, the host paths show in the sandbox's process list: refused.
    expect(parseSandboxCheck(execFileSync("bwrap", [...box, "--", ...script], { env }).toString(), "proj").problems).toEqual([expect.stringMatching(/^host paths in the sandbox's process list/)]);
  });
});

describe("unit refusals and the toy case", () => {
  it("a measured unit needs manifest.json; a completed unit is never overwritten; an unfinished attempt is left to the driver", async () => {
    const study = await temp(), caseDir = join(study, "case");
    writeFileSync(join(study, "environment.json"), "{}");
    const venv = join(study, "venv/bin"); mkdirSync(venv, { recursive: true }); writeFileSync(join(venv, "python"), "");
    writeToyCase(caseDir);
    const spec = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8"));
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({ ...spec, venv: join(study, "venv") }));
    await expect(runUnit(study, caseDir, "A", 1, { preflight: false })).rejects.toThrow(/manifest\.json is missing/);
    await expect(runUnit(study, caseDir, "D", 1, { preflight: true })).rejects.toThrow(/arm must be/);
    mkdirSync(join(study, "runs/toy/A/r1"), { recursive: true }); writeFileSync(join(study, "runs/toy/A/r1/meta.json"), JSON.stringify({ status: "completed" }));
    await expect(runUnit(study, caseDir, "A", 1, { preflight: true })).rejects.toThrow(/never overwritten/);
    mkdirSync(join(study, "runs/toy/B/r1"), { recursive: true }); writeFileSync(join(study, "runs/toy/B/r1/meta.json"), JSON.stringify({ status: "running", pid: 999_999_999 }));
    await expect(runUnit(study, caseDir, "B", 1, { preflight: true })).rejects.toThrow(/earlier attempt/);
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({ ...spec, prompt: `${spec.prompt}!` }));
    expect(() => loadCase(caseDir)).toThrow(/promptSha256/);
  });

  it("toy case: case.json in the case format, the prompt from diagnosisPrompt, one planted defect (even-length median), the isort venv", async () => {
    const caseDir = join(await temp(), "toy-case");
    writeToyCase(caseDir);
    const loaded = loadCase(caseDir);
    expect(Object.keys(JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")))).toEqual(["id", "order", "task", "repo", "baseCommit", "projectDir", "pythonPath", "prompt", "promptSha256", "source", "venv"]);
    expect(loaded).toMatchObject({ id: "toy", order: 1, projectDir: "tinystats", pythonPath: ".", sourceDir: join(caseDir, "src"), venvDir: ISORT_VENV });
    expect(loaded.prompt).toContain("median() returns the wrong value for lists with an even number of elements");
    expect(loaded.prompt.startsWith("Read-only investigation of a bug report")).toBe(true);
    expect(readFileSync(join(caseDir, "src/tinystats/core.py"), "utf8")).toContain("return ordered[middle]");
    expect(() => writeToyCase(caseDir)).toThrow(/written once/);
  });
});

describe("redaction", () => {
  it("replaces every credential in every file (text or binary) and reports none left", async () => {
    const dir = await temp();
    mkdirSync(join(dir, "a/b"), { recursive: true });
    writeFileSync(join(dir, "a/b/events.jsonl"), '{"env":"CLIPROXYAPI_API_KEY=sk-secret-0123456789"}\n');
    writeFileSync(join(dir, "a/bin.dat"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("sk-secret-0123456789"), Buffer.from([255])]));
    writeFileSync(join(dir, "clean.txt"), "nothing");
    const result = redactTree(dir, ["sk-secret-0123456789", "short"]);
    expect(result.files.map(file => relative(dir, file)).sort()).toEqual(["a/b/events.jsonl", "a/bin.dat"]);
    expect(result.remaining).toEqual([]);
    expect(readFileSync(join(dir, "a/b/events.jsonl"), "utf8")).toBe('{"env":"CLIPROXYAPI_API_KEY=[REDACTED]"}\n');
    expect(readFileSync(join(dir, "a/bin.dat")).includes(Buffer.from("sk-secret"))).toBe(false);
  });
});

// ---- driver with a stand-in unit process (no model, no sandbox) ------------------------------------------------------------------
const FAKE_UNIT = `
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [study, caseDir, arm, repeat] = process.argv.slice(3);
const caseId = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")).id;
const dir = join(study, "runs", caseId, arm, "r" + repeat), unit = caseId + "/" + arm + "/r" + repeat;
const kept = existsSync(dirname(dir)) ? readdirSync(dirname(dir)).filter(name => name.startsWith("r" + repeat + ".")).length : 0;
const plan = JSON.parse(readFileSync(join(study, "plan.json"), "utf8"));
const behaviour = (plan[unit] ?? [])[kept] ?? "ok";
mkdirSync(dir, { recursive: true });
const meta = { unit, caseId, arm, repeat: Number(repeat), preflight: true, status: "running", pid: process.pid, startedAt: new Date().toISOString() };
const save = () => writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
save();
process.on("SIGTERM", () => { meta.status = "interrupted"; save(); process.exit(143); });
if (behaviour === "crash") { meta.status = "error"; meta.error = "boom: harness failure"; save(); process.exit(1); }
setTimeout(() => {
  const good = behaviour !== "infra";
  writeFileSync(join(dir, "wire.jsonl"), JSON.stringify(good ? { method: "POST", model: "gpt-6.1-sol", status: 200, usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, costUSD: 0.01 } : { method: "POST", model: "gpt-6.1-sol", status: 502 }) + "\\n");
  Object.assign(meta, { status: "completed", successfulRequests: good ? 1 : 0, infra: !good, pi: { code: 0, guardFired: false }, wallMs: 60000, usage: { total: { requests: 1, costUSD: good ? 0.01 : 0 }, main: { requests: 1, costUSD: good ? 0.01 : 0 } }, final: { report: good, reportChars: 10, textChars: 5 }, route: { ok: true, violations: 0, byKind: {} }, audit: { calls: 1, hits: 0, byRule: {} }, compliance: { arm, spawns: [], ...(arm === "A" ? {} : { explorer: { compliant: true, ran: true, verbatim: true, form: true, calls: 1, accepted: 1, briefVerbatim: true, promptVerbatim: true, status: "done", wireRequests: 1, listCostUSD: 0.005 } }) }, targetCheck: { unchanged: true, changed: [], removed: [], added: [] } });
  save();
  process.exit(0);
}, behaviour === "hang" ? 600000 : 30);
`;

async function fakeStudy(plan: Record<string, string[]>) {
  const study = await temp();
  writeFileSync(join(study, "environment.json"), "{}");
  writeFileSync(join(study, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(study, "fake-unit.mjs"), FAKE_UNIT);
  mkdirSync(join(study, "src")); mkdirSync(join(study, "venv/bin"), { recursive: true }); writeFileSync(join(study, "venv/bin/python"), "");
  const caseDirs = ["c1", "c2"].map((id, index) => {
    const dir = join(study, "cases", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "case.json"), JSON.stringify({ id, order: index + 1, task: id, repo: "r", baseCommit: "b", projectDir: "p", pythonPath: ".", prompt: `p-${id}`, promptSha256: sha(`p-${id}`), source: join(study, "src"), venv: join(study, "venv") }));
    return dir;
  });
  const command = (unit: { caseDir: string; arm: string; repeat: number }) => ({ command: process.execPath, args: [join(study, "fake-unit.mjs"), "unit", study, unit.caseDir, unit.arm, String(unit.repeat)] });
  return { study, caseDirs, command };
}
const logOf = (study: string) => readFileSync(join(study, "driver/driver.log"), "utf8");

describe("driver", () => {
  it("runs units(cases) N at a time with START/END lines and an atomic state; an infrastructure failure is kept as .infra-1 and rerun once; the summary totals per arm and case", async () => {
    const { study, caseDirs, command } = await fakeStudy({ "c1/B/r1": ["infra", "ok"], "c2/A/r2": ["infra", "infra"] });
    await expect(runDriver({ study, caseDirs, concurrency: 3, preflight: false, command })).rejects.toThrow(/manifest\.json is missing/);
    const result = await runDriver({ study, caseDirs, concurrency: 3, preflight: true, command });
    expect(result).toMatchObject({ completed: 12, failed: 0, interrupted: 0, pending: 0, stopped: false });
    const state = JSON.parse(readFileSync(join(study, "driver/state.json"), "utf8"));
    expect(state.units.map((unit: any) => unit.id)).toEqual(units([{ id: "c1", order: 1 }, { id: "c2", order: 2 }]).map(unit => unit.id));
    expect(state.units.find((unit: any) => unit.id === "c1/B/r1").attempts.map((attempt: any) => attempt.outcome)).toEqual(["infra", "completed"]);
    expect(existsSync(join(study, "runs/c1/B/r1.infra-1/meta.json"))).toBe(true);
    // At most LIMITS.infraRetries retries: the second infra attempt stays the unit's result.
    expect(LIMITS.infraRetries).toBe(1);
    expect(readdirSync(join(study, "runs/c2/A")).sort()).toEqual(["r1", "r2", "r2.infra-1"]);
    expect(JSON.parse(readFileSync(join(study, "runs/c2/A/r2/meta.json"), "utf8")).infra).toBe(true);
    const log = logOf(study);
    expect(log.match(/ START /g)).toHaveLength(14);
    expect(log.match(/ END .* completed/g)).toHaveLength(12);
    expect(log).toMatch(/INFRA c1\/B\/r1: no successful model request; attempt kept as r1\.infra-1; rerun/);
    expect(existsSync(join(study, "driver/lock.json"))).toBe(false);
    expect(driverStatus(study)).toMatch(/units: 12 — completed 12; kept attempts 2/);
    const { json, markdown } = summarize(study);
    expect((json.byArm as any).B).toMatchObject({ units: 4, completed: 4, ok: 4, compliant: 4 });
    expect((json.byCase as any).c2).toMatchObject({ units: 6, ok: 5 });
    expect((json.units as any[]).find(row => row.unit === "c2/A/r2")).toMatchObject({ terminal: "infra", attempts: { infra: 1, interrupted: 0 } });
    expect(markdown).toContain("| c1/B/r1 (preflight) [kept 1 infra, 0 interrupted] | ok |");
    expect(existsSync(join(study, "summary.md"))).toBe(true);
  });

  it("resumes: a completed unit is reused, an unfinished one is kept as .interrupted-1 and rerun, a failed one stays for the next start", async () => {
    const { study, caseDirs, command } = await fakeStudy({ "c1/C/r2": ["crash", "ok"] });
    mkdirSync(join(study, "runs/c1/A/r1"), { recursive: true });
    writeFileSync(join(study, "runs/c1/A/r1/meta.json"), JSON.stringify({ unit: "c1/A/r1", status: "completed", successfulRequests: 3, usage: { total: { requests: 3, costUSD: 1 } } }));
    mkdirSync(join(study, "runs/c1/B/r1"), { recursive: true });
    writeFileSync(join(study, "runs/c1/B/r1/meta.json"), JSON.stringify({ unit: "c1/B/r1", status: "running", pid: 999_999_999 }));
    const first = await runDriver({ study, caseDirs: [caseDirs[0]!], concurrency: 2, preflight: true, command });
    expect(first).toMatchObject({ completed: 5, failed: 1 });
    const log = logOf(study);
    expect(log).not.toMatch(/START c1\/A\/r1/);
    expect(log).toMatch(/RESUME c1\/B\/r1: the unfinished attempt \(running\) is kept as r1\.interrupted-1; rerun/);
    expect(log).toMatch(/END c1\/C\/r2 failed \(exit 1: boom: harness failure\)/);
    expect(existsSync(join(study, "runs/c1/B/r1.interrupted-1"))).toBe(true);
    const second = await runDriver({ study, caseDirs: [caseDirs[0]!], concurrency: 2, preflight: true, command });
    expect(second).toMatchObject({ completed: 6, failed: 0 });
    expect(readdirSync(join(study, "runs/c1/C")).sort()).toEqual(["r1", "r2", "r2.interrupted-1"]);
    const state = JSON.parse(readFileSync(join(study, "driver/state.json"), "utf8"));
    expect(state.units.find((unit: any) => unit.id === "c1/C/r2").attempts.map((attempt: any) => [attempt.outcome, attempt.keptAs])).toEqual([["failed", "r2.interrupted-1"], ["completed", undefined]]);
  });

  it("stopping the driver stops every running unit (process group), marks them interrupted and releases the lock; a live driver lock is refused", async () => {
    const { study, caseDirs, command } = await fakeStudy(Object.fromEntries(["A", "B", "C"].flatMap(arm => [1, 2].map(repeat => [`c1/${arm}/r${repeat}`, ["hang"]]))));
    const pids: number[] = [];
    const result = await runDriver({
      study, caseDirs: [caseDirs[0]!], concurrency: 2, preflight: true, command, killGraceMs: 5_000,
      onStarted: control => {
        const poll = setInterval(() => {
          const state = JSON.parse(readFileSync(join(study, "driver/state.json"), "utf8"));
          const running = state.units.filter((unit: any) => unit.status === "running" && unit.attempts.at(-1)?.pid);
          if (running.length === 2 && running.every((unit: any) => existsSync(join(unit.dir, "meta.json")))) { clearInterval(poll); pids.push(...running.map((unit: any) => unit.attempts.at(-1).pid)); control.stop("test stop"); }
        }, 20);
      },
    });
    expect(result).toMatchObject({ stopped: true, completed: 0, interrupted: 2, pending: 4 });
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    const state = JSON.parse(readFileSync(join(study, "driver/state.json"), "utf8"));
    expect(state.stopped).toBe("test stop");
    for (const unit of state.units.filter((item: any) => item.status === "interrupted")) expect(JSON.parse(readFileSync(join(unit.dir, "meta.json"), "utf8")).status).toBe("interrupted");
    expect(logOf(study)).toMatch(/STOP test stop: no new unit starts; stopping 2 running unit\(s\)/);
    expect(existsSync(join(study, "driver/lock.json"))).toBe(false);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "driver"], { stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      writeFileSync(join(study, "driver/lock.json"), JSON.stringify({ pid: holder.pid, startedAt: "x" }));
      await expect(runDriver({ study, caseDirs: [caseDirs[0]!], concurrency: 1, preflight: true, command })).rejects.toThrow(/another driver runs this study/);
    } finally { holder.kill("SIGKILL"); }
    writeFileSync(join(study, "driver/lock.json"), JSON.stringify({ pid: 999_999_999, startedAt: "x" }));
    const lines: string[] = [];
    const release = acquireLock(join(study, "driver/lock.json"), line => lines.push(line));
    expect(lines).toEqual(["stale lock of pid 999999999 replaced"]);
    release();
    expect(existsSync(join(study, "driver/lock.json"))).toBe(false);
  }, 30_000);
});

describe("summary", () => {
  it("terminal status: ok only with a report, exit 0 and no guard", () => {
    expect(terminalOf({ status: "completed", pi: { code: 0 }, final: { report: true } })).toBe("ok");
    expect(terminalOf({ status: "completed", pi: { code: 0, guardFired: true }, final: { report: true } })).toBe("guard");
    expect(terminalOf({ status: "completed", pi: { code: 0 }, final: { report: false } })).toBe("no-report");
    expect(terminalOf({ status: "completed", infra: true })).toBe("infra");
    expect(terminalOf({ status: "interrupted" })).toBe("interrupted");
  });
});
