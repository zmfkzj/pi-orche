/** The record/replay proxy of the strong-reflection bench (experiments/strong-reflection/bench/wire.ts) against a fake upstream. */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callIds, loadWire, normalize, WireProxy } from "../../experiments/strong-reflection/bench/wire.js";
import { handoff, orcheConfig, orderOf, primaryPass } from "../../experiments/strong-reflection/bench/protocol.js";
import { signTest, wilson } from "../../experiments/strong-reflection/bench/analyze.js";

const open: { close(): unknown }[] = [];
const dirs: string[] = [];
afterEach(async () => { for (const item of open.splice(0)) await item.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** Fake upstream: answers every request with an SSE stream naming its call count. */
async function upstream() {
  let calls = 0;
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { calls++; res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":${calls},"input_tokens_details":{"cached_tokens":4}}}}\n\n`); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => new Promise(resolve => server.close(resolve)) });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls: () => calls };
}
const post = async (base: string, body: unknown) => (await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).text();
const worker = (key: string, calls: string[]) => ({ prompt_cache_key: key, instructions: "You are a persistent coding worker.", model: "gpt-6-astra", reasoning: { effort: "high" }, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Intent/Purpose task" }] }, ...calls.map(id => ({ type: "function_call", call_id: id, name: "read", arguments: "{}" }))] });
const advisor = (key: string) => ({ prompt_cache_key: key, instructions: "You are a read-only advisor of a coding agent (the worker).", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "plan" }] }] });

describe("strong-reflection bench wire proxy", () => {
  it("records, then replays the prefix before the reflection point and goes live from the top worker's request C", async () => {
    const up = await upstream();
    const dir = await mkdtemp(join(tmpdir(), "srb-test-")); dirs.push(dir);
    const recordFile = join(dir, "o.jsonl");
    const captured: number[] = [];
    const record = new WireProxy({ mode: "record", upstream: up.url, wireFile: recordFile, onCheckpointRequest: (_request, ordinal) => captured.push(ordinal) });
    const base = await record.listen(); open.push(record);
    await post(base, worker("w-1", []));
    await post(base, advisor("a-1"));
    await post(base, worker("w-1", ["c1"]));
    record.markCheckpoint("integrate", "N3");
    await post(base, worker("w-1", ["c1", "c2"]));
    await post(base, advisor("a-1"));
    expect(record.checkpoint).toMatchObject({ kind: "integrate", node: "N3", ordinal: 2, seq: 3 });
    expect(captured).toEqual([2]);
    expect(up.calls()).toBe(5);
    const recording = loadWire(recordFile);
    expect(recording.map(entry => [entry.ordinal, entry.top, entry.mode])).toEqual([[0, true, "live"], [0, false, "live"], [1, true, "live"], [2, true, "live"], [1, false, "live"]]);
    expect(recording[0]!.usage).toEqual({ input: 10, cached: 4, output: 1, reasoning: 0 });

    const replayFile = join(dir, "r.jsonl");
    const switched: number[] = [];
    const replay = new WireProxy({ mode: "replay", upstream: up.url, wireFile: replayFile, recording, checkpoint: record.checkpoint, speed: 0, onCheckpointRequest: (_request, ordinal) => switched.push(ordinal) });
    const rbase = await replay.listen(); open.push(replay);
    expect(await post(rbase, worker("w-2", []))).toContain('"output_tokens":1');
    await post(rbase, advisor("a-2"));
    await post(rbase, worker("w-2", ["c1"]));
    expect(up.calls()).toBe(5);
    await post(rbase, worker("w-2", ["c1", "c2"]));
    expect(up.calls()).toBe(6);
    expect(switched).toEqual([2]);
    await post(rbase, advisor("a-2"));
    expect(up.calls()).toBe(7);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(loadWire(replayFile).map(entry => entry.mode).sort()).toEqual(["live", "live", "replay", "replay", "replay"]);
    expect(replay.events.some(event => event.type === "map" && event.detail.includes("signature"))).toBe(true);
    expect(replay.events.filter(event => event.type === "divergence")).toEqual([]);
  });

  it("a replayed request whose call ids differ from the recording is a divergence and goes live", async () => {
    const up = await upstream();
    const dir = await mkdtemp(join(tmpdir(), "srb-test-")); dirs.push(dir);
    const record = new WireProxy({ mode: "record", upstream: up.url, wireFile: join(dir, "o.jsonl") });
    const base = await record.listen(); open.push(record);
    await post(base, worker("w", []));
    await post(base, worker("w", ["c1"]));
    record.markCheckpoint("report");
    const replay = new WireProxy({ mode: "replay", upstream: up.url, wireFile: join(dir, "r.jsonl"), recording: loadWire(join(dir, "o.jsonl")), checkpoint: record.checkpoint, speed: 0 });
    const rbase = await replay.listen(); open.push(replay);
    await post(rbase, worker("w2", []));
    await post(rbase, worker("w2", ["other"]));
    expect(up.calls()).toBe(3);
    expect(replay.events.find(event => event.type === "divergence")?.detail).toContain("TOP");
  });

  it("helpers: call ids, normalization, protocol", () => {
    expect(callIds(worker("k", ["a", "b"]))).toEqual(["a", "b"]);
    expect(normalize("x 2026-10-19T06-27-28-781Z_task-71f3874a 1792392402972 bash-mvevsr46-dc8eb3.txt")).toBe("x <time>_task-<id> <ms> bash-<artifact>.txt");
    expect(orcheConfig("R0", "/r").single).toEqual({ advisor: true, maxSubWorkers: 8 });
    expect(orcheConfig("R1", "/r").single).toEqual({ advisor: true, maxSubWorkers: 8, strongReflection: true });
    expect((orcheConfig("O", "/r").models as any)["strong-orchestrator"]).toEqual({ model: "cliproxyapi/gpt-6-astra", thinking: "high" });
    expect(new Set(["a-r1", "a-r2", "b-r1", "b-r2", "c-r1", "c-r2"].map(unit => orderOf(unit)[0])).size).toBe(2);
    expect(primaryPass({ terminal: "done", gradePassed: true, violations: 0 })).toBe(true);
    expect(primaryPass({ terminal: "done", gradePassed: true, violations: 1 })).toBe(false);
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(5, 0)).toBeCloseTo(0.0625, 6);
    expect(signTest(3, 1)).toBeCloseTo(0.625, 6);
    const [low, high] = wilson(9, 16);
    expect(low).toBeCloseTo(0.334, 2); expect(high).toBeCloseTo(0.768, 2);
    expect((orcheConfig("R1", "/r") as any).bashReview).toEqual({ enabled: false });
    expect(handoff({ id: "x", kind: "swe", title: "T", instruction: "Issue text" })).toMatch(/^Intent\/Purpose\n[\s\S]*R1: [\s\S]*Original request\nIssue text$/);
  });
});
