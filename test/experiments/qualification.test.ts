import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aliasCollisions, clampCitations, claimsOf, keyOf, neutral, neutralizeText, packet, rawUnit, restore, ROOT, validateReferences, type Claim } from "../../experiments/mdsd-ab/qualification-inputs.js";
import { checkChanges, checkFinal, checkJudge, checkQualification, decisionAction, freeze, neutralIds, prompts } from "../../experiments/mdsd-ab/qualification.js";
import { canonicalModel, catalogueIds, filterCatalogue, pinAgent, safeSandbox, setStudy, sourceHashes, stateOf, verifyCached, type Turn } from "../../experiments/mdsd-ab/qualification-runtime.js";
import { guardStats, holdable, startGuard } from "../../experiments/mdsd-ab/qualification-guard.mjs";
import { sha } from "../../experiments/mdsd-ab/run.js";
import { QV } from "../../experiments/mdsd-ab/synthesis.js";

const temps: string[] = [];
async function temp() { const root = join(process.cwd(), ".orche/qualification-tests"); await mkdir(root, { recursive: true }); const d = await mkdtemp(join(root, "case-")); temps.push(d); return d; }
afterEach(async () => { for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true }); });
const claims: Claim[] = [{ ref: "k1", claim: "only nonempty comments remain", quote: "only nonempty comments remain", stance: "asserted", locations: ["x:1"], source: "doc-A" }, { ref: "k2", claim: "one source discovered a useful boundary", quote: "one source discovered a useful boundary", stance: "asserted", locations: ["x:2"], source: "doc-B" }];
const qualification = (ref: string) => ({ ref, action: "include", relevance: "supporting", support: "supported", taskLink: "I2 requires boundary conditions", evidence: "x:1 and frozen run", reason: "relevant boundary", qualifiers: ["nonempty"] });

describe("qualification contracts, without any model", () => {
  it("requires support and task connection even for retained claims, without equating absent evidence with falsehood", () => {
    const entries = claims.map(c => qualification(c.ref));
    expect(checkQualification(["k1", "k2"], { entries })).toEqual([]);
    entries[0]!.evidence = "";
    expect(checkQualification(["k1", "k2"], { entries })).toContain("k1: evidence");
    entries[0]!.support = "insufficient"; entries[0]!.evidence = "original execution log unavailable"; entries[0]!.action = "uncertain";
    expect(checkQualification(["k1", "k2"], { entries })).toEqual([]);
  });
  it("current T allows retained without new qualification; Q does not, but the single-source addition is not capped or voted out", () => {
    const final = "only nonempty comments remain. one source discovered a useful boundary.";
    const entries = [{ ref: "k1", disposition: "retained", spans: [claims[0]!.quote] }, { ref: "k2", disposition: "added", spans: [claims[1]!.quote], evidence: "x:2" }];
    expect(checkFinal(claims, "doc-A", "T", { entries }, final)).toEqual([]);
    expect(checkFinal(claims, "doc-A", "Q", { entries }, final).join(" ")).toMatch(/taskLink/);
    expect(checkFinal(claims, "doc-A", "Q", { entries: entries.map(e => ({ ...qualification(e.ref), ...e })) }, final)).toEqual([]);
  });
  it("keeps mechanical and semantic checks distinct: a span can exist while the final-text assessment is partial", () => {
    const entry = { ...qualification("k1"), disposition: "retained", spans: ["all the comments remain here"] };
    expect(checkFinal([claims[0]!], "doc-A", "Q", { entries: [entry] }, "all the comments remain here")).toEqual([]);
    const j = { statements: [{ id: "k1", realization: "partial", stance: "asserted", statusDrift: "none", quote: "all the comments remain here", lines: [1], note: "nonempty boundary lost" }], other: [], contradictions: [] };
    expect(checkJudge(["k1"], j, "all the comments remain here")).toEqual([]);
  });
  it("requires traces of changed qualification and rejects an unrealized duplicate target", () => {
    const initial = { entries: [qualification("k1")] };
    const final = { entries: [{ ...qualification("k1"), disposition: "out_of_scope", relevance: "out" }] };
    expect(checkChanges(initial, final, { changes: [] })).toHaveLength(1);
    expect(checkChanges(initial, final, { changes: [{ ref: "k1", reason: "no task linkage", evidence: "I4" }] })).toEqual([]);
    const data = { entries: [{ ref: "k1", disposition: "duplicate", duplicateOf: "k2" }, { ref: "k2", disposition: "unsupported", reason: "missing evidence" }] };
    expect(checkFinal(claims, "doc-A", "T", data, "This is a final answer.").join(" ")).toMatch(/k2 is not realized/);
    expect(decisionAction("retained")).toBe(decisionAction("added"));
  });
  it("requires both quotations for a repeated false assertion mixed with a correction", () => {
    const doc = "The empty input always works. That earlier statement was wrong.";
    const e = { id: "k1", realization: "partial", stance: "mixed", statusDrift: "mixed", quote: "The empty input always works", counterQuote: "", lines: [1] };
    const j = { statements: [e], other: [], contradictions: [] };
    expect(checkJudge(["k1"], j, doc)).toContain("k1: mixed without opposite quote");
    e.counterQuote = "That earlier statement was wrong";
    expect(checkJudge(["k1"], j, doc)).toEqual([]);
    expect(checkJudge(["k1"], { statements: [], other: [], contradictions: [] }, doc)).toContain("missing k1");
  });
  it("reference labels separate axes; unknowns, duplicates and missing IDs cannot silently pass", () => {
    const e = { id: "k1", support: "supported", relevance: "requested_context", salience: "context", supportBasis: "record", scopeBasis: "task requests checks", equivalentTo: [] };
    expect(validateReferences(["k1"], { items: [e] })).toEqual([]);
    expect(validateReferences(["k1", "k2"], { items: [e, e] })).toEqual(["duplicate k1", "missing k2"]);
  });
});

describe("repaired input neutralization (first-attempt failure patterns)", () => {
  const origin = { P1: "doc-A", P2: "doc-B", S: "doc-A", E: "doc-B" };
  it("keeps shell variables, assignments, commands and other words; aliases only identity tokens", () => {
    const raw = 'S=/tmp/x; cd "$S" && ls $S/out ${S}/y; cat results/quality-validation/dev-r1/S/probe.txt E/notes.md; see S:c12 and P2:c3 in P1.md; Category S: none; README/x; E: assert; qv-dev-r1-S/meta';
    const { text, subs } = neutralizeText(raw, origin);
    expect(text).toBe('S=/tmp/x; cd "$S" && ls $S/out ${S}/y; cat results/quality-validation/dev-r1/doc-A/probe.txt doc-B/notes.md; see doc-A:c12 and doc-B:c3 in doc-A.md; Category S: none; README/x; E: assert; run-doc-A/meta');
    expect(text).not.toMatch(/\$doc-|\$D1|\$D2/);
    expect(restore(text, subs)).toBe(raw);
    expect(new Set(subs.map(s => s.kind))).toEqual(new Set(["stage-path", "stage-ref", "packet-label", "run-dir"]));
  });
  it("treats JSON escapes as separators in serialized evidence records and keeps them valid JSON", () => {
    const raw = JSON.stringify({ command: "ls $S/out", result: "first line\nS/probe.txt\n$S/kept" });
    const { text, subs } = neutralizeText(raw, origin);
    expect(JSON.parse(text)).toEqual({ command: "ls $S/out", result: "first line\ndoc-A/probe.txt\n$S/kept" });
    expect(restore(text, subs)).toBe(raw);
  });
  it("changes an assignment's run-directory value consistently and nothing else (variable names, references, results)", () => {
    const raw = JSON.stringify({ arguments: { command: "D=/tmp/x/qv-dev-r1-S; S=$D/out; ls $D $S && cat \"$S\"/a.txt" }, result: [{ type: "text", text: "/tmp/x/qv-dev-r1-S/out/a.txt\nS=done" }] });
    const { text, subs } = neutralizeText(raw, origin);
    expect(JSON.parse(text)).toEqual({ arguments: { command: "D=/tmp/x/run-doc-A; S=$D/out; ls $D $S && cat \"$S\"/a.txt" }, result: [{ type: "text", text: "/tmp/x/run-doc-A/out/a.txt\nS=done" }] });
    expect(subs.map(s => [s.from, s.to])).toEqual([["qv-dev-r1-S", "run-doc-A"], ["qv-dev-r1-S", "run-doc-A"]]);
    // Outside the alias tokens the payload is byte-identical.
    expect(text.split("run-doc-A").join("qv-dev-r1-S")).toBe(raw);
  });
  it("detects alias tokens that already exist in source material", () => {
    expect(aliasCollisions("a doc-A b")).toEqual(["doc-A"]);
    expect(aliasCollisions("D1 defect and guide section D1")).toEqual([]);
  });
  it("maps the first attempt's namespaced schema-fix messages back to neutral ids", () => {
    expect(neutralIds("240 registered refs without an entry: D1:k1, D1:k2, D2:k5, …")).toBe("240 registered refs without an entry: k1, k2, k5, …");
    expect(neutralIds("doc-A:k3 (duplicate): doc-B:k9 is not realized (unsupported)")).toBe("k3 (duplicate): k9 is not realized (unsupported)");
    expect(checkFinal(claims, "doc-A", "T", { entries: [] }, "text").join(" ")).toMatch(/without an entry: k1, k2$/);
  });
  it("clamps only citation ranges that run past the file end, leaving labels and other files untouched", () => {
    const r = clampCitations("2de1f04:test/orchestrator/ultra.test.ts:78-152,154-276,344-522; src/x.ts:500-522", "test/orchestrator/ultra.test.ts", 521);
    expect(r.text).toBe("2de1f04:test/orchestrator/ultra.test.ts:78-152,154-276,344-521; src/x.ts:500-522");
    expect(r.changes).toEqual([{ from: "test/orchestrator/ultra.test.ts:78-152,154-276,344-522", to: "test/orchestrator/ultra.test.ts:78-152,154-276,344-521" }]);
    expect(clampCitations("ultra.test.ts:1-20", "test/orchestrator/ultra.test.ts", 521).changes).toEqual([]);
    const bare = clampCitations("x; ultra.test.ts:344-369,503-522; test/extension/strong-ultra.test.ts:500-530", "test/orchestrator/ultra.test.ts", 521);
    expect(bare.text).toBe("x; ultra.test.ts:344-369,503-521; test/extension/strong-ultra.test.ts:500-530");
  });
  it.skipIf(!existsSync(join(QV, "dev-r1/seed.json")))("neutralizes every real unit exactly reversibly from the retained substitutions, with valid evidence JSON and no shell-variable aliases", () => {
    for (const unit of ["dev-r1", "isort-r1", "isort-r2"]) {
      const p = neutral(unit), raw = rawUnit(unit); // neutral() throws on collisions or a non-exact round trip
      for (const [name, body] of Object.entries(p.files)) expect(body, `${unit}/${name}`).not.toMatch(/\$\{?doc-[AB]|\$\{?D[12]\b/);
      expect(Object.keys(p.files).sort()).toEqual(["claims.json", "claims.md", "doc-A-evidence.jsonl", "doc-A.md", "doc-B-evidence.jsonl", "doc-B.md", "evidence-index.json", "guide.md", "task.md"]);
      for (const name of ["doc-A.md", "doc-B.md", "doc-A-evidence.jsonl", "doc-B-evidence.jsonl"]) expect(restore(p.files[name]!, p.key.exact.files[name] ?? []), `${unit}/${name}`).toBe(raw.files[name]);
      expect(p.files["task.md"]).toBe(raw.files["task.md"]);
      expect(neutralizeText(raw.files["task.md"]!, raw.origin).subs).toEqual([]);
    }
  });
});

describe("pinned model identity for every staged turn", () => {
  const mutated = { models: [{ id: "bts/gpt-6-astra" }, { id: "bts/claude-opus-5-5" }], fastModelIds: ["bts/gpt-6-astra"] };
  const full = { models: [{ id: "bts/gpt-6-astra" }, { id: "gpt-6-astra" }, { id: "claude-opus-5-5" }, { id: "gpt-6.1-sol" }], fastModelIds: ["gpt-6-astra", "bts/gpt-6-astra"] };
  it("keeps exactly the pinned ids and fails closed when the exact id is absent (the observed alias-only list)", () => {
    expect(catalogueIds(filterCatalogue(full)).sort()).toEqual(["claude-opus-5-5", "gpt-6-astra"]);
    expect(filterCatalogue(full).fastModelIds).toEqual(["gpt-6-astra"]);
    expect(() => filterCatalogue(mutated)).toThrow(/gpt-6-astra missing/);
  });
  it("re-pins a session's agent catalogue even after the live/session cache changed to aliases only", async () => {
    const study = await temp(); setStudy(study);
    await mkdir(join(study, "pinned"), { recursive: true });
    await writeFile(join(study, "pinned", "cliproxyapi-models.json"), JSON.stringify(filterCatalogue(full)));
    await writeFile(join(study, "pinned", "models.json"), "{}");
    const agent = join(study, "agent"); await mkdir(agent);
    await writeFile(join(agent, "cliproxyapi-models.json"), JSON.stringify(mutated));
    await pinAgent(agent);
    expect(catalogueIds(JSON.parse(readFileSync(join(agent, "cliproxyapi-models.json"), "utf8"))).sort()).toEqual(["claude-opus-5-5", "gpt-6-astra"]);
  });
  it("serves the pinned catalogue, forwards only the pinned model byte-for-byte and refuses any other model before upstream", async () => {
    const seen: string[] = [];
    const upstream = createServer((req, res) => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => { seen.push(`${req.method} ${req.url} ${b}`); res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: ok\n\n"); }); });
    await new Promise<void>(r => upstream.listen(0, "127.0.0.1", () => r()));
    const dir = await temp(), log = join(dir, "guard.jsonl");
    const { server, port } = await startGuard({ target: `http://127.0.0.1:${(upstream.address() as any).port}`, log, model: "gpt-6-astra", modelsBody: JSON.stringify(filterCatalogue(full)) });
    try {
      const listed = await (await fetch(`http://127.0.0.1:${port}/v1/models?client_version=pi`)).json();
      expect(catalogueIds(listed).sort()).toEqual(["claude-opus-5-5", "gpt-6-astra"]);
      const refused = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", body: JSON.stringify({ model: "bts/gpt-6-astra", input: [] }) });
      expect(refused.status).toBe(409);
      const unreadable = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", body: "not json" });
      expect(unreadable.status).toBe(409);
      expect(seen).toEqual([]);
      const body = JSON.stringify({ model: "gpt-6-astra", reasoning: { effort: "max" } });
      const ok = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", body });
      expect(ok.status).toBe(200); expect(await ok.text()).toBe("data: ok\n\n");
      expect(seen).toEqual([`POST /backend-api/codex/responses ${body}`]);
      expect(guardStats(log)).toMatchObject({ models: 1, forwarded: 1, refused: 2, refusedModels: ["bts/gpt-6-astra", null] });
    } finally { server.close(); upstream.close(); }
  });
  it("treats only the user-confirmed route alias as the same model, keeps the raw route, and still refuses other models before upstream", async () => {
    expect(canonicalModel("bts/gpt-6-astra")).toBe("gpt-6-astra");
    expect(canonicalModel("cliproxyapi/bts/gpt-6-astra")).toBe("cliproxyapi/gpt-6-astra");
    expect(canonicalModel("cliproxyapi/bts/claude-opus-5-5")).toBe("cliproxyapi/bts/claude-opus-5-5");
    expect(canonicalModel("cliproxyapi/gpt-6.1-sol")).toBe("cliproxyapi/gpt-6.1-sol");
    const seen: Buffer[] = [];
    const upstream = createServer((req, res) => { const parts: Buffer[] = []; req.on("data", c => parts.push(c)); req.on("end", () => { seen.push(Buffer.concat(parts)); res.writeHead(200); res.end("ok"); }); });
    await new Promise<void>(r => upstream.listen(0, "127.0.0.1", () => r()));
    const dir = await temp(), log = join(dir, "guard.jsonl");
    const { server, port } = await startGuard({ target: `http://127.0.0.1:${(upstream.address() as any).port}`, log, model: "gpt-6-astra", aliases: ["bts/gpt-6-astra"], modelsBody: "{}" });
    try {
      const post = (model: string) => fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", body: JSON.stringify({ model }) });
      expect((await post("bts/gpt-6-astra")).status).toBe(200);
      // Pi's Codex client compresses request bodies: the guard decodes to check identity and forwards the original bytes.
      const packed = zstdCompressSync(Buffer.from(JSON.stringify({ model: "gpt-6-astra", reasoning: { effort: "max" } })));
      expect((await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", headers: { "content-encoding": "zstd" }, body: packed })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", headers: { "content-encoding": "zstd" }, body: zstdCompressSync(Buffer.from(JSON.stringify({ model: "gpt-6.1-sol" }))) })).status).toBe(409);
      expect((await post("bts/claude-opus-5-5")).status).toBe(409);
      expect((await post("gpt-6.1-sol")).status).toBe(409);
      expect(seen.map(b => b.toString("base64"))).toEqual([Buffer.from(JSON.stringify({ model: "bts/gpt-6-astra" })).toString("base64"), packed.toString("base64")]);
      expect(guardStats(log)).toMatchObject({ forwarded: 2, routes: ["bts/gpt-6-astra", "gpt-6-astra"], refused: 3 });
    } finally { server.close(); upstream.close(); }
  });
  it("holds an upstream routing rejection of the pinned model with the identical request, and passes ordinary errors through unchanged", async () => {
    const seen: string[] = [];
    let rejections = 2;
    const upstream = createServer((req, res) => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => {
      seen.push(b);
      if (b.includes("invalid")) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid request"}'); return; }
      if (rejections-- > 0) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"unknown provider for model gpt-6-astra"}}'); return; }
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: ok\n\n"); }); });
    await new Promise<void>(r => upstream.listen(0, "127.0.0.1", () => r()));
    const dir = await temp(), log = join(dir, "guard.jsonl"), target = `http://127.0.0.1:${(upstream.address() as any).port}`;
    const { server, port } = await startGuard({ target, log, model: "gpt-6-astra", modelsBody: "{}", holdMs: 1_000, stepMs: 20 });
    try {
      const body = JSON.stringify({ model: "gpt-6-astra", input: ["x"] });
      const held = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", body });
      expect(held.status).toBe(200); expect(await held.text()).toBe("data: ok\n\n");
      expect(seen).toEqual([body, body, body]);
      expect(guardStats(log)).toMatchObject({ forwarded: 3, routingRejections: 2, routingConverted503: 0 });
      const invalid = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", input: ["invalid"] }) });
      expect(invalid.status).toBe(400); expect(await invalid.text()).toBe('{"error":"invalid request"}');
    } finally { server.close(); }
    // A short capacity outage (the retry's 14:40Z 503 auth_unavailable class) is held and resent; other 503s pass through unchanged.
    expect(holdable(503, "auth_unavailable: no auth available (providers=codex, model=gpt-6-astra; last upstream error: service_unavailable: The server is overloaded or not ready yet.)")).toBe(true);
    expect(holdable(503, "maintenance")).toBe(false);
    expect(holdable(400, "invalid request")).toBe(false);
    // A persisting routing outage ends as a retryable 503 (Pi's ordinary transient-error retry), never as a silent alias.
    rejections = 1_000;
    const log2 = join(dir, "guard2.jsonl");
    const second = await startGuard({ target, log: log2, model: "gpt-6-astra", modelsBody: "{}", holdMs: 100, stepMs: 30 });
    try {
      const out = await fetch(`http://127.0.0.1:${second.port}/backend-api/codex/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-6-astra" }) });
      expect(out.status).toBe(503); expect(await out.text()).toMatch(/service temporarily unavailable.*unknown provider for model gpt-6-astra/);
      expect(guardStats(log2).routingConverted503).toBe(1);
    } finally { second.server.close(); upstream.close(); }
  });
});

describe("isolation and append-only resume", () => {
  it("hides host /tmp and mounts inputs read-only", () => {
    const args = safeSandbox({ agent: "/agent", target: "/target", runtime: "/runtime", provider: "/provider", scratch: "/scratch" });
    const tmp = args.findIndex((s, i) => s === "--tmpfs" && args[i + 1] === "/tmp");
    expect(tmp).toBeGreaterThan(0); expect(tmp).toBeLessThan(args.indexOf("/scratch"));
    expect(args.slice(-3)).toEqual(["--ro-bind", "/scratch/input", "/tmp/pi-orche/input"]);
  });
  it("distinguishes never-started from interrupted attempts and validates completed outputs before reuse", async () => {
    const d = await temp(); expect(stateOf(d)).toBe("fresh");
    await writeFile(join(d, "meta.json"), JSON.stringify({ queuedAt: "x" })); expect(stateOf(d)).toBe("queued");
    await writeFile(join(d, "meta.json"), JSON.stringify({ startedAt: "x" })); expect(stateOf(d)).toBe("interrupted");
    await mkdir(join(d, "outputs")); await writeFile(join(d, "outputs", "a.md"), "done");
    const t = { dir: d, promptSha256: sha("p"), inputHashes: { a: sha("b") }, sourceHashes: sourceHashes(), outputHashes: { "a.md": sha("done") } } as unknown as Turn;
    expect(() => verifyCached(t, "p", { a: "b" })).not.toThrow();
    expect(() => verifyCached(t, "other", { a: "b" })).toThrow(/prompt/);
    await writeFile(join(d, "outputs", "a.md"), "corrupted");
    expect(() => verifyCached(t, "p", { a: "b" })).toThrow(/changed/);
  });
  it("freezing never overwrites an existing different output", async () => {
    const d = await temp(); await freeze(d, { "final.md": "one" }, {});
    await expect(freeze(d, { "final.md": "two" }, {})).rejects.toThrow(/mismatch/);
    expect(readFileSync(join(d, "final.md"), "utf8")).toBe("one");
  });
  it.skipIf(!existsSync(join(ROOT, "inputs-frozen.json")))("all measured packets omit keys/gold/BASE mapping and preserve every claim", () => {
    for (const unit of ["dev-r1", "isort-r1", "isort-r2"]) {
      const p = packet(unit), c = claimsOf(unit), k = keyOf(unit);
      expect(Object.keys(p).sort()).toEqual(["claims.json", "claims.md", "doc-A-evidence.jsonl", "doc-A.md", "doc-B-evidence.jsonl", "doc-B.md", "evidence-index.json", "guide.md", "task.md"]);
      expect(c.length).toBe(Object.keys(k.byK).length);
      expect(c.every(x => !("origin" in x))).toBe(true);
    }
    expect(JSON.stringify(prompts)).not.toMatch(/q45|q107|Y102|Y103|known.loss|eval-c1|\bD1\.md|\bD2\.md/);
  });
});
