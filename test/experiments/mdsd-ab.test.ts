import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { R1_CALL, SUBSTITUTIONS, admission, auditMatrix, contentHashes, hashDiff, matrixConfig, recoverRound, sessionTranscripts, toyRound, wireStats } from "../../experiments/mdsd-ab/matrix.js";
import { DEFAULT_MDSD, parseMdsdConfig } from "../../src/orchestrator/mdsd-config.js";
import { parseThinkingPolicyConfig } from "../../src/extension/config.js";
import { answerDocument, finalReport, parseClaims, qualityConfig, seedsOf } from "../../experiments/mdsd-ab/quality.js";
import { homedir } from "node:os";
// @ts-ignore plain ESM module without types (no declarations for tsc; inferred where JS is checked)
import { costOf, errorOf, updateEffortsOf, usageFrom } from "../../experiments/mdsd-ab/proxy.mjs";

/**
 * The r2 strategy x model matrix harness (experiments/mdsd-ab/matrix.ts, proxy.mjs; docs/mdsd-ab-bench.md "r2") without any model:
 * the recovered round, the config and its admission, usage/effort/error records, the target check, the audit, session attribution.
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "mdsd-ab-test-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

const PROXY = new URL("../../experiments/mdsd-ab/proxy.mjs", import.meta.url).pathname;
const sse = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const completed = (usage: unknown, model = "m-resp") => ({ type: "response.completed", response: { model, usage } });
const r1 = existsSync(R1_CALL.file);

describe("mdsd-ab proxy: original usage, cache writes, mid-conversation efforts, provider errors", () => {
  it("keeps the provider's usage numbers, prices cache writes when reported, and lists configuration_update efforts in order", () => {
    const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1050 };
    const found = usageFrom(sse({ type: "response.created", response: { model: "m-resp" } }, completed(usage)));
    expect(found).toMatchObject({ input: 1000, cached: 400, cacheWrite: 100, output: 50, reasoning: 20, final: "response.completed", respModel: "m-resp", raw: usage });
    expect(costOf({ m: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } }, "m", found)).toBeCloseTo((500 * 2 + 400 * 0.1 + 100 * 2.5 + 50 * 10) / 1e6, 12);
    expect(costOf({}, "m", found)).toBeUndefined();
    expect(usageFrom(sse({ type: "response.output_text.delta", delta: "x" }))).toBeUndefined();
    expect(updateEffortsOf({ input: [{ type: "configuration_update", reasoning: { effort: "max" } }, { type: "message" }, { type: "configuration_update", reasoning: { effort: "high" } }] })).toEqual(["max", "high"]);
    expect(updateEffortsOf({ input: "text" })).toEqual([]);
    expect(errorOf(sse({ type: "response.failed", response: { error: { code: "server_error", message: "upstream overloaded" } } }))).toEqual({ type: "response.failed", code: "server_error", message: "upstream overloaded" });
    expect(errorOf(JSON.stringify({ error: { type: "rate_limit", code: 429, message: "slow down" } }))).toEqual({ type: "rate_limit", code: "429", message: "slow down" });
    expect(errorOf("plain text")).toBeUndefined();
  });

  it("through a live proxy: gzip and chunked streams are read whole, a stream without a final event is unknown (never zero), an HTTP error keeps the provider's error", async () => {
    const dir = await temp();
    const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 1 } };
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/gz") { res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" }); res.end(gzipSync(sse({ type: "response.created", response: { model: "gz-model" } }, completed(usage, "gz-model")))); }
        else if (req.url === "/chunked") { res.writeHead(200, { "content-type": "text/event-stream" }); const text = sse({ type: "response.created", response: { model: "c-model" } }, completed(usage, "c-model")); res.write(text.slice(0, 40)); setTimeout(() => { res.write(text.slice(40, 90)); res.end(text.slice(90)); }, 20); }
        else if (req.url === "/nofinal") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sse({ type: "response.output_text.delta", delta: "x" })); }
        else { res.writeHead(429, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "rate_limit", code: 429, message: "slow down" } })); }
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const wire = join(dir, "wire.jsonl"), envelope = join(dir, "envelope.json");
    await writeFile(envelope, JSON.stringify({ capUSD: 1, prices: { m: { input: 2, output: 10, cacheRead: 0.1 } } }));
    const child = spawn(process.execPath, [PROXY, "0", `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, wire, envelope], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const port = await new Promise<number>((resolve, reject) => { let text = ""; child.stdout!.on("data", chunk => { text += String(chunk); const match = /PORT (\d+)/.exec(text); if (match) resolve(Number(match[1])); }); child.once("exit", code => reject(new Error(`proxy exited ${code}`))); });
      const body = JSON.stringify({ model: "m", reasoning: { effort: "max" }, prompt_cache_key: "s1", input: [{ type: "configuration_update", reasoning: { effort: "max" } }] });
      for (const path of ["/gz", "/chunked", "/nofinal", "/err"]) { const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers: { "content-type": "application/json" } }); await res.arrayBuffer(); }
      let lines: any[] = [];
      for (let attempt = 0; attempt < 100 && lines.length < 4; attempt++) { await new Promise(resolve => setTimeout(resolve, 30)); lines = existsSync(wire) ? (await readFile(wire, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; }
      const [gz, chunked, nofinal, err] = ["/gz", "/chunked", "/nofinal", "/err"].map(path => lines.find(line => line.path === path));
      expect(gz).toMatchObject({ model: "m", effort: "max", updateEfforts: ["max"], session: "s1", status: 200, respModel: "gz-model", finalModel: "gz-model", usage: { input: 10, output: 5, reasoning: 1 }, costUSD: 0.00007 });
      expect(chunked).toMatchObject({ status: 200, finalModel: "c-model", usage: { input: 10, output: 5, reasoning: 1 } });
      expect(nofinal).toMatchObject({ status: 200, noFinalEvent: true });
      expect(nofinal.usage).toBeUndefined();
      expect(nofinal.costUSD).toBeUndefined();
      expect(err).toMatchObject({ status: 429, providerError: { type: "rate_limit", code: "429", message: "slow down" } });
      const totals = JSON.parse(await readFile(`${wire}.totals.json`, "utf8"));
      expect(totals).toMatchObject({ requests: 4, unknownUsage: 2, providerErrors: 1, byUpdateEffort: { max: 4 }, byStatus: { 200: 3, 429: 1 }, overshootUSD: 0 });
    } finally { child.kill("SIGKILL"); upstream.closeAllConnections(); upstream.close(); }
  });
});

describe("mdsd-ab r2 matrix harness", () => {
  it.skipIf(!r1)("recovers r1's admitted call: the three strategies verbatim (= the admission event), only the four recorded scratch phrases replaced", () => {
    const { call, admitted, round } = recoverRound();
    expect(round.workers.map(worker => worker.name)).toEqual(["ultra-contracts", "routing-lifecycle", "oneshot-host"]);
    expect(round.workers.map(worker => worker.strategy)).toEqual(call.workers.map((worker: any) => worker.strategy));
    expect(round.workers.map(worker => worker.strategy)).toEqual(admitted.workers.map((worker: any) => worker.strategy));
    expect(round.workers.map(worker => (worker.strategy.operators as string[]).join("+"))).toEqual(["INVERT+VALIDATE", "DECOMPOSE+CHALLENGE", "EXPAND+VALIDATE"]);
    expect(round.workers.map(worker => worker.strategy.budget)).toEqual([12_000, 12_000, 14_000].map(outputTokens => ({ requests: 60, minutes: 35, costUSD: 5, outputTokens })));
    const changed = [round.plan.constraints[4], ...round.workers.map(worker => worker.request)];
    SUBSTITUTIONS.forEach((sub, index) => { expect(changed[index]).toContain(sub.to); expect(changed[index]).not.toContain(sub.from); });
    expect(round.plan.constraints.slice(0, 4)).toEqual(call.plan.constraints.slice(0, 4));
    expect({ ...round.plan, constraints: undefined }).toEqual({ ...call.plan, constraints: undefined });
    expect(round.workers.map(worker => worker.request.length)).toEqual(call.workers.map((worker: any, index: number) => worker.request.length - SUBSTITUTIONS[index + 1]!.from.length + SUBSTITUTIONS[index + 1]!.to.length));
    expect(JSON.stringify(round)).not.toMatch(/\/tmp\//);
  });

  it.skipIf(!r1)("the matrix config: one search round, both models at max, a scratch per cell; the runtime's own admission counts six cells and refuses r1's totals", () => {
    const { round } = recoverRound();
    const config = matrixConfig(round);
    expect(parseMdsdConfig(config.mdsd)).toMatchObject({ maxRounds: 1, explorerScratch: true, total: { costUSD: 60, requests: 1200 }, replication: { models: [{ model: "cliproxyapi/gpt-6.1-sol", thinking: "max" }, { model: "cliproxyapi/claude-sonnet-5-5", thinking: "max" }] } });
    expect(admission(config)).toEqual({ cells: 6, worstUSD: 37.5, worstRequests: 462, searchLimitUSD: 42, searchLimitRequests: 840 });
    expect(() => admission({ ...config, mdsd: { ...config.mdsd, total: { costUSD: 30, requests: 600 } } })).toThrow(/worst case is \$37\.5 and 462 requests \(6 worker\(s\)/);
    // Six cells above a per-call cap of 4: refused when the run starts, before any explorer exists.
    expect(() => admission({ ...config, single: { ...config.single, maxSubWorkers: 4 } })).toThrow("3 strategies on 2 models are 6 explorers, above the cap of 4");
    expect(admission(matrixConfig(toyRound(round), true))).toMatchObject({ cells: 4 });
  });

  it("target check on content hashes: changed, removed and added files; orche's .orche spill counted apart; .git and the node_modules mount ignored", async () => {
    const dir = await temp();
    await mkdir(join(dir, "src")); await mkdir(join(dir, ".git")); await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "src/a.ts"), "a"); await writeFile(join(dir, "b.md"), "b"); await writeFile(join(dir, ".git/HEAD"), "x"); await symlink("src/a.ts", join(dir, "link"));
    const before = contentHashes(dir);
    expect(Object.keys(before).sort()).toEqual(["b.md", "link", "src/a.ts"]);
    expect(hashDiff(before, contentHashes(dir))).toMatchObject({ unchanged: true, spill: 0 });
    await mkdir(join(dir, ".orche/artifacts"), { recursive: true }); await writeFile(join(dir, ".orche/artifacts/bash-1.txt"), "out"); await writeFile(join(dir, ".git/HEAD"), "y"); await writeFile(join(dir, "node_modules/x"), "y");
    expect(hashDiff(before, contentHashes(dir))).toMatchObject({ unchanged: true, spill: 1, added: [] });
    await writeFile(join(dir, "src/a.ts"), "A"); await rm(join(dir, "b.md")); await writeFile(join(dir, "c.txt"), "c");
    expect(hashDiff(before, contentHashes(dir))).toMatchObject({ unchanged: false, changed: ["src/a.ts"], removed: ["b.md"], added: ["c.txt"] });
  });

  it("audit: a cell's own scratch and own spill pass; a sibling's scratch (W1.10 is not W1.1), another agent's spill and forbidden paths are reported", async () => {
    const dir = await temp();
    const root = "/tmp/pi-orche/tmp/pi-orche/mdsd-ab-matrix";
    const call = (args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: args }] } });
    const result = (text: string) => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
    const lines = [{ type: "session", id: "s-cell" }, call({ command: `node ${root}/W1.1/probe.mjs > ${root}/W1.1/out.txt.` }), result("Full output saved to .orche/artifacts/bash-own.txt; use read"), call({ command: "cat .orche/artifacts/bash-own.txt" }),
      call({ command: `cat ${root}/W1.2/probe.mjs` }), call({ command: "cat .orche/artifacts/bash-other.txt" }), call({ command: `ls ${root}/W1.10` }), call({ command: "cat ~/.pi/agent/orche/records/x" }), call({ command: "ls .orche" })];
    await mkdir(join(dir, "workers"));
    const file = join(dir, "workers", "W1.1-2026-10-17T00-00-00-000Z.jsonl");
    await writeFile(file, lines.map(line => JSON.stringify(line)).join("\n"));
    const audit = auditMatrix([file], root, new Set(["W1.1", "W1.2", "W1.10"]));
    expect(audit.calls).toBe(7);
    expect(audit.cross).toHaveLength(3);
    expect(audit.cross.join("\n")).toMatch(/W1\.2\/probe\.mjs[\s\S]*bash-other\.txt[\s\S]*W1\.10/);
    expect(audit.hits).toHaveLength(1);
    expect(audit.hits[0]).toContain(".pi/agent/orche");
    expect(audit.review).toHaveLength(1);
  });

  it("session attribution: a transcript's line-1 session id names its agent (from the file name), with its models, thinking and reports", async () => {
    const dir = await temp();
    await mkdir(join(dir, "workers"));
    const entries = [{ type: "session", id: "sess-cell", timestamp: "t0" }, { type: "model_change", provider: "p", modelId: "m" }, { type: "thinking_level_change", thinkingLevel: "max" }, { type: "message", timestamp: "t1", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", name: "report_result", arguments: { kind: "answer" } }] } }];
    await writeFile(join(dir, "workers", "W1.4-2026-10-17T00-00-00-000Z.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n"));
    await writeFile(join(dir, "main.jsonl"), JSON.stringify({ type: "session", id: "mdsd-ab-matrix" }));
    const map = sessionTranscripts(dir);
    expect(map.get("sess-cell")).toMatchObject({ agent: "W1.4", models: ["p/m"], thinking: ["max"], responseModels: { "p/m": 1 }, reports: [{ arguments: { kind: "answer" } }] });
    expect(map.get("mdsd-ab-matrix")?.agent).toBe("main");
    const stats = wireStats([
      { at: "2026-01-01T00:00:00Z", endAt: "2026-01-01T00:00:02Z", model: "m", effort: "max", status: 200, usage: { input: 3, cached: 1, output: 2, reasoning: 1 }, costUSD: 0.5 },
      { at: "2026-01-01T00:00:01Z", endAt: "2026-01-01T00:00:03Z", model: "m", effort: "max", status: 200, noFinalEvent: true },
    ]);
    expect(stats).toMatchObject({ requests: 2, unknownUsage: 1, costUSD: 0.5, spanMs: 3000, routes: { "m@max": 2 }, input: 3, output: 2 });
  });
});

describe("quality validation harness (experiments/mdsd-ab/quality.ts)", () => {
  it("claims: JSON found inside prose, ids renumbered, every quote checked verbatim (word-normalized) against the answer document", () => {
    const document = answerDocument({ text: "The cache **is never** invalidated after a write (src/cache.ts:40).", report: { arguments: { summary: "one finding", data: { findings: 1 } } } });
    expect(document).toContain("# Final message to the user");
    const claims = parseClaims('Result: {"claims":[{"id":"x9","claim":"Cache not invalidated","quote":"The cache is never invalidated after a write","locations":["src/cache.ts:40"],"stance":"asserted"},{"id":"x9","claim":"Made up","quote":"nothing like this appears","stance":"weird"},{"claim":" "}]} end', document);
    expect(claims.map(claim => [claim.id, claim.quoteOk, claim.stance, claim.locations])).toEqual([["c1", true, "asserted", ["src/cache.ts:40"]], ["c2", false, "asserted", []]]);
    expect(() => parseClaims("no json here", document)).toThrow("no JSON object");
    expect(() => parseClaims('{"items":[]}', document)).toThrow("no claims array");
  });

  it("seeds: origin-blinded P1/P2 labels fixed per unit, every registered claim mapped back to its stage, a valid mdsd.seed", () => {
    const claim = (id: string, text: string) => ({ id, claim: text, quote: "", locations: [], requirements: [], stance: "asserted" as const, quoteOk: false });
    const sets = { S: [claim("c1", "s one"), claim("c2", "s two")], E: [claim("c1", "e one")] };
    const { seed, key, map } = seedsOf("dev-r1", sets);
    expect(new Set([key.P1, key.P2])).toEqual(new Set(["S", "E"]));
    expect(seed.claims.map(item => item.ref)).toEqual(key.P1 === "S" ? ["P1:c1", "P1:c2", "P2:c1"] : ["P1:c1", "P2:c1", "P2:c2"]);
    expect(Object.values(map).sort()).toEqual(["E:c1", "S:c1", "S:c2"]);
    expect(seedsOf("dev-r1", sets).key).toEqual(key);
    expect(parseMdsdConfig({ seed }).seed?.claims).toHaveLength(3);
  });

  it.skipIf(!existsSync(join(homedir(), ".pi/agent/orche.config.json")))("stage configs: the live strong route, no money/request/output ceilings for the quality stages, time bounds, max-preserving recovery; defaults untouched", () => {
    const config = qualityConfig("A", { claims: [{ ref: "P1:c1", claim: "x" }] }) as any;
    expect(parseThinkingPolicyConfig(config.thinkingPolicy)).toMatchObject({ lengthRecovery: "redecompose" });
    expect(parseMdsdConfig(config.mdsd)).toMatchObject({ maxRounds: 3, explorerScratch: true, total: { costUSD: 100_000_000, requests: 10_000_000 }, explorer: { minutes: 240 }, seed: { claims: [{ ref: "P1:c1" }] } });
    expect(config.limits).toMatchObject({ assignmentMs: 6 * 3_600_000, maxExtensions: 2 });
    expect(config.models?.["strong-orchestrator"]?.model).toBeDefined();
    expect("mdsd" in qualityConfig("S")).toBe(false);
    expect(DEFAULT_MDSD).toMatchObject({ total: { costUSD: 80, requests: 600 }, explorer: { costUSD: 6 } });
    expect("seed" in DEFAULT_MDSD).toBe(false);
  });

  it("freezes the result of the last completed orche task's worker, not W1's last report, when main retried with a new worker", () => {
    const sessions = new Map([
      ["a", { agent: "W1", reports: [{ summary: "W1 partial" }] }],
      ["b", { agent: "W2", reports: [{ summary: "W2 first" }, { summary: "W2 final" }] }],
    ]);
    const run = (worker: string, start: string, status: string) => ({ run: { worker: { id: worker }, start, status, outcome: { status: status === "done" ? "completed" : "failed" } } });
    const retried = [run("W2", "2026-10-18T04:32:54Z", "done"), run("W1", "2026-10-18T02:49:13Z", "failed"), run("W1", "2026-10-18T03:51:53Z", "failed")];
    expect(finalReport(retried, sessions)).toEqual({ summary: "W2 final" });
    expect(finalReport([run("W1", "2026-10-18T02:49:13Z", "done"), run("W2", "2026-10-18T03:00:00Z", "failed")], sessions)).toEqual({ summary: "W1 partial" });
    expect(finalReport([run("W2", "2026-10-18T03:00:00Z", "failed")], sessions)).toEqual({ summary: "W2 final" });
    expect(finalReport([], sessions)).toEqual({ summary: "W1 partial" });
  });
});
