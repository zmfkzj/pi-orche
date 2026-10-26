/**
 * Model-free tests of the witness-replay pilot harness (experiments/witness-replay): the route guard and budget of the unit proxy
 * against an upstream that counts what reaches it, the mechanical witness execution (hash, nonce, exit agreement, import-root
 * hazards, read-only candidate, no network), the acceptance rule that is the only difference between the arms, the identical
 * prompt, the schedule, the attempt classification and the preregistered decision.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unitState } from "../../experiments/witness-replay/cli.js";
import { finalDiff, stageWorkspace } from "../../experiments/witness-replay/env.js";
import { addedLines, freeze, hiddenOverlap } from "../../experiments/witness-replay/freeze.js";
import { admit, startProxy, substituteKey } from "../../experiments/witness-replay/proxy.mjs";
import { ARMS, BUDGET, EFFORT, MAX_COUNTED_SESSIONS, MODEL, SEEDS, acceptanceHolds, r1Gate, afterTurnEnd, classifyAttempt, decide, gateMessage, repaired, revisionPrompt, schedule, type Outcome } from "../../experiments/witness-replay/protocol.js";
import { HIDDEN_ROOTS, bwrapArgs } from "../../experiments/witness-replay/sandbox.js";
import { stopOf } from "../../experiments/witness-replay/unit.js";
import { WITNESS_MOUNT, copyCandidate, runWitness, sha256, statusOf, treeDigest } from "../../experiments/witness-replay/witness-run.js";

const ROUTE = { model: MODEL.id, effort: EFFORT };
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
const valid = { model: MODEL.id, reasoning: { effort: EFFORT }, input: [], prompt_cache_key: "wr-test" };
const scratch = mkdtempSync(join(tmpdir(), "wr-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the unit proxy fails closed before forwarding", () => {
  const envelope = { route: ROUTE, maxRequests: 2 };
  it("forwards only a parseable POST naming the pinned model and effort", () => {
    expect(admit(envelope, { method: "POST", body: body(valid) }, 0)).toMatchObject({ forward: true, facts: { model: MODEL.id, effort: EFFORT, session: "wr-test" } });
    expect(admit(envelope, { method: "POST", encoding: "gzip", body: gzipSync(body(valid)) }, 0).forward).toBe(true);
    expect(admit(envelope, { method: "GET", body: Buffer.alloc(0) }, 99).forward).toBe(true);
  });
  it.each([
    ["unparseable body", { method: "POST", body: Buffer.from("{not json") }, "unverifiable"],
    ["unknown content-encoding", { method: "POST", encoding: "x-custom", body: body(valid) }, "unverifiable"],
    ["no model", { method: "POST", body: body({ reasoning: { effort: EFFORT } }) }, "unverifiable"],
    ["no effort", { method: "POST", body: body({ model: MODEL.id }) }, "unverifiable"],
    ["conflicting effort fields", { method: "POST", body: body({ model: MODEL.id, reasoning: { effort: "high" }, reasoning_effort: "xhigh" }) }, "unverifiable"],
    ["another model", { method: "POST", body: body({ ...valid, model: "bts/gpt-6.1-sol" }) }, "route"],
    ["another effort", { method: "POST", body: body({ ...valid, reasoning: { effort: "xhigh" } }) }, "route"],
    ["max effort", { method: "POST", body: body({ ...valid, reasoning: { effort: "max" } }) }, "route"],
    ["an off-route configuration_update", { method: "POST", body: body({ ...valid, input: [{ type: "configuration_update", reasoning: { effort: "xhigh" } }] }) }, "route"],
    ["a JSON array body", { method: "POST", body: body([valid]) }, "unverifiable"],
    ["another method", { method: "PUT", body: body(valid) }, "method"],
  ] as const)("refuses %s", (_label, req, refused) => {
    const verdict = admit(envelope, req as never, 0);
    expect(verdict.forward).toBe(false);
    if (!verdict.forward) expect(verdict.refused).toBe(refused);
  });
  it("refuses the request after the budget", () => {
    const verdict = admit(envelope, { method: "POST", body: body(valid) }, 2);
    expect(verdict).toMatchObject({ forward: false, status: 403, refused: "budget" });
  });
  it("substitutes the placeholder key and nothing else", () => {
    expect(substituteKey({ authorization: "Bearer ph-key", accept: "x" }, "ph-key", "real")).toEqual({ authorization: "Bearer real", accept: "x" });
  });
});

describe("the unit proxy against an upstream that counts what reaches it", () => {
  let upstream: Server; let port = 0;
  const seen: { method: string; auth?: string; at: number }[] = [];
  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.push({ method: req.method!, auth: req.headers.authorization, at: Date.now() });
      req.resume();
      req.on("end", () => {
        const model = req.headers["x-test-model"] ?? MODEL.id;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: {"type":"response.created","response":{"model":"${model}"}}\n\ndata: {"type":"response.completed","response":{"model":"${model}","usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":4}}}}\n\n`);
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
    port = (upstream.address() as { port: number }).port;
  });
  afterAll(() => upstream.close());
  const send = (address: string, method: string, data: Buffer, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
    const [host, p] = address.split(":");
    const req = request({ host, port: Number(p), method, path: "/backend-api/codex/responses", headers: { authorization: "Bearer ph-key", "content-type": "application/json", ...headers } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end(data);
  });
  it("forwards only on-route requests within budget, journals starts, substitutes the key and counts off-route responses", async () => {
    const log = join(scratch, "wire.jsonl");
    const { server, address } = await startProxy({ listen: 0, target: new URL(`http://127.0.0.1:${port}`), log, envelope: { route: ROUTE, maxRequests: 2, placeholderKey: "ph-key", prices: { [MODEL.id]: { input: 1, output: 2, cacheRead: 0.1 } } }, key: "real-key" });
    try {
      expect(await send(address, "POST", body(valid))).toBe(200);
      expect(await send(address, "POST", body({ ...valid, reasoning: { effort: "xhigh" } }))).toBe(400);
      expect(await send(address, "POST", Buffer.from("garbage"))).toBe(400);
      expect(await send(address, "POST", body(valid), { "x-test-model": "bts/gpt-6.1-sol" })).toBe(200);
      expect(await send(address, "POST", body(valid))).toBe(403);
      expect(await send(address, "PUT", body(valid))).toBe(405);
      expect(seen.filter(item => item.method === "POST")).toHaveLength(2);
      expect(seen.every(item => item.auth === "Bearer real-key")).toBe(true);
      const totals = JSON.parse(readFileSync(`${log}.totals.json`, "utf8"));
      expect(totals).toMatchObject({ forwarded: 2, completed: 2, refused: { route: 1, unverifiable: 1, budget: 1, method: 1 }, offRouteResponses: 1 });
      const lines = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const started = lines.filter(line => line.phase === "start").map(line => line.id);
      for (const id of started) expect(lines.findIndex(line => line.phase === "start" && line.id === id)).toBeLessThan(lines.findIndex(line => line.phase === "end" && line.id === id));
      expect(readFileSync(log, "utf8")).not.toContain("real-key");
    } finally { server.close(); }
  });
});

const hasBwrap = existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/python3") && (() => { try { execFileSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--unshare-net", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("R1 stop rule", () => {
  it("admits a pilot only with two qualified failure families and no unqualified failure seed", () => {
    expect(r1Gate(SEEDS)).toEqual({ ok: false, families: ["masked-compatibility"], excluded: ["tox"] });
    expect(r1Gate(SEEDS.filter(seed => seed.id !== "tox")).ok).toBe(false);
    expect(r1Gate(SEEDS, { "masked-compatibility": true, "compatibility-retraction": true }).ok).toBe(true);
    expect(r1Gate(SEEDS.map(seed => (seed.id === "tox" ? { ...seed, family: "masked-compatibility" } : seed)), { "masked-compatibility": true }).ok).toBe(false);
  });
  it("freeze refuses the default pilot before writing anything", async () => {
    const out = mkdtempSync(join(scratch, "freeze-"));
    await expect(freeze(out, join(out, "scratch"))).rejects.toThrow(/R1 stop: qualified failure families \[masked-compatibility\], unqualified failure seeds \[tox\]/);
    expect(existsSync(join(out, "frozen"))).toBe(false);
  });
});

describe.skipIf(!hasBwrap)("mechanical witness execution", () => {
  const venv = join(scratch, "venv");
  const project = (value: number, extra: (dir: string) => void = () => {}) => {
    const dir = mkdtempSync(join(scratch, "cand-"));
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname='p'\n");
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg/__init__.py"), "");
    writeFileSync(join(dir, "pkg/mod.py"), `VALUE = ${value}\n`);
    extra(dir);
    return dir;
  };
  const witness = (code: string) => { const file = join(scratch, `w-${sha256(code).slice(0, 8)}.py`); writeFileSync(file, code); return { file, sha: sha256(readFileSync(file)) }; };
  const standard = witness([
    "import json, os, sys, socket",
    "import pkg.mod as m",
    "root = os.path.realpath(os.environ['WITNESS_CANDIDATE_ROOT'])",
    "trusted = os.path.realpath(m.__file__).startswith(root + os.sep)",
    "try:\n    open(os.path.join(root, 'written'), 'w').write('x'); wrote = True\nexcept OSError:\n    wrote = False",
    "try:\n    socket.create_connection(('1.1.1.1', 80), timeout=2); net = True\nexcept OSError:\n    net = False",
    "ok = trusted and m.VALUE == 2 and not wrote and not net",
    "print('WITNESS_RESULT ' + json.dumps({'nonce': os.environ.get('WITNESS_NONCE'), 'passed': ok, 'trusted': trusted, 'cases': [{'id': 'value', 'passed': m.VALUE == 2}, {'id': 'readonly', 'passed': not wrote}, {'id': 'offline', 'passed': not net}]}))",
    "sys.exit(0 if ok else (1 if trusted else 2))",
  ].join("\n"));
  beforeAll(() => { mkdirSync(join(venv, "bin"), { recursive: true }); symlinkSync("/usr/bin/python3", join(venv, "bin/python")); });
  const run = (candidate: string, w = standard, expected = w.sha) => runWitness({ name: "t", file: w.file, expectedSha256: expected, candidate, venv, pythonPath: ".", scratch: join(scratch, "runs") });

  it("passes the fixed candidate, fails the unfixed one, and the candidate is read-only and offline", async () => {
    const fixed = project(2);
    const before = treeDigest(fixed);
    const pass = await run(fixed);
    expect(pass.status).toBe("pass");
    expect(pass.result?.cases?.map(c => c.passed)).toEqual([true, true, true]);
    expect(pass.candidateDigest).toBe(before);
    expect(treeDigest(fixed)).toBe(before);
    expect(existsSync(join(fixed, "written"))).toBe(false);
    expect((await run(project(1))).status).toBe("fail");
  });
  it("refuses a witness whose bytes are not the frozen ones", async () => {
    const record = await run(project(2), standard, "0".repeat(64));
    expect(record.status).toBe("tampered");
    expect(record.exit).toBeNull();
  });
  it("is untrusted when the witness says so, or when the candidate has an import-root hook", async () => {
    const lying = witness("import json, os, sys\nprint('WITNESS_RESULT ' + json.dumps({'nonce': os.environ['WITNESS_NONCE'], 'passed': False, 'trusted': False, 'problems': ['wrong import root']}))\nsys.exit(2)\n");
    expect((await run(project(2), lying)).status).toBe("untrusted");
    const hooked = await run(project(2, dir => writeFileSync(join(dir, "sitecustomize.py"), "")));
    expect(hooked.status).toBe("untrusted");
    expect(hooked.hazards).toContain("sitecustomize.py at the import root");
  });
  it("never passes a stale or forged result line, nor an exit that disagrees with it", async () => {
    const stale = witness("import json\nprint('WITNESS_RESULT ' + json.dumps({'nonce': 'deadbeef', 'passed': True, 'trusted': True}))\n");
    expect((await run(project(2), stale)).status).toBe("error");
    const disagree = witness("import json, os, sys\nprint('WITNESS_RESULT ' + json.dumps({'nonce': os.environ['WITNESS_NONCE'], 'passed': True, 'trusted': True}))\nsys.exit(1)\n");
    expect((await run(project(2), disagree)).status).toBe("error");
    expect(statusOf({ code: 0, guardFired: true }, "", "n").status).toBe("error");
    expect(statusOf({ code: 0, guardFired: false }, "no line", "n").status).toBe("error");
  });
  it("never passes from the wrong workspace, a symlink escape, a skip or an early exit; protocol-aware files are recorded", async () => {
    const decoy = join(venv, "decoy", "pkg");
    mkdirSync(decoy, { recursive: true }); writeFileSync(join(decoy, "__init__.py"), ""); writeFileSync(join(decoy, "mod.py"), "VALUE = 2\n");
    const escaped = mkdtempSync(join(scratch, "cand-")); writeFileSync(join(escaped, "pyproject.toml"), "");
    symlinkSync(decoy, join(escaped, "pkg"));
    expect((await run(escaped)).status).toBe("untrusted");
    const skipped = await run(project(2, dir => writeFileSync(join(dir, "pkg/mod.py"), "import unittest\nraise unittest.SkipTest('skip')\n")));
    expect(skipped.status).toBe("error");
    const exited = await run(project(2, dir => writeFileSync(join(dir, "pkg/mod.py"), "import sys\nsys.exit(0)\n")));
    expect(exited.status).toBe("error");
    const aware = await run(project(2, dir => writeFileSync(join(dir, "pkg/helper.py"), "import os\nNONCE = os.environ.get('WITNESS_NONCE')\n")));
    expect(aware.protocolRefs).toEqual(["pkg/helper.py"]);
  });
  it("native extras: read-only binds and PYTHONPATH after the candidate; the run's own variables cannot be overridden", async () => {
    const native = mkdtempSync(join(scratch, "native-"));
    mkdirSync(join(native, "nativelib")); writeFileSync(join(native, "nativelib/__init__.py"), "X = 7\n");
    mkdirSync(join(native, "pkg")); writeFileSync(join(native, "pkg/__init__.py"), ""); writeFileSync(join(native, "pkg/mod.py"), "VALUE = 2\n");
    const w = witness([
      "import json, os, sys",
      "import pkg.mod as m, nativelib",
      "root = os.path.realpath(os.environ['WITNESS_CANDIDATE_ROOT'])",
      "trusted = os.path.realpath(m.__file__).startswith(root + os.sep) and os.environ.get('EXTRA_FLAG') == 'on'",
      "try:\n    open(os.path.join(os.path.dirname(nativelib.__file__), 'w'), 'w').write('x'); wrote = True\nexcept OSError:\n    wrote = False",
      "ok = trusted and m.VALUE == 2 and nativelib.X == 7 and not wrote and os.environ['PATH'].split(':')[0] == '/opt/fakebin'",
      "print('WITNESS_RESULT ' + json.dumps({'nonce': os.environ.get('WITNESS_NONCE'), 'passed': ok, 'trusted': trusted, 'cases': [{'id': 'value', 'passed': m.VALUE == 2}, {'id': 'readonly', 'passed': not wrote}]}))",
      "sys.exit(0 if ok else (1 if trusted else 2))",
    ].join("\n"));
    const extra = { binds: [{ from: native, rw: true }], pythonPath: [native], path: ["/opt/fakebin"], env: { EXTRA_FLAG: "on", WITNESS_NONCE: "forged", WITNESS_CANDIDATE_ROOT: native, PATH: "/evil" } };
    const go = (candidate: string) => runWitness({ name: "t", file: w.file, expectedSha256: w.sha, candidate, venv, pythonPath: ".", scratch: join(scratch, "runs"), extra });
    expect((await go(project(2))).status).toBe("pass");
    const shadowed = await go(project(1));
    expect(shadowed.status).toBe("fail");
    expect(shadowed.result?.cases?.map(c => c.passed)).toEqual([false, true]);
  });
  it("copies symlinks as links and the digest covers their targets", async () => {
    const dir = project(2, d => symlinkSync("/etc/hostname", join(d, "escape")));
    const copy = join(scratch, `copy-${Date.now()}`);
    await copyCandidate(dir, copy);
    expect(treeDigest(copy)).toBe(treeDigest(dir));
    rmSync(join(dir, "escape")); symlinkSync("/etc/passwd", join(dir, "escape"));
    expect(treeDigest(copy)).not.toBe(treeDigest(dir));
  });
});

describe("the only difference between the arms: acceptance", () => {
  it("C accepts at turn end; T accepts only a passing harness run of the unchanged reproducer", () => {
    expect(afterTurnEnd("C", { gateRounds: 0, forwarded: 0, remainingMs: 1 })).toBe("accept");
    expect(afterTurnEnd("T", { gate: { status: "pass" }, gateRounds: 1, forwarded: 5, remainingMs: 1 })).toBe("accept");
    for (const status of ["fail", "untrusted", "tampered", "error"]) expect(afterTurnEnd("T", { gate: { status }, gateRounds: 1, forwarded: 5, remainingMs: 1000 })).toBe("continue");
    expect(() => afterTurnEnd("T", { gateRounds: 0, forwarded: 0, remainingMs: 1 })).toThrow();
  });
  it("a failing T gate never grants requests or time beyond the shared budget", () => {
    expect(afterTurnEnd("T", { gate: { status: "fail" }, gateRounds: BUDGET.maxGateRounds, forwarded: 5, remainingMs: 1000 })).toBe("gate-exhausted");
    expect(afterTurnEnd("T", { gate: { status: "fail" }, gateRounds: 1, forwarded: BUDGET.maxRequests, remainingMs: 1000 })).toBe("budget-exhausted");
    expect(afterTurnEnd("T", { gate: { status: "fail" }, gateRounds: 1, forwarded: 5, remainingMs: 0 })).toBe("time-exhausted");
  });
  it("an edit after the acceptance check invalidates the acceptance", () => {
    const dir = mkdtempSync(join(scratch, "acc-"));
    writeFileSync(join(dir, "a.py"), "x = 1\n");
    const accepted = treeDigest(dir);
    expect(acceptanceHolds(accepted, treeDigest(dir))).toBe(true);
    writeFileSync(join(dir, "a.py"), "x = 2\n");
    expect(acceptanceHolds(accepted, treeDigest(dir))).toBe(false);
    expect(acceptanceHolds(undefined, treeDigest(dir))).toBe(false);
  });
});

describe("prompt, gate message and schedule", () => {
  const task = { problemStatement: "Issue text", interface: "Type: Function" };
  it("one prompt per seed, no arm in it: C and T get byte-identical text", () => {
    expect(revisionPrompt.length).toBe(3);
    for (const seed of SEEDS) {
      const prompt = revisionPrompt(seed, task, WITNESS_MOUNT);
      expect(prompt).toContain(WITNESS_MOUNT);
      expect(prompt).toContain(seed.diagnostic.text.trim());
      expect(prompt).not.toMatch(/acceptance check|automatically by the harness|arm [CT]\b/i);
    }
  });
  it("the gate message carries the reproducer's own output and says the candidate is not accepted", () => {
    const message = gateMessage(WITNESS_MOUNT, { exit: 1, status: "fail", output: "[FAIL] case\nWITNESS_RESULT {}" });
    expect(message).toContain("[FAIL] case");
    expect(message).toContain("not accepted");
    expect(gateMessage(WITNESS_MOUNT, { exit: 1, status: "fail", output: "x".repeat(10_000) }, 100).length).toBeLessThan(1000);
  });
  it("pairs both arms of a seed, alternates which starts first, at most ten sessions", () => {
    const units = schedule(SEEDS);
    expect(units.length).toBeLessThanOrEqual(MAX_COUNTED_SESSIONS);
    expect(units.map(u => u.name)).toEqual(SEEDS.flatMap((seed, i) => (i % 2 === 0 ? ARMS : [...ARMS].reverse()).map(arm => `${seed.id}-${arm}`)));
    expect(() => schedule([...SEEDS, ...SEEDS])).toThrow();
  });
});

describe("attempts", () => {
  it("classifies invalid attempts (rerun once) apart from valid outcomes (never rerun)", () => {
    expect(classifyAttempt(["turn-end"], { forwarded: 10, refusedRoute: 0, offRouteResponses: 0 })).toEqual({ valid: true });
    expect(classifyAttempt(["budget"], { forwarded: 60, refusedRoute: 0, offRouteResponses: 0 })).toEqual({ valid: true });
    expect(classifyAttempt(["turn-end"], { forwarded: 10, refusedRoute: 1, offRouteResponses: 0 })).toMatchObject({ invalid: "off-route" });
    expect(classifyAttempt(["turn-end"], { forwarded: 10, refusedRoute: 0, offRouteResponses: 1 })).toMatchObject({ invalid: "off-route" });
    expect(classifyAttempt(["provider-error"], { forwarded: 3, refusedRoute: 0, offRouteResponses: 0 })).toMatchObject({ invalid: "capacity" });
    expect(classifyAttempt(["no-model"], { forwarded: 0, refusedRoute: 0, offRouteResponses: 0 })).toMatchObject({ invalid: "infrastructure" });
  });
  it("reads how a Pi invocation ended from its events and the proxy deltas", () => {
    const end = (reason: string, error?: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: reason, ...(error ? { errorMessage: error } : {}) } });
    const zero = { forwarded: 1, budget: 0, route: 0, unverifiable: 0, providerErrors: 0 };
    expect(stopOf(end("stop"), { code: 0, guardFired: false }, zero).stop).toBe("turn-end");
    expect(stopOf(end("error", "request budget of 60 model requests for this session is spent"), { code: 1, guardFired: false }, { ...zero, budget: 1 }).stop).toBe("budget");
    expect(stopOf(end("error", "529 overloaded"), { code: 1, guardFired: false }, { ...zero, providerErrors: 1 }).stop).toBe("provider-error");
    expect(stopOf(end("stop"), { code: 0, guardFired: false }, { ...zero, route: 1 }).stop).toBe("route-refused");
    expect(stopOf("", { code: 1, guardFired: false }, { ...zero, forwarded: 0 }).stop).toBe("no-model");
    expect(stopOf(end("stop"), { code: null, guardFired: true }, zero).stop).toBe("time");
  });
  it("counts at most one rerun; an interrupted attempt is an invalid one; a missing unit is never a failure", () => {
    expect(unitState([{ name: "attempt-1", meta: { status: "completed", valid: true, terminal: "accepted" } }], 1)).toMatchObject({ counted: "attempt-1", next: "done" });
    expect(unitState([{ name: "attempt-1", meta: { status: "completed", valid: false, terminal: "invalid" } }], 1)).toMatchObject({ next: "run" });
    expect(unitState([{ name: "attempt-1.interrupted" }, { name: "attempt-2", meta: { status: "completed", valid: false, terminal: "invalid" } }], 1)).toMatchObject({ next: "missing" });
  });
});

describe("the preregistered decision", () => {
  const o = (seed: string, arm: "C" | "T", fixedOrKept: boolean, extra: Partial<Outcome> = {}): Outcome => {
    const role = seed === "hf" || seed === "tox" ? "failure" : "control";
    const family = seed === "hf" ? "masked-compatibility" : seed === "tox" ? "compatibility-retraction" : "control";
    return { seed, arm, role, family, witnessPass: fixedOrKept, ...(role === "failure" ? { heldoutPass: fixedOrKept } : {}), newFailures: [], integrityViolations: [], leakHits: [], ...extra };
  };
  const controls = [o("sqlglot", "C", true), o("sqlglot", "T", true), o("stravalib", "C", true), o("stravalib", "T", true)];
  it("GO only when T repairs every qualified family and C does not", () => {
    expect(decide([o("hf", "C", false), o("hf", "T", true), o("tox", "C", false), o("tox", "T", true), ...controls]).verdict).toBe("go");
  });
  it("prefer C when C repairs what T repairs", () => {
    expect(decide([o("hf", "C", true), o("hf", "T", true), o("tox", "C", true), o("tox", "T", true), ...controls]).verdict).toBe("prefer-C");
  });
  it("no-go when T fails HF, regresses a control or breaks integrity", () => {
    expect(decide([o("hf", "C", false), o("hf", "T", false), o("tox", "C", false), o("tox", "T", true), ...controls]).verdict).toBe("no-go");
    expect(decide([o("hf", "C", false), o("hf", "T", true), o("tox", "C", false), o("tox", "T", true), o("sqlglot", "C", true), o("sqlglot", "T", false), o("stravalib", "C", true), o("stravalib", "T", true)]).verdict).toBe("no-go");
    expect(decide([o("hf", "C", false), o("hf", "T", true, { integrityViolations: ["deleted test"] }), o("tox", "C", false), o("tox", "T", true), ...controls]).verdict).toBe("no-go");
  });
  it("not supported when T adds value on one family only; inconclusive when a unit is missing", () => {
    expect(decide([o("hf", "C", false), o("hf", "T", true), o("tox", "C", false), o("tox", "T", false), ...controls]).verdict).toBe("not-supported");
    expect(decide([o("hf", "C", false), o("hf", "T", true), { ...o("tox", "C", false), missing: true }, o("tox", "T", true), ...controls]).verdict).toBe("inconclusive");
  });
  it("a repair needs the held-out check too, and no new visible failures", () => {
    expect(repaired(o("hf", "T", true, { heldoutPass: false }))).toBe(false);
    expect(repaired(o("hf", "T", true, { newFailures: ["tests/x.py::t"] }))).toBe(false);
  });
});

describe("freeze guards and the sandbox command line", () => {
  it("finds model-facing lines shared with hidden tests that the public text does not have", () => {
    const hidden = addedLines("+++ b/t.py\n+    assert bar.n == 5  # hidden expectation\n+import os\n+from tqdm.auto import tqdm as public_line\n");
    expect(hiddenOverlap("x\n    assert bar.n == 5  # hidden expectation\nfrom tqdm.auto import tqdm as public_line", hidden, "from tqdm.auto import tqdm as public_line")).toEqual(["assert bar.n == 5  # hidden expectation"]);
  });
  it("hides home, tmp and the rest, unshares the network, clears the environment", () => {
    const args = bwrapArgs({ binds: [{ from: "/tmp/x" }, { from: "/tmp/y", to: "/opt/y", rw: true }], env: { A: "1" }, cwd: "/tmp/x", command: ["/bin/true"] });
    for (const root of HIDDEN_ROOTS) expect(args.join(" ")).toContain(`--tmpfs ${root}`);
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--clearenv");
    expect(args.join(" ")).toContain("--ro-bind /tmp/x /tmp/x --bind /tmp/y /opt/y");
    expect(args.slice(-2)).toEqual(["--", "/bin/true"]);
    expect(() => bwrapArgs({ binds: [{ from: "relative" }], env: {}, cwd: "/", command: ["x"] })).toThrow();
  });
  it("stages the original snapshot in the index and the candidate in the working tree", async () => {
    const original = mkdtempSync(join(scratch, "orig-")), seedTree = mkdtempSync(join(scratch, "seed-"));
    writeFileSync(join(original, "a.py"), "x = 1\n"); writeFileSync(join(original, "b.py"), "y = 1\n");
    writeFileSync(join(seedTree, "a.py"), "x = 2\n"); writeFileSync(join(seedTree, "c.py"), "z = 1\n");
    const ws = join(scratch, `ws-${Date.now()}`);
    const staged = await stageWorkspace(original, seedTree, ws);
    expect(staged.digest).toBe(treeDigest(seedTree));
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: ws }).toString();
    expect(status.split("\n").filter(Boolean).sort()).toEqual([" D b.py", " M a.py", "?? c.py"]);
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: ws }).toString().trim()).toBe("1");
    const diff = finalDiff(ws, staged.originalTree, scratch);
    expect(diff.files.sort()).toEqual(["A\tc.py", "D\tb.py", "M\ta.py"]);
  });
});
