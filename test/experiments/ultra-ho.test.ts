import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrcheConfigFile } from "../../src/extension/config.js";
import { MODEL_TIERS } from "../../src/orchestration/routing.js";
import { MAX_SUB_WORKERS } from "../../src/orchestrator/instructions.js";
import { ULTRA_STAGES as PRODUCT_STAGES } from "../../src/orchestrator/ultra.js";
import {
  DEFAULT_LIMITS, DEFAULT_PI_GUARD_MS, MODEL_REF, THINKING, TIERS, ULTRA_STAGES, armSettings, classifyWire, oneShot, orcheConfig, parsePlan, parseUltraLine,
  piSettings, planHash, reachedStage, schedule, unsupportedStageClaims, userPrompt, type Plan, type SessionInfo, type WireEntry,
} from "../../experiments/ultra-ho/protocol.js";
import { DEFAULT_SWE_CACHE_SOURCE, DEFAULT_SWE_FIXTURES, REPO, commitsOf, finalDiff, freezeRuntime, isSweTask, piArgs, prepareWorkspace, preserveWorkspace, readRevision, sha256, stageSweCache, sweRoots, verifyRuntime } from "../../experiments/ultra-ho/env.js";
import { assignmentLine, assignments, sessionMap } from "../../experiments/ultra-ho/evidence.js";
import { drive, unitEnv } from "../../experiments/ultra-ho/driver.js";
import { summarize } from "../../experiments/ultra-ho/summarize.js";
import { fixtureEvidence, reextract, type RunInput } from "../../experiments/ultra-ho/run-one.js";

/**
 * The ultra-ho harness (experiments/ultra-ho) without any model: the pinned route and config, the wire fidelity classifier, the
 * commit-free workspace and its final diff, the runtime freeze, the plan schedule, the evidence of orche assignments (carry,
 * adoption, gate, stage claims) from a synthetic records tree, and the driver's resume/retry rules with a fake unit runner.
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "ultra-ho-test-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => execFileSync("git", args, { cwd, ...(env ? { env } : {}), stdio: ["ignore", "pipe", "pipe"] }).toString();
const jsonl = (items: unknown[]) => `${items.map(item => JSON.stringify(item)).join("\n")}\n`;
const thinkingValues = (value: unknown): string[] => !value || typeof value !== "object" ? [] : Object.entries(value).flatMap(([key, item]) => key === "thinking" || key === "defaultThinkingLevel" ? [String(item)] : thinkingValues(item));

describe("the one route: cliproxyapi/gpt-6.1-sol at high everywhere", () => {
  it("pins every tier and the default route, never xhigh or max, with the plan's single, policy, review and session settings", () => {
    const config = orcheConfig() as any;
    expect(MODEL_REF).toBe("cliproxyapi/gpt-6.1-sol");
    expect(THINKING).toBe("high");
    expect([...TIERS].sort()).toEqual([...MODEL_TIERS].sort());
    for (const tier of MODEL_TIERS) expect(config.models[tier]).toEqual({ model: MODEL_REF, thinking: "high" });
    expect(config.default).toEqual({ model: MODEL_REF, thinking: "high" });
    expect(config.single).toEqual({ ledger: false, spawn: true, advisor: false });
    expect(config.thinkingPolicy).toEqual({ mode: "fixed", lengthRecovery: "redecompose" });
    expect(config.concurrentSessions).toEqual({ enabled: false });
    expect(config.bashReview).toEqual({ enabled: false });
    expect(config.limits).toEqual({ overallMs: 3_600_000, assignmentMs: 3_600_000, extensionMs: 900_000, extensionStepMs: 0, maxExtensions: 2, assignmentRequests: 300 });
    expect(DEFAULT_PI_GUARD_MS).toBe(150 * 60_000);
    const settings = piSettings();
    expect(settings).toMatchObject({ defaultProvider: "cliproxyapi", defaultModel: "gpt-6.1-sol", defaultThinkingLevel: "high", transport: "sse" });
    const levels = [...thinkingValues(config), ...thinkingValues(settings)];
    expect(levels.length).toBe(TIERS.length + 2);
    expect(new Set(levels)).toEqual(new Set(["high"]));
    expect(JSON.stringify(config)).not.toMatch(/xhigh|"max"/);
    const args = piArgs("/rt", "/provider", ["--mode", "json"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4)).toEqual(["--model", MODEL_REF, "--thinking", "high"]);
    expect(args).toEqual(expect.arrayContaining(["--no-extensions", "-e", "/provider/extensions/index.ts", "-e", "/rt/src/extension/index.ts"]));
    expect(args.join(" ")).not.toMatch(/xhigh|\bmax\b/);
  });

  it("the product's own config loader accepts it and resolves every tier, the policy, the review switch and the limits as pinned", async () => {
    const dir = await temp();
    const interrupted = armSettings({ limits: { overallMs: 720_000, assignmentMs: 720_000, maxExtensions: 0 }, piGuardMs: 5_400_000 });
    expect(interrupted).toEqual({ limits: { ...DEFAULT_LIMITS, overallMs: 720_000, assignmentMs: 720_000, maxExtensions: 0 }, piGuardMs: 5_400_000 });
    await writeFile(join(dir, "orche.config.json"), JSON.stringify(orcheConfig(interrupted.limits)));
    const loaded = await loadOrcheConfigFile(join(dir, "orche.config.json"));
    expect(loaded.warnings).toEqual([]);
    for (const tier of MODEL_TIERS) expect(loaded.routes.models?.[tier]).toEqual({ model: MODEL_REF, thinking: "high" });
    expect(loaded.routes.default).toEqual({ model: MODEL_REF, thinking: "high" });
    expect(loaded.routes.mainMode).toBe("single");
    expect(loaded.routes.limits).toEqual(interrupted.limits);
    expect(loaded.single).toMatchObject({ ledger: false, spawn: true, advisor: false, maxSubWorkers: MAX_SUB_WORKERS });
    expect(loaded.thinkingPolicy).toMatchObject({ mode: "fixed", lengthRecovery: "redecompose" });
    expect(loaded.bashReview.enabled).toBe(false);
    expect(loaded.concurrentSessions.enabled).toBe(false);
  });

  it("uses ultra-ab's prompt (same constraints text) and the one-shot mode word; the stage names are the product's", () => {
    const task = { id: "t", kind: "suite" as const, title: "T", instruction: "Fix Cart.totals.\n" };
    expect(oneShot("ultra", task)).toBe(`/orche ultra ${userPrompt(task)}`);
    expect(oneShot("strong", task)).toBe(`/orche strong ${userPrompt(task)}`);
    expect(userPrompt(task)).toContain("no git commits; no network access is needed or available; do not weaken, skip or delete existing tests. The result is graded afterwards by tests you do not see.");
    expect([...ULTRA_STAGES]).toEqual([...PRODUCT_STAGES]);
  });
});

describe("wire fidelity", () => {
  const sessions = new Map<string, SessionInfo>([["uho-main", { role: "main", agent: "main" }], ["s-w1", { role: "orchestrator", agent: "W1" }], ["s-w12", { role: "sub-worker", agent: "W1.2" }]]);
  const good = { method: "POST", path: "/backend-api/codex/responses", model: "gpt-6.1-sol", effort: "high", status: 200, respModel: "gpt-6.1-sol", finalModel: "gpt-6.1-sol", final: "response.completed", usage: { input: 1000, cached: 400, cacheWrite: 0, output: 50, reasoning: 10 }, costUSD: 0.002 };
  const entries: WireEntry[] = [
    { id: 1, at: "t", method: "GET", path: "/v1/models", status: 200 },
    { id: 2, at: "t", ...good, session: "uho-main" },
    { id: 3, at: "t", ...good, session: "s-w1", effort: "xhigh" },
    { id: 4, at: "t", ...good, session: "s-w12", updateEfforts: ["high", "max"] },
    { id: 5, at: "t", ...good, session: "s-w12", respModel: "gpt-6.1-sol", finalModel: "gpt-5.5" },
    { id: 6, at: "t", ...good, session: "s-w1", respModel: undefined, finalModel: undefined },
    { id: 7, at: "t", ...good, session: "s-w1", model: "bts/gpt-6.1-sol" },
    { id: 8, at: "t", ...good, session: "zzz" },
    { id: 9, at: "t", method: "POST", model: "gpt-6.1-sol", effort: "high", session: "s-w1", status: 429, providerError: { type: "rate_limit" } },
    { id: 10, at: "t", method: "GET", path: "/backend-api/codex/responses", upgrade: true },
    { id: 11, at: "t", method: "POST", path: "/backend-api/codex/responses", parseError: "SyntaxError", unparsed: 10 },
    { id: 12, at: "t", ...good, session: "s-w12", updateEfforts: ["high"], usage: undefined, costUSD: undefined },
  ];

  it("flags every request whose model, request effort, configuration_update effort or response model is not the route, by session", () => {
    const fidelity = classifyWire(entries, sessions);
    expect(fidelity.requests).toBe(9);
    expect(fidelity.ok).toBe(8);
    expect(fidelity.violations).toEqual([
      "#3 orchestrator W1: request effort xhigh",
      "#4 sub-worker W1.2: configuration_update effort max",
      "#5 sub-worker W1.2: response model gpt-5.5",
      "#6 orchestrator W1: response model unverifiable",
      "#7 orchestrator W1: model bts/gpt-6.1-sol",
      "#11 ?: unparsed POST /backend-api/codex/responses (model and effort unverifiable)",
    ]);
    expect(fidelity.unattributed).toEqual(["#8 zzz"]);
    expect(fidelity.upgradesRefused).toBe(1);
    expect(fidelity.providerErrors).toEqual([{ id: 9, status: 429, agent: "W1", error: { type: "rate_limit" } }]);
    expect(fidelity.efforts).toEqual({ high: 8, xhigh: 1 });
    expect(fidelity.updateEfforts).toEqual({ high: 2, max: 1 });
  });

  it("sums requests, usage and list-price USD per role and per session; missing usage is unknown, never zero", () => {
    const fidelity = classifyWire(entries, sessions);
    expect(fidelity.byRole.main).toMatchObject({ requests: 1, ok: 1, input: 1000, cached: 400, output: 50, costUSD: 0.002 });
    expect(fidelity.byRole.orchestrator).toMatchObject({ requests: 4, ok: 3, providerErrors: 1, costUSD: 0.006, unknownUsage: 1 });
    expect(fidelity.byRole["sub-worker"]).toMatchObject({ requests: 3, costUSD: 0.004, unknownUsage: 1 });
    expect(fidelity.byRole.unattributed).toMatchObject({ requests: 1, costUSD: 0.002 });
    expect(fidelity.bySession["W1.2"]).toMatchObject({ role: "sub-worker", key: "s-w12", requests: 3 });
    expect(fidelity.costUSD).toBe(0.014);
  });

  it("reads the copied pricing proxy's log: efforts, configuration_update efforts, response model and list price, no cap", async () => {
    const dir = await temp();
    const sse = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 20 } };
    const upstream = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sse({ type: "response.created", response: { model: "gpt-6.1-sol" } }, { type: "response.completed", response: { model: "gpt-6.1-sol", usage } })); }); });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const wire = join(dir, "wire.jsonl"), envelope = join(dir, "envelope.json");
    await writeFile(envelope, JSON.stringify({ capUSD: null, prices: { "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } } }));
    const proxy = spawn(process.execPath, [new URL("../../experiments/ultra-ho/proxy.mjs", import.meta.url).pathname, "0", `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, wire, envelope], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const port = await new Promise<number>((resolve, reject) => { let text = ""; proxy.stdout!.on("data", chunk => { text += String(chunk); const match = /PORT (\d+)/.exec(text); if (match) resolve(Number(match[1])); }); proxy.once("exit", code => reject(new Error(`proxy exited ${code}`))); });
      const send = (body: unknown) => fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }).then(res => res.arrayBuffer());
      for (let i = 0; i < 3; i++) await send({ model: "gpt-6.1-sol", reasoning: { effort: "high" }, prompt_cache_key: "uho-main", input: [] });
      await send({ model: "gpt-6.1-sol", reasoning: { effort: "high" }, prompt_cache_key: "s-w1", input: [{ type: "configuration_update", reasoning: { effort: "xhigh" } }] });
      let lines: WireEntry[] = [];
      for (let attempt = 0; attempt < 100 && lines.length < 4; attempt++) { await new Promise(resolve => setTimeout(resolve, 30)); lines = existsSync(wire) ? readFileSync(wire, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; }
      const fidelity = classifyWire(lines, sessions);
      expect(fidelity.requests).toBe(4);
      expect(fidelity.violations).toEqual([`#4 orchestrator W1: configuration_update effort xhigh`]);
      expect(fidelity.byRole.main!.costUSD).toBeCloseTo(3 * (600 * 2 + 400 * 0.1 + 100 * 10) / 1e6, 9);
      expect(JSON.parse(readFileSync(`${wire}.totals.json`, "utf8"))).toMatchObject({ requests: 4, refused: 0, byUpdateEffort: { xhigh: 1 } });
    } finally { proxy.kill("SIGKILL"); upstream.closeAllConnections(); upstream.close(); }
  });

  it("the route guard refuses any model request off the pinned route before it reaches the upstream", async () => {
    const dir = await temp();
    let reached = 0;
    const upstream = http.createServer((req, res) => { reached++; req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-6.1-sol", usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`); }); });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const wire = join(dir, "wire.jsonl"), envelope = join(dir, "envelope.json");
    await writeFile(envelope, JSON.stringify({ capUSD: null, prices: { "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } }, route: { model: "gpt-6.1-sol", effort: "high" } }));
    const proxy = spawn(process.execPath, [new URL("../../experiments/ultra-ho/proxy.mjs", import.meta.url).pathname, "0", `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, wire, envelope], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const port = await new Promise<number>((resolve, reject) => { let text = ""; proxy.stdout!.on("data", chunk => { text += String(chunk); const match = /PORT (\d+)/.exec(text); if (match) resolve(Number(match[1])); }); proxy.once("exit", code => reject(new Error(`proxy exited ${code}`))); });
      const send = (body: unknown) => fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }).then(async res => ({ status: res.status, text: await res.text() }));
      expect((await send({ model: "gpt-6.1-sol", reasoning: { effort: "high" }, input: [] })).status).toBe(200);
      const wrongModel = await send({ model: "bts/gpt-6.1-sol", reasoning: { effort: "high" }, input: [] });
      expect(wrongModel.status).toBe(400);
      expect(wrongModel.text).toContain("route_refused");
      expect((await send({ model: "gpt-6.1-sol", reasoning: { effort: "xhigh" }, input: [] })).status).toBe(400);
      expect((await send({ model: "gpt-6.1-sol", reasoning: { effort: "high" }, input: [{ type: "configuration_update", reasoning: { effort: "xhigh" } }] })).status).toBe(400);
      let lines: WireEntry[] = [];
      for (let attempt = 0; attempt < 100 && lines.length < 4; attempt++) { await new Promise(resolve => setTimeout(resolve, 30)); lines = existsSync(wire) ? readFileSync(wire, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; }
      expect(reached).toBe(1);
      expect(lines.map(line => [line.model, (line as { refused?: string }).refused ?? null, line.status])).toEqual([["gpt-6.1-sol", null, 200], ["bts/gpt-6.1-sol", "route", 400], ["gpt-6.1-sol", "route", 400], ["gpt-6.1-sol", "route", 400]]);
      expect(JSON.parse(readFileSync(`${wire}.totals.json`, "utf8"))).toMatchObject({ requests: 4, refused: 3 });
    } finally { proxy.kill("SIGKILL"); upstream.closeAllConnections(); upstream.close(); }
  });
});

describe("workspace: no commit anywhere, final.diff against the initial tree", () => {
  it("git init + add -A with an unborn branch; the final diff covers edits, additions and deletions, never .orche or installs, and commits nothing", async () => {
    const dir = await temp();
    const source = join(dir, "repo");
    await mkdir(join(source, "src"), { recursive: true }); await mkdir(join(source, "test"), { recursive: true }); await mkdir(join(source, "nested/.git"), { recursive: true });
    await writeFile(join(source, "src/cart.js"), "export const total = (a, b) => a + b;\n");
    await writeFile(join(source, "test/cart.test.js"), "import test from 'node:test';\n");
    await writeFile(join(source, "nested/.git/HEAD"), "ref: refs/heads/x\n");
    await writeFile(join(source, "package.json"), "{\"name\":\"x\"}\n");
    const { dir: ws, tree } = await prepareWorkspace({ source }, dir);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(git(ws, ["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean).sort()).toEqual(["package.json", "src/cart.js", "test/cart.test.js"]);
    expect(commitsOf(ws)).toEqual({ head: null, count: 0 });
    expect(() => git(ws, ["rev-parse", "--verify", "-q", "HEAD"])).toThrow();

    await writeFile(join(ws, "src/cart.js"), "export const total = (a, b) => Math.round((a + b) * 100) / 100;\n");
    await writeFile(join(ws, "src/money.js"), "export const cents = x => Math.round(x * 100);\n");
    await rm(join(ws, "test/cart.test.js"));
    await mkdir(join(ws, ".orche/artifacts"), { recursive: true }); await writeFile(join(ws, ".orche/artifacts/x.txt"), "spill\n");
    await mkdir(join(ws, "node_modules/dep"), { recursive: true }); await writeFile(join(ws, "node_modules/dep/index.js"), "dep\n");
    const result = finalDiff(ws, tree, dir);
    const text = result.diff.toString();
    expect(result.files.sort()).toEqual(["A\tsrc/money.js", "D\ttest/cart.test.js", "M\tsrc/cart.js"]);
    expect(text).toContain("Math.round((a + b) * 100) / 100");
    expect(text).not.toMatch(/\.orche|node_modules/);
    expect(result.stat).toContain("3 files changed");
    // Still no commit; the workspace's own index is untouched (it still holds the initial tree).
    expect(commitsOf(ws)).toEqual({ head: null, count: 0 });
    expect(git(ws, ["write-tree"]).trim()).toBe(tree);
    // The diff reproduces the final state from the initial snapshot.
    const replay = join(dir, "replay");
    await mkdir(replay);
    execFileSync("cp", ["-a", `${source}/.`, replay]);
    await rm(join(replay, "nested"), { recursive: true });
    await writeFile(join(dir, "final.diff"), result.diff);
    git(replay, ["apply", join(dir, "final.diff")]);
    expect(await readFile(join(replay, "src/cart.js"), "utf8")).toBe(await readFile(join(ws, "src/cart.js"), "utf8"));
    expect(existsSync(join(replay, "test/cart.test.js"))).toBe(false);
    expect(await readFile(join(replay, "src/money.js"), "utf8")).toContain("cents");
    await preserveWorkspace(ws, join(dir, "final"));
    const kept = readdirSync(join(dir, "final"));
    expect(kept).toEqual(expect.arrayContaining(["package.json", "src"]));
    expect(kept.filter(name => [".git", ".orche", "node_modules"].includes(name))).toEqual([]);
  });
});

describe("runtime freeze", () => {
  async function repo(): Promise<string> {
    const dir = await temp();
    const root = join(dir, "orche");
    await mkdir(join(root, "src/sub"), { recursive: true }); await mkdir(join(root, "node_modules/x"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src/sub/b.ts"), "export const b = 2;\n");
    await writeFile(join(root, "src/new.ts"), "export const fresh = 3;\n");
    await writeFile(join(root, "src/debug.log"), "ignored\n");
    await writeFile(join(root, ".gitignore"), "*.log\nnode_modules\n");
    await writeFile(join(root, "package.json"), "{\"name\":\"orche\"}\n");
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    await writeFile(join(root, "README.md"), "not frozen\n");
    git(root, ["init", "--quiet"]);
    git(root, ["add", "src/a.ts", "src/sub/b.ts", "package.json", "tsconfig.json", ".gitignore"]);
    return root;
  }

  it("copies src/ (tracked and untracked, not ignored), package.json and tsconfig.json, links node_modules, hashes the COPIED bytes", async () => {
    const source = await repo();
    const out = join(source, "..", "study");
    // A copy that does not reproduce the source bytes: the recorded hashes must be the destination's.
    const { dir, revision } = await freezeRuntime(out, "fixed", { repo: source, copy: async (from, to) => { await writeFile(to, `${await readFile(from, "utf8")}// copied\n`); } });
    expect(dir).toBe(join(out, "rt-fixed"));
    expect(Object.keys(revision.files)).toEqual(["package.json", "src/a.ts", "src/new.ts", "src/sub/b.ts", "tsconfig.json"]);
    for (const [path, hash] of Object.entries(revision.files)) {
      expect(hash).toBe(sha256(readFileSync(join(dir, path))));
      expect(hash).not.toBe(sha256(readFileSync(join(source, path))));
    }
    expect(revision.sourceDiffers).toEqual(Object.keys(revision.files));
    expect(revision).toMatchObject({ name: "fixed", head: null, fileCount: 5 });
    expect(revision.dirty).toEqual(expect.arrayContaining(["A  src/a.ts", "?? src/new.ts", "?? README.md"]));
    expect(readRevision(dir)).toEqual(revision);
    expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "node_modules"))).toBe(join(source, "node_modules"));
    expect(existsSync(join(dir, "node_modules/x"))).toBe(true);
    expect(existsSync(join(dir, "README.md")) || existsSync(join(dir, "src/debug.log"))).toBe(false);
    expect(verifyRuntime(dir)).toEqual([]);
    await writeFile(join(dir, "src/a.ts"), "export const a = 2;\n");
    expect(verifyRuntime(dir)).toEqual(["src/a.ts"]);
    expect(readdirSync(out).filter(name => name.includes("partial"))).toEqual([]);
  });

  it("an existing rt-<name> is never overwritten; a plain copy records the source bytes", async () => {
    const source = await repo();
    const out = join(source, "..", "study");
    const first = await freezeRuntime(out, "fixed", { repo: source });
    expect(first.revision.sourceDiffers).toBeUndefined();
    for (const [path, hash] of Object.entries(first.revision.files)) expect(hash).toBe(sha256(readFileSync(join(source, path))));
    await writeFile(join(source, "src/a.ts"), "export const a = 99;\n");
    await expect(freezeRuntime(out, "fixed", { repo: source })).rejects.toThrow(/never overwritten/);
    expect(readRevision(first.dir)).toEqual(first.revision);
    expect(readFileSync(join(first.dir, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    const second = await freezeRuntime(out, "later", { repo: source });
    expect(second.revision.digest).not.toBe(first.revision.digest);
    await expect(freezeRuntime(out, "../escape", { repo: source })).rejects.toThrow(/runtime name/);
  });
});

describe("plan and schedule", () => {
  const plan: Plan = parsePlan({
    out: "results/x", phase: "p", seed: "seed", repeats: 2, concurrency: 2, scratch: "/tmp/x",
    tasks: ["t1", { task: "t2", kind: "suite" }, "t3"],
    arms: [{ name: "a", mode: "ultra", runtime: "fixed" }, { name: "b", mode: "strong", runtime: "fixed" }, { name: "c", mode: "ultra", runtime: "other", limits: { maxExtensions: 0 } }],
  });

  it("is deterministic per seed, repeat-major, every unit once, arm order seeded per block", () => {
    const a = schedule(plan), b = schedule(plan);
    expect(a).toEqual(b);
    expect(a).toHaveLength(18);
    expect(new Set(a.map(item => item.unit.id)).size).toBe(18);
    expect(a.slice(0, 9).every(item => item.unit.repeat === 1)).toBe(true);
    expect(a.map(item => item.unit.task).slice(0, 9)).toEqual(["t1", "t1", "t1", "t2", "t2", "t2", "t3", "t3", "t3"]);
    for (let block = 0; block < 6; block++) {
      const items = a.slice(block * 3, block * 3 + 3);
      expect(items.map(item => item.unit.arm)).toEqual(items[0]!.order);
      expect([...items[0]!.order].sort()).toEqual(["a", "b", "c"]);
    }
    expect(a[0]!.unit).toEqual({ id: `t1/${a[0]!.order[0]}/r1`, task: "t1", arm: a[0]!.order[0], repeat: 1 });
    const orders = (seed: string) => schedule({ ...plan, seed }).map(item => item.order.join(""));
    expect(new Set(orders("seed")).size).toBeGreaterThan(1);
    expect(["s1", "s2", "s3", "s4"].some(seed => orders(seed).join() !== orders("seed").join())).toBe(true);
  });

  it("hashes what is measured, not where; refuses unknown fields (no plan names a model or an effort) and bad limits", () => {
    expect(planHash({ ...plan, out: "elsewhere", concurrency: 8, scratch: "/tmp/y" })).toBe(planHash(plan));
    expect(planHash({ ...plan, seed: "other" })).not.toBe(planHash(plan));
    const base = { out: "o", seed: "s", repeats: 1, concurrency: 1, scratch: "/tmp/s", tasks: ["t"], arms: [{ name: "a", mode: "ultra", runtime: "r" }] };
    expect(parsePlan(base).phase).toBe("main");
    expect(() => parsePlan({ ...base, model: "x/y" })).toThrow(/unknown field\(s\) model/);
    expect(() => parsePlan({ ...base, arms: [{ name: "a", mode: "ultra", runtime: "r", thinking: "xhigh" }] })).toThrow(/unknown field\(s\) thinking/);
    expect(() => parsePlan({ ...base, arms: [{ name: "a", mode: "ultra", runtime: "r", limits: { overallMinutes: 3 } }] })).toThrow(/unknown limit/);
    expect(() => parsePlan({ ...base, arms: [{ name: "a", mode: "ultra", runtime: "r", limits: { maxExtensions: 0.5 } }] })).toThrow(/integer/);
    expect(() => parsePlan({ ...base, arms: [{ name: "a", mode: "multi", runtime: "r" }] })).toThrow(/mode/);
    expect(() => parsePlan({ ...base, arms: [base.arms[0], base.arms[0]] })).toThrow(/duplicate name/);
    expect(() => parsePlan({ ...base, scratch: "relative" })).toThrow(/absolute/);
  });

  it("the live plan: two ultra arms on the frozen runtime 'fixed', default limits and the 12-minute never-extended interruption", () => {
    const live = parsePlan(JSON.parse(readFileSync(new URL("../../experiments/ultra-ho/plans/live.json", import.meta.url), "utf8")));
    expect(live.tasks).toEqual([{ task: "a1-rounding", kind: "suite" }]);
    expect(live.arms.map(arm => [arm.name, arm.mode, arm.runtime])).toEqual([["normal", "ultra", "fixed"], ["interrupted", "ultra", "fixed"]]);
    expect(armSettings(live.arms[0]!)).toEqual({ limits: DEFAULT_LIMITS, piGuardMs: 150 * 60_000 });
    expect(armSettings(live.arms[1]!)).toEqual({ limits: { ...DEFAULT_LIMITS, overallMs: 12 * 60_000, assignmentMs: 12 * 60_000, maxExtensions: 0 }, piGuardMs: 90 * 60_000 });
    expect(live.concurrency).toBe(2);
    expect(live.scratch.startsWith("/tmp/")).toBe(true);
  });
});

describe("round-2 fixtures: an alternative SWE fixture root and environment cache run like the canonical ones", () => {
  const base = { out: "o", seed: "s", repeats: 1, concurrency: 1, scratch: "/tmp/s", tasks: ["t"], arms: [{ name: "a", mode: "ultra", runtime: "r" }] };
  /** A repository with a canonical and an r2 SWE root, each with one task, and their environment caches. */
  async function layout(): Promise<{ repo: string; outside: string }> {
    const dir = await temp();
    const repo = join(dir, "repo");
    const task = (id: string) => JSON.stringify({ title: id, problemStatement: `Fix ${id}.`, validation: { valid: true }, testCmd: "pytest", failToPass: [], passToPass: [] });
    for (const [root, cache, id] of [["fixtures/advisor-bench/swe", "results/advisor-reviewer/cache/swe", "t-canonical"], ["fixtures/advisor-bench/swe-r2", "results/advisor-reviewer/cache/swe-r2", "t-r2"]] as const) {
      await mkdir(join(repo, root, id, "hidden"), { recursive: true });
      await writeFile(join(repo, root, id, "task.json"), task(id));
      await writeFile(join(repo, root, id, "hidden", "test.patch"), "");
      await mkdir(join(repo, cache, id, "src"), { recursive: true }); await mkdir(join(repo, cache, id, "venv"), { recursive: true });
      await writeFile(join(repo, cache, id, "src", "mod.py"), `${id}\n`);
      await writeFile(join(repo, cache, id, "venv", ".ready"), "");
    }
    return { repo, outside: join(dir, "outside") };
  }

  it("plan keys sweFixtures and sweCacheSource: optional strings, part of the plan hash when given; a plan without them parses and hashes as before", () => {
    expect(parsePlan(base)).not.toHaveProperty("sweFixtures");
    const r2 = parsePlan({ ...base, sweFixtures: "fixtures/advisor-bench/swe-r2", sweCacheSource: "results/advisor-reviewer/cache/swe-r2" });
    expect(r2).toMatchObject({ sweFixtures: "fixtures/advisor-bench/swe-r2", sweCacheSource: "results/advisor-reviewer/cache/swe-r2" });
    expect(planHash(r2)).not.toBe(planHash(parsePlan(base)));
    expect(planHash({ ...parsePlan(base), sweCache: "/tmp/elsewhere" })).toBe(planHash(parsePlan(base)));
    expect(() => parsePlan({ ...base, sweFixtures: "" })).toThrow(/sweFixtures: expected a non-empty string/);
    expect(() => parsePlan({ ...base, sweCacheSource: 3 })).toThrow(/sweCacheSource: expected a non-empty string/);
  });

  // The plans of the earlier phases hash exactly as when they were launched (results/ is local, not versioned).
  it.skipIf(!["stage3/plan-s3a.json", "stage3/plan-s3b.json", "live/plan-live.json"].every(name => existsSync(join(REPO, "results/ultra-ho", name))))("round-1 plans keep the plan hash recorded at their launch", () => {
    for (const [plan, launched] of [["stage3a", "stage3/plan-s3a.json"], ["stage3b", "stage3/plan-s3b.json"], ["live", "live/plan-live.json"]] as const) {
      const parsed = parsePlan(JSON.parse(readFileSync(join(REPO, "experiments/ultra-ho/plans", `${plan}.json`), "utf8")));
      expect(planHash(parsed)).toBe(JSON.parse(readFileSync(join(REPO, "results/ultra-ho", launched), "utf8")).planHash);
    }
  });

  it("resolves the roots (default: the canonical ones; relative from the repository), detects SWE tasks under the plan's root and stages their environments from its cache", async () => {
    const { repo, outside } = await layout();
    expect(sweRoots({}, repo)).toEqual({ fixtures: join(repo, DEFAULT_SWE_FIXTURES), cacheSource: join(repo, DEFAULT_SWE_CACHE_SOURCE) });
    expect(sweRoots({ sweFixtures: "fixtures/advisor-bench/swe-r2", sweCacheSource: "/abs/cache" }, repo)).toEqual({ fixtures: join(repo, "fixtures/advisor-bench/swe-r2"), cacheSource: "/abs/cache" });
    expect([isSweTask("t-r2", join(repo, "fixtures/advisor-bench/swe-r2")), isSweTask("t-r2", join(repo, DEFAULT_SWE_FIXTURES)), isSweTask("t-canonical", join(repo, DEFAULT_SWE_FIXTURES))]).toEqual([true, false, true]);
    const sweCache = join(outside, "swe");
    // A task without a kind is a SWE task when the plan's root holds it; the canonical root is not consulted.
    expect(await stageSweCache({ tasks: [{ task: "t-r2" }, { task: "t-canonical" }], sweCache, sweFixtures: "fixtures/advisor-bench/swe-r2", sweCacheSource: "results/advisor-reviewer/cache/swe-r2" }, repo)).toEqual(["t-r2"]);
    expect(readFileSync(join(sweCache, "t-r2", "src", "mod.py"), "utf8")).toBe("t-r2\n");
    expect(existsSync(join(sweCache, "t-r2", "venv", ".ready")) && !existsSync(join(sweCache, "t-canonical"))).toBe(true);
    // Defaults: the canonical root and cache, as before.
    expect(await stageSweCache({ tasks: [{ task: "t-canonical" }, { task: "t-r2" }], sweCache }, repo)).toEqual(["t-canonical"]);
    expect(readFileSync(join(sweCache, "t-canonical", "src", "mod.py"), "utf8")).toBe("t-canonical\n");
  });

  it("the unit process gets ADVISOR_BENCH_SWE_DIR only when the plan names a fixture root (an inherited one never leaks into a default plan); Pi never gets it", () => {
    const inherited = { PATH: "/bin", ADVISOR_BENCH_SWE_DIR: "/stray" };
    const plain = unitEnv({ sweCache: "/scratch/swe" }, "/repo", inherited);
    expect(plain).toMatchObject({ PATH: "/bin", ULTRA_HO_REPO: "/repo", ULTRA_AB_REPO: "/repo", ADVISOR_BENCH_REPO: "/repo", ADVISOR_BENCH_SWE_CACHE: "/scratch/swe" });
    expect(plain).not.toHaveProperty("ADVISOR_BENCH_SWE_DIR");
    expect(unitEnv({ sweCache: "/scratch/swe", sweFixtures: "fixtures/advisor-bench/swe-r2" }, "/repo", inherited).ADVISOR_BENCH_SWE_DIR).toBe("/repo/fixtures/advisor-bench/swe-r2");
    const runOne = readFileSync(new URL("../../experiments/ultra-ho/run-one.ts", import.meta.url), "utf8");
    expect(runOne).toContain("const { ADVISOR_BENCH_SWE_DIR: _fixtures, ...base } = process.env;");
    expect(runOne).toContain("env: piEnv(base, agentDir, sessionDir");
  });

  it("a unit process reads its task from the plan's root (ultra-ab loadTask through ADVISOR_BENCH_SWE_DIR), records the root, and refuses a task read elsewhere", async () => {
    const { repo } = await layout();
    const script = join(await temp(), "probe.mts");
    await writeFile(script, [
      `const { SWE_DIR, SWE_CACHE } = await import(${JSON.stringify(new URL("../../experiments/advisor-reviewer/tasks.ts", import.meta.url).href)});`,
      `const { loadTask } = await import(${JSON.stringify(new URL("../../experiments/ultra-ab/env.ts", import.meta.url).href)});`,
      "const task = await loadTask(process.argv[2]).catch(error => ({ error: String(error.message) }));",
      "console.log(JSON.stringify({ SWE_DIR, SWE_CACHE, task: { kind: task.kind, dir: task.dir, source: task.source, error: task.error } }));",
    ].join("\n"));
    const run = (env: NodeJS.ProcessEnv, id: string) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", script, id], { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim().split("\n").at(-1)!);
    const cache = join(repo, "results/advisor-reviewer/cache/swe-r2");
    const r2 = run({ ADVISOR_BENCH_REPO: repo, ADVISOR_BENCH_SWE_DIR: join(repo, "fixtures/advisor-bench/swe-r2"), ADVISOR_BENCH_SWE_CACHE: cache }, "t-r2");
    expect(r2).toEqual({ SWE_DIR: join(repo, "fixtures/advisor-bench/swe-r2"), SWE_CACHE: cache, task: { kind: "swe", dir: join(repo, "fixtures/advisor-bench/swe-r2", "t-r2"), source: join(cache, "t-r2", "src") } });
    // Without the variable: the canonical root, where the r2 task does not exist.
    const canonical = run({ ADVISOR_BENCH_REPO: repo, ADVISOR_BENCH_SWE_DIR: "", ADVISOR_BENCH_SWE_CACHE: join(repo, DEFAULT_SWE_CACHE_SOURCE) }, "t-r2");
    expect(canonical.SWE_DIR).toBe(join(repo, DEFAULT_SWE_FIXTURES));
    expect(canonical.task.error).toBeDefined();
    // What run-one records, and its refusal of a SWE task read from another root than the plan's.
    const task = { id: "t-r2", kind: "swe" as const, dir: r2.task.dir };
    expect(fixtureEvidence(task, { sweFixtures: join(repo, "fixtures/advisor-bench/swe-r2"), sweCacheSource: join(repo, "results/advisor-reviewer/cache/swe-r2") }, "/scratch/swe")).toEqual({ fixtureRoot: join(repo, "fixtures/advisor-bench/swe-r2"), sweCacheSource: join(repo, "results/advisor-reviewer/cache/swe-r2"), sweCache: "/scratch/swe" });
    expect(() => fixtureEvidence(task, { sweFixtures: join(repo, DEFAULT_SWE_FIXTURES) })).toThrow(/not from the plan's fixture root/);
    expect(fixtureEvidence({ id: "a1", kind: "suite", dir: "/repo/fixtures/suite/a1" }, { sweFixtures: "/elsewhere" })).toEqual({ fixtureRoot: "/repo/fixtures/suite" });
  }, 60_000);

  it("the driver stages from the plan's roots and hands every unit its fixture root and cache source, recorded in the plan file", async () => {
    const { repo, outside } = await layout();
    const out = join(repo, "results/r2");
    await mkdir(join(out, "rt-fixed"), { recursive: true });
    await writeFile(join(out, "rt-fixed/REVISION.json"), JSON.stringify({ name: "fixed", digest: "d".repeat(64), files: {} }));
    const plan = { out, phase: "r2", seed: "s", repeats: 1, concurrency: 1, scratch: join(outside, "scratch"), sweCache: join(outside, "swe"), sweFixtures: "fixtures/advisor-bench/swe-r2", sweCacheSource: "results/advisor-reviewer/cache/swe-r2", tasks: ["t-r2"], arms: [{ name: "H2", mode: "ultra", runtime: "fixed" }] };
    const provider = { dir: "/nonexistent/provider", source: "x", digest: "p".repeat(64), files: 0, frozenAt: "2026-10-24T00:00:00Z" };
    const inputs: RunInput[] = [];
    await drive(plan, { repo, provider, quiet: true, runner: async (_unit, input) => { inputs.push(input); await writeFile(join(input.out, "meta.json"), JSON.stringify({ unit: input.unit, status: "completed", terminal: "done", primaryPass: true })); return 0; } });
    expect(inputs.map(input => [input.unit, input.sweFixtures, input.sweCacheSource])).toEqual([["t-r2/H2/r1", join(repo, "fixtures/advisor-bench/swe-r2"), join(repo, "results/advisor-reviewer/cache/swe-r2")]]);
    expect(JSON.parse(readFileSync(join(out, "plan-r2.json"), "utf8"))).toMatchObject({ swe: ["t-r2"], sweRoots: { fixtures: join(repo, "fixtures/advisor-bench/swe-r2"), cacheSource: join(repo, "results/advisor-reviewer/cache/swe-r2") } });
    expect(readFileSync(join(outside, "swe", "t-r2", "src", "mod.py"), "utf8")).toBe("t-r2\n");
  }, 60_000);
});

describe("evidence of orche assignments: carry, adoption, gate, stage claims", () => {
  const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 24, 0, minute, second)).toISOString();
  const msg = (minute: number, message: unknown, second = 0) => ({ type: "message", timestamp: at(minute, second), message });
  const call = (id: string, name: string, args: unknown) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
  const result = (id: string, name: string, text: string, isError = false, details?: unknown) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, ...(details ? { details } : {}) });
  const copies = { a: "/s/ultra/W1.3", b: "/s/ultra/W1.4" };
  const firstText = [
    "Worker W1 timed out after 720000ms (not extended: maxExtensions 0)", "Mode: ultra (orchestrator: models.strong-orchestrator; sub-workers: models.strong-worker)",
    "Task ledger T1, assignment 1: pass task \"T1\" for a follow-up of this task (also when another or a new worker takes it over); omit it for a different task.",
    "Checkpoint at the timeout: no Task DAG was recorded in this assignment. Only what task_plan recorded survives a worker that is gone; nothing after its last accepted call.",
    "Resume: a timeout is not an unmet result and does not count towards the 2-consecutive-unmet rule. Continue with orche_task worker \"W1\" and task \"T1\", handing over only the remaining work.",
    "Ultra: stage review; exploration 1/2 round(s), candidates 1/2 round(s) (W1.3 done adopted, W1.4 done), verification 0/2 round(s); report gate not reached",
    "Ultra protected basis: test/basis.test.js",
    "Ultra resume: the exploration, the protected basis, the candidates with their workspace copies (in W1's scratch directory) and the adoptions of task T1 continue in W1's next ultra assignment of that task (worker \"W1\", task \"T1\"), with or without single.ledger; evidence refs are per assignment, so the checks are run again.",
    "", "Record: /tmp/run/agent/orche/records/uho-x/2026-10-24T00-00-00-000Z_task-aaaa1111",
  ].join("\n");
  const secondFull = [
    "orche task W1 (implement, 1000s, 40 requests; user config)", "Task ledger T1, assignment 2: pass task \"T1\" for a follow-up of this task.", "", "Re-checked both carried candidates; the carried adoption of W1.3 stands.",
    "Ultra: stage complete; exploration 1/2 round(s), candidates 1/2 round(s) (W1.3 done adopted, W1.4 done), verification 1/2 round(s); report gate passed; continued from the previous assignment of this task",
    "Ultra protected basis: test/basis.test.js", "", "Record: /tmp/run/agent/orche/records/uho-x/2026-10-24T00-13-00-000Z_task-bbbb2222",
  ].join("\n");
  const summary = (extra: Record<string, unknown>) => ({ explorationRounds: 1, candidateRounds: 1, protectedBasis: ["test/basis.test.js"], verificationRounds: 0, ...extra });

  async function runDir(): Promise<string> {
    const dir = await temp();
    const records = join(dir, "records/uho-x");
    const first = join(records, "2026-10-24T00-00-00-000Z_task-aaaa1111"), second = join(records, "2026-10-24T00-13-00-000Z_task-bbbb2222");
    for (const path of [join(dir, "sessions/--ws--"), join(dir, "main-artifacts"), join(records, "workers"), first, second]) await mkdir(path, { recursive: true });
    await writeFile(join(dir, "sessions/--ws--/2026-10-24T00-00-00-000Z_uho-x.jsonl"), jsonl([
      { type: "session", id: "uho-x", timestamp: at(0) },
      msg(0, { role: "user", content: [{ type: "text", text: "Fix the cart." }] }),
      msg(0, call("c1", "orche_task", { role: "implement", request: "Fix Cart.totals" }), 1),
      msg(12, result("c1", "orche_task", firstText, true, { worker: "W1", status: "timeout", task: "T1", record: "/tmp/run/agent/orche/records/uho-x/2026-10-24T00-00-00-000Z_task-aaaa1111", mode: "ultra", ultra: summary({ stage: "review", candidates: [{ id: "W1.3", status: "done", changes: 1, adopted: true }, { id: "W1.4", status: "done", changes: 2 }], adoptions: ["W1.3"] }), failure: { kind: "failed", status: "timeout", reason: "Worker W1 timed out" } }), 2),
      msg(13, call("c2", "orche_task", { role: "implement", worker: "W1", task: "T1", request: "Continue the remaining stages" })),
      msg(30, result("c2", "orche_task", "orche task W1 (implement, 1000s, 40 requests; user config)\n\n[Output truncated: middle output / long lines truncated (30 lines omitted). Full output saved to .orche/artifacts/orche_task-abc-123.txt; use read with offset/limit or grep to inspect it.]", false, { worker: "W1", status: "done", task: "T1", record: "/tmp/run/agent/orche/records/uho-x/2026-10-24T00-13-00-000Z_task-bbbb2222", mode: "ultra", ultra: summary({ stage: "complete", candidates: [{ id: "W1.3", status: "done", changes: 1, adopted: true }, { id: "W1.4", status: "done", changes: 2 }], adoptions: ["W1.3"], verificationRounds: 1, gate: "passed", carried: true }) }), 1),
    ]));
    await writeFile(join(dir, "sessions/--ws--/stray.jsonl"), jsonl([{ type: "session", id: "other-1" }]));
    await writeFile(join(dir, "main-artifacts/orche_task-abc-123.txt"), secondFull);
    await writeFile(join(first, "run.json"), JSON.stringify({ version: 1, kind: "task", id: "aaaa1111", status: "failed", start: at(0), end: at(12, 1), outcome: { status: "timeout" } }));
    await writeFile(join(first, "events.jsonl"), jsonl([
      { type: "ultra", timestamp: Date.parse(at(1)), worker: "W1", stage: "exploration", round: 1, workers: ["W1.1", "W1.2"] },
      { type: "ultra", timestamp: Date.parse(at(5)), worker: "W1", stage: "candidates", round: 1, workers: [{ id: "W1.3", workspace: copies.a }, { id: "W1.4", workspace: copies.b }] },
      { type: "ultra", timestamp: Date.parse(at(9, 30)), worker: "W1", stage: "selection", adopted: "W1.3", files: ["src/cart.js"], fingerprint: "fp-1" },
    ]));
    await writeFile(join(second, "run.json"), JSON.stringify({ version: 1, kind: "task", id: "bbbb2222", status: "done", start: at(13), end: at(30), outcome: { status: "done" } }));
    await writeFile(join(second, "events.jsonl"), jsonl([
      { type: "ultra", timestamp: Date.parse(at(21)), worker: "W1", stage: "review", workers: ["W1.5"] },
      { type: "ultra", timestamp: Date.parse(at(25, 5)), worker: "W1", stage: "gate", rejected: "Ultra report gate: an independent counterexample review is missing" },
      { type: "ultra", timestamp: Date.parse(at(28, 5)), worker: "W1", stage: "gate", passed: true, evaluated: { "W1.4": ["T2"] }, excluded: {} },
      { type: "spawn", timestamp: Date.parse(at(22)), worker: "W1", reason: "verification", workers: [] },
    ]));
    await writeFile(join(records, "workers/W1-2026-10-24T00-00-00-100Z.jsonl"), jsonl([
      { type: "session", id: "sess-w1", timestamp: at(0) },
      msg(8, call("old", "bash", { command: `cd '${copies.a}' && node --test` })), msg(8, result("old", "bash", "ok\n[orche ref T9]"), 30),
      msg(9, call("a0", "orche_adopt", { candidate: "W1.3" })), msg(9, result("a0", "orche_adopt", "Adopted W1.3 into the workspace: 1 file(s): src/cart.js."), 31),
      msg(15, call("b1", "bash", { command: `cd '${copies.a}' && node --test` })), msg(15, result("b1", "bash", "# pass 4\n[orche ref T1]"), 20),
      msg(16, call("b2", "bash", { command: `cd '${copies.b}' && node --test` })), msg(16, result("b2", "bash", "# fail 1\n[orche ref T2, failed]", true), 20),
      msg(27, call("b3", "bash", { command: "node --test" })), msg(27, result("b3", "bash", "# pass 40\n[orche ref T3]"), 20),
      msg(25, call("r1", "report_result", { kind: "implement", summary: "done", data: { status: "done", ultra: { stage: "complete" } } })), msg(25, result("r1", "report_result", "Ultra report gate: an independent counterexample review is missing", true), 6),
      msg(28, call("r2", "report_result", { kind: "implement", summary: "done", data: { status: "done", ultra: { stage: "complete", candidates: [{ id: "W1.3", verdict: "chosen", evidence: ["T1"] }, { id: "W1.4", verdict: "failed", evidence: ["[orche ref T2, failed] fails"] }], selection: { chosen: "W1.3", evidence: ["[orche ref T1] node --test passes in W1.3's copy"] }, review: [], integration: { evidence: ["T3", "T7"] } } } })),
    ]));
    for (const [agent, id] of [["W1.3", "sess-w13"], ["W1.4", "sess-w14"]] as const) await writeFile(join(records, `workers/${agent}-2026-10-24T00-05-00-000Z.jsonl`), jsonl([{ type: "session", id }]));
    return dir;
  }

  it("attributes every recorded session: main, the orchestrator W1, its sub-workers W1.n, others", async () => {
    const dir = await runDir();
    const map = sessionMap(dir, "uho-x");
    expect(Object.fromEntries([...map].map(([key, info]) => [key, `${info.role} ${info.agent}`]))).toEqual({ "uho-x": "main main", "sess-w1": "orchestrator W1", "sess-w13": "sub-worker W1.3", "sess-w14": "sub-worker W1.4", "other-1": "other session:other-1" });
  });

  it("per assignment: number, worker, task passed or not, carry and carried candidates, Ultra lines, gate events, adoptions after a fresh check (also a carried one)", async () => {
    const dir = await runDir();
    const [first, second] = assignments(dir, "uho-x");
    expect(first).toMatchObject({
      index: 1, requested: { role: "implement" }, passedTask: false, worker: "W1", task: "T1", assignment: 1, status: "timeout", isError: true,
      record: "records/uho-x/2026-10-24T00-00-00-000Z_task-aaaa1111", recordStatus: "timeout", carried: false, carriedLine: false, carriedCandidates: [],
      adoptions: [{ candidate: "W1.3", files: ["src/cart.js"], fingerprint: "fp-1", check: { ref: "T9", command: `cd '${copies.a}' && node --test`, at: at(8) }, checksBefore: 1 }],
      carriedAdoptions: [], gate: { events: [] }, reports: [], stageClaims: { report: [], line: [] },
    });
    expect(first!.ultraLines.map(line => line.split(":")[0])).toEqual(["Ultra", "Ultra protected basis", "Ultra resume"]);
    expect(first!.resumeLines.some(line => line.includes('Continue with orche_task worker "W1" and task "T1"'))).toBe(true);
    expect(assignmentLine(first!)).toBe("#1 · W1 · T1/a1 · task not passed · fresh · timeout · gate not reached · adopted W1.3 after T9");
    expect(second).toMatchObject({
      index: 2, requested: { role: "implement", worker: "W1", task: "T1" }, passedTask: true, worker: "W1", task: "T1", assignment: 2, status: "done", isError: false,
      carried: true, carriedLine: true, carriedCandidates: ["W1.3", "W1.4"], gate: { result: "passed" },
      adoptions: [], carriedAdoptions: [{ candidate: "W1.3", freshChecks: [{ ref: "T1", command: `cd '${copies.a}' && node --test`, at: at(15) }] }],
      reports: [{ status: "done", stage: "complete", accepted: false }, { status: "done", stage: "complete" }],
      stageClaims: { report: [], line: [] },
    });
    const check = (ref: string, target: string, isError = false, minute = 15) => ({ ref, tool: "bash", isError, at: at(minute), target, command: target === "workspace" ? "node --test" : `cd '${target === "W1.3" ? copies.a : copies.b}' && node --test` });
    expect(second!.finalReport).toEqual({
      at: at(28), status: "done", stage: "complete",
      selection: { chosen: "W1.3", evidence: [check("T1", "W1.3")] },
      candidates: [{ id: "W1.3", verdict: "chosen", evidence: [check("T1", "W1.3")] }, { id: "W1.4", verdict: "failed", evidence: [check("T2", "W1.4", true, 16)] }],
      review: [], integration: [check("T3", "workspace", false, 27), { ref: "T7" }],
    });
    expect(second!.gate.events).toEqual([{ at: at(25, 5), rejected: "Ultra report gate: an independent counterexample review is missing" }, { at: at(28, 5), passed: true, evaluated: { "W1.4": ["T2"] }, excluded: {} }]);
    expect(second!.ultraLines[0]).toContain("continued from the previous assignment of this task");
    expect(second!.ultraEvents.map(event => event.stage)).toEqual(["review", "gate", "gate"]);
    expect(assignmentLine(second!)).toBe("#2 · W1 · T1/a2 · task passed (T1) · carried [W1.3,W1.4] · done · gate passed · carried adoption W1.3 re-checked by T1");
  });

  it("reextract re-derives tasks.json and fidelity.json of a completed unit from its preserved evidence and keeps the as-collected files", async () => {
    const dir = await runDir();
    await writeFile(join(dir, "meta.json"), JSON.stringify({ unit: "t/a/r1", status: "completed", sessionId: "uho-x", terminal: "done", grade: { passed: true } }));
    await writeFile(join(dir, "tasks.json"), "[]\n");
    await writeFile(join(dir, "wire.jsonl"), jsonl([{ id: 1, at: at(1), method: "POST", model: "gpt-6.1-sol", effort: "high", session: "sess-w1", status: 200, respModel: "gpt-6.1-sol", usage: { input: 10, cached: 0, output: 1 }, costUSD: 0.1 }]));
    expect(await reextract(dir, "h")).toEqual({ unit: "t/a/r1", violations: 0, tasks: 2 });
    expect(readFileSync(join(dir, "tasks.collected.json"), "utf8")).toBe("[]\n");
    expect(JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))).toHaveLength(2);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ terminal: "done", grade: { passed: true }, wire: { requests: 1, routeViolations: 0, byRole: { orchestrator: { requests: 1, costUSD: 0.1 } } }, reextracted: [{ harness: "h" }] });
    expect(meta.orcheTasks.map((item: any) => item.line)).toEqual(["#1 · W1 · T1/a1 · task not passed · fresh · timeout · gate not reached · adopted W1.3 after T9", "#2 · W1 · T1/a2 · task passed (T1) · carried [W1.3,W1.4] · done · gate passed · carried adoption W1.3 re-checked by T1"]);
  });

  it("stage claims: a report or line naming a stage the runtime did not reach, review without a round, selection without adoption", () => {
    const facts = { explorationRounds: 1, candidateRounds: 1, candidates: ["W1.3", "W1.4"], adoptions: [], verificationRounds: 0 };
    expect(reachedStage(facts)).toBe("selection");
    expect(reachedStage({ ...facts, adoptions: ["W1.3"] })).toBe("review");
    expect(reachedStage({ ...facts, adoptions: ["W1.3"], verificationRounds: 1 })).toBe("integration");
    expect(reachedStage({ ...facts, candidates: [], candidateRounds: 0 })).toBe("candidates");
    expect(unsupportedStageClaims({ stage: "selection" }, facts)).toEqual([]);
    expect(unsupportedStageClaims({ stage: "verification", review: [{}], selection: { chosen: "W1.3" }, integration: { evidence: ["T4"] }, candidates: [{ id: "W1.9" }] }, facts)).toEqual([
      "stage review named, the runtime reached selection", "1 review finding(s) named without a verification round in this assignment", "selection of W1.3 named without its adoption",
      "integration evidence named without an adoption", "candidates the runtime does not know: W1.9",
    ]);
    expect(unsupportedStageClaims({ stage: "complete" }, { ...facts, gate: "rejected: x" })).toEqual(["stage complete named, report gate rejected: x"]);
    expect(parseUltraLine("Ultra: stage review; exploration 1/2 round(s), candidates 2/2 round(s) (W1.3 done adopted, W1.6 failed), verification 0/2 round(s) (+1 without a finished verifier); report gate accepted as incomplete (stopped at review); continued from the previous assignment of this task"))
      .toEqual({ stage: "review", exploration: 1, candidates: 2, verification: 0, gate: "accepted as incomplete (stopped at review)", carried: true });
    expect(parseUltraLine("Ultra: stage exploration; exploration 0/2 round(s), candidates 0/2 round(s) (none), verification 0/2 round(s); report gate rejected: Ultra report gate: a; b")).toMatchObject({ stage: "exploration", gate: "rejected: Ultra report gate: a; b", carried: false });
  });
});

describe("driver: lock, manifest, resume, one infra retry, harness errors, reruns (fake unit runner)", () => {
  it("runs every unit once, retries only a run without a successful model request, keeps failed attempts, reuses completed units, reruns on request", async () => {
    const dir = await temp();
    const out = join(dir, "study");
    await mkdir(join(out, "rt-fixed"), { recursive: true });
    await writeFile(join(out, "rt-fixed/REVISION.json"), JSON.stringify({ name: "fixed", digest: "d".repeat(64), files: {} }));
    const plan = { out, phase: "live", seed: "s", repeats: 1, concurrency: 2, scratch: join(dir, "scratch"), tasks: ["t-one"], arms: [{ name: "normal", mode: "ultra", runtime: "fixed" }, { name: "interrupted", mode: "ultra", runtime: "fixed", limits: { overallMs: 720_000, assignmentMs: 720_000, maxExtensions: 0 }, piGuardMs: 5_400_000 }] };
    const provider = { dir: "/nonexistent/provider", source: "x", digest: "p".repeat(64), files: 0, frozenAt: "2026-10-24T00:00:00Z" };
    const calls: { unit: string; attempt: number; input: RunInput }[] = [];
    const meta = (input: RunInput, value: Record<string, unknown>) => writeFile(join(input.out, "meta.json"), JSON.stringify({ unit: input.unit, attempt: input.attempt, ...value }));
    const runner = async (unit: { id: string; arm: string }, input: RunInput) => {
      calls.push({ unit: unit.id, attempt: input.attempt, input });
      if (unit.arm === "normal" && input.attempt === 1) { await meta(input, { status: "completed", terminal: "infra", infra: "no successful model request", primaryPass: false }); return 0; }
      if (unit.arm === "normal") { await meta(input, { status: "completed", terminal: "done", primaryPass: true, grade: { passed: true }, wire: { requests: 3, costUSD: 0.5, routeViolations: 0, byRole: { main: { requests: 1, costUSD: 0.1 } } } }); return 0; }
      // The interrupted arm's unit process dies after a successful model request: a harness error, never retried.
      await writeFile(join(input.out, "wire.jsonl"), `${JSON.stringify({ id: 1, method: "POST", model: "gpt-6.1-sol", status: 200 })}\n`);
      await meta(input, { status: "running" });
      return 1;
    };
    const states = await drive(plan, { runner, provider, quiet: true });
    expect(states.map(state => [state.id, state.status, state.terminal])).toEqual(expect.arrayContaining([["t-one/normal/r1", "completed", "done"], ["t-one/interrupted/r1", "completed", "harness-error"]]));
    expect(calls.map(item => `${item.unit}#${item.attempt}`).sort()).toEqual(["t-one/interrupted/r1#1", "t-one/normal/r1#1", "t-one/normal/r1#2"]);
    expect(existsSync(join(out, "runs/t-one/normal/r1.infra-1/meta.json"))).toBe(true);
    const interrupted = calls.find(item => item.unit === "t-one/interrupted/r1")!.input;
    expect(interrupted).toMatchObject({ limits: { ...DEFAULT_LIMITS, overallMs: 720_000, assignmentMs: 720_000, maxExtensions: 0 }, piGuardMs: 5_400_000, runtime: { name: "fixed", digest: "d".repeat(64) }, driverPid: process.pid });
    expect(interrupted.temp.startsWith(join(dir, "scratch"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(out, "manifest-live.json"), "utf8"));
    expect(manifest.counts).toEqual({ completed: 2 });
    expect(JSON.parse(readFileSync(join(out, "plan-live.json"), "utf8"))).toMatchObject({ planHash: expect.any(String), runtimes: { fixed: { digest: "d".repeat(64) } }, harness: { digest: expect.any(String) } });
    expect(existsSync(join(out, "driver-live.lock"))).toBe(false);

    // Resume: completed units are reused, nothing runs.
    calls.length = 0;
    await drive(plan, { runner, provider, quiet: true });
    expect(calls).toEqual([]);
    // A unit that died without completing (its meta still running) is kept as interrupted and runs again.
    await writeFile(join(out, "runs/t-one/normal/r1/meta.json"), JSON.stringify({ status: "running" }));
    await drive(plan, { runner: async (unit, input) => { calls.push({ unit: unit.id, attempt: input.attempt, input }); await meta(input, { status: "completed", terminal: "done", primaryPass: true }); return 0; }, provider, quiet: true });
    expect(calls.map(item => item.unit)).toEqual(["t-one/normal/r1"]);
    expect(existsSync(join(out, "runs/t-one/normal/r1.interrupted-1"))).toBe(true);
    // An explicit rerun of a completed unit keeps the earlier attempt.
    calls.length = 0;
    await drive(plan, { runner: async (unit, input) => { calls.push({ unit: unit.id, attempt: input.attempt, input }); await meta(input, { status: "completed", terminal: "blocked", primaryPass: false }); return 0; }, provider, quiet: true, rerun: ["t-one/interrupted/r1"] });
    expect(calls.map(item => item.unit)).toEqual(["t-one/interrupted/r1"]);
    expect(existsSync(join(out, "runs/t-one/interrupted/r1.rerun-1/meta.json"))).toBe(true);
    const summary = summarize(out);
    expect(summary.units.map(unit => [unit.id, unit.terminal, unit.kept])).toEqual(expect.arrayContaining([["t-one/normal/r1", "done", ["r1.infra-1", "r1.interrupted-1"]], ["t-one/interrupted/r1", "blocked", ["r1.rerun-1"]]]));
    expect(summary.arms.normal).toMatchObject({ units: 1, completed: 1, terminals: { done: 1 }, primaryPassed: 1 });

    // A changed plan, a scratch inside the repository, a runtime that is not frozen: refused before anything runs.
    await expect(drive({ ...plan, seed: "changed" }, { runner, provider, quiet: true })).rejects.toThrow(/differs from this plan/);
    await expect(drive({ ...plan, scratch: new URL("../../results/x", import.meta.url).pathname }, { runner, provider, quiet: true })).rejects.toThrow(/inside the repository/);
    await expect(drive({ ...plan, phase: "other", arms: [{ name: "normal", mode: "ultra", runtime: "missing" }] }, { runner, provider, quiet: true })).rejects.toThrow(/not frozen/);
  }, 60_000);
});
