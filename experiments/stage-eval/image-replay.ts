/**
 * Offline replay of the request-time image budget (src/pi/image-context.ts, change #2) on real orche worker transcripts with GUI
 * screenshots (no model call). For every assistant message of a transcript the request context is rebuilt (the messages before
 * it since the last compaction), projected with each policy, and compared with the previous request of the same policy:
 * - kept images per request (visual context available to the model);
 * - the longest common message prefix with the previous projected request; tokens after it are the part a prefix cache cannot
 *   serve (an optimistic cache model: everything the previous request sent is assumed cached);
 * - "breaks": requests whose change starts before the previous request's end (an earlier part of the prompt was rewritten).
 * Token estimates: text = serialized characters / 4, image = pixels / 750 after scaling to at most 1.15 MP (Anthropic's rule of
 * thumb). The measured usage recorded in the transcript (the policy that actually ran then, the rolling window) is reported next
 * to the simulated rolling policy as a check of the cache model.
 *
 *   npx tsx experiments/stage-eval/image-replay.ts <out.json> <transcript.jsonl> [...]   (or --sample <n> <seed> <records dir>)
 */
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { projectImageContext, type ImageContextLimits } from "../../src/pi/image-context.js";
import { rng, shuffle } from "./protocol.js";

/** Content blocks before a cache breakpoint that an Anthropic-style automatic prefix check examines. */
export const LOOKBACK_BLOCKS = 20;

export const POLICIES: Record<string, ImageContextLimits> = {
  "rolling-8": { maxImages: 8, maxBase64Bytes: 8 * 1024 * 1024 },
  "batch-8-6": { maxImages: 8, maxBase64Bytes: 8 * 1024 * 1024, keepImages: 6, keepBase64Bytes: 6 * 1024 * 1024 },
  "batch-8-4": { maxImages: 8, maxBase64Bytes: 8 * 1024 * 1024, keepImages: 4, keepBase64Bytes: 4 * 1024 * 1024 },
  "batch-8-2": { maxImages: 8, maxBase64Bytes: 8 * 1024 * 1024, keepImages: 2, keepBase64Bytes: 2 * 1024 * 1024 },
};

/** Pixel size of a base64 PNG or JPEG (undefined when unknown). */
export function imageSize(data: string): { width: number; height: number } | undefined {
  const head = Buffer.from(data.slice(0, 40_000), "base64");
  if (head.length > 24 && head.readUInt32BE(0) === 0x89504e47) return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  if (head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) { offset++; continue; }
      const marker = head[offset + 1]!;
      const length = head.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
  }
  return undefined;
}
export function imageTokens(data: string): number {
  const size = imageSize(data);
  if (!size) return 1_500;
  return Math.round(Math.min(size.width * size.height, 1_150_000) / 750);
}

const tokenCache = new WeakMap<object, { hash: string; tokens: number }>();
function measure(message: any): { hash: string; tokens: number } {
  const cached = tokenCache.get(message);
  if (cached) return cached;
  let tokens = 0;
  const text = JSON.stringify(message, (key, value) => {
    if (value && typeof value === "object" && value.type === "image" && typeof value.data === "string") { tokens += imageTokens(value.data); return { type: "image", sha: createHash("sha1").update(value.data).digest("hex") }; }
    return value;
  });
  tokens += Math.ceil(text.length / 4);
  const result = { hash: createHash("sha1").update(text).digest("hex"), tokens };
  tokenCache.set(message, result);
  return result;
}

export interface PolicyStats { requests: number; totalTokens: number; uncachedTokens: number; uncachedLookback: number; breaks: number; keptMin: number; keptSum: number; keptRequests: number; overflowRequests: number; omittedRequests: number }
const emptyStats = (): PolicyStats => ({ requests: 0, totalTokens: 0, uncachedTokens: 0, uncachedLookback: 0, breaks: 0, keptMin: Infinity, keptSum: 0, keptRequests: 0, overflowRequests: 0, omittedRequests: 0 });

export interface ReplayResult { file: string; requests: number; images: number; compactions: number; measured: { requests: number; input: number; cacheRead: number }; policies: Record<string, PolicyStats> }

/** Replay one transcript's message list (already parsed) under every policy. */
export function replayMessages(segments: any[][], measuredUsage: { input: number; cacheRead: number }[], policies = POLICIES): Omit<ReplayResult, "file" | "compactions"> {
  const stats: Record<string, PolicyStats> = Object.fromEntries(Object.keys(policies).map(name => [name, emptyStats()]));
  let requests = 0, images = 0;
  for (const segment of segments) {
    const previous: Record<string, { hashes: string[]; blocks: number[] } | undefined> = {};
    for (let i = 0; i < segment.length; i++) {
      const message = segment[i];
      if (message.role === "toolResult") images += (message.content ?? []).filter((block: any) => block?.type === "image").length;
      if (message.role !== "assistant") continue;
      requests++;
      const context = segment.slice(0, i);
      const rawImages = context.reduce((sum: number, m: any) => sum + (m.role === "toolResult" ? (m.content ?? []).filter((b: any) => b?.type === "image").length : 0), 0);
      for (const [name, limits] of Object.entries(policies)) {
        const projected = projectImageContext(context as never, limits) as any[];
        const measures = projected.map(measure);
        const hashes = measures.map(item => item.hash);
        const blocks = projected.map(m => Array.isArray(m.content) ? Math.max(1, m.content.length) : 1);
        const total = measures.reduce((sum, item) => sum + item.tokens, 0);
        const before = previous[name]?.hashes ?? [];
        let common = 0;
        while (common < before.length && common < hashes.length && before[common] === hashes[common]) common++;
        const s = stats[name]!;
        s.requests++;
        s.totalTokens += total;
        const tail = measures.slice(common).reduce((sum, item) => sum + item.tokens, 0);
        s.uncachedTokens += tail;
        // Lookback model (Anthropic-style automatic prefix check): a cache entry written at the end of the previous request is
        // found only when the first changed block lies within LOOKBACK_BLOCKS content blocks of that end; otherwise nothing is cached.
        const changedBlocks = (previous[name]?.blocks ?? []).slice(common).reduce((sum, n) => sum + n, 0);
        s.uncachedLookback += !before.length || changedBlocks <= LOOKBACK_BLOCKS ? tail : total;
        if (before.length && common < before.length) s.breaks++;
        const kept = projected.reduce((sum, m) => sum + (m.role === "toolResult" ? (m.content ?? []).filter((b: any) => b?.type === "image").length : 0), 0);
        if (rawImages > 8) { s.overflowRequests++; s.keptMin = Math.min(s.keptMin, kept); s.keptSum += kept; s.keptRequests++; }
        if (kept < rawImages) s.omittedRequests++;
        previous[name] = { hashes, blocks };
      }
    }
  }
  const measured = measuredUsage.reduce((sum, item) => ({ input: sum.input + item.input, cacheRead: sum.cacheRead + item.cacheRead }), { input: 0, cacheRead: 0 });
  return { requests, images, measured: { requests: measuredUsage.length, ...measured }, policies: stats };
}

/** Linear message list of a Pi transcript, split at compaction entries (the next request after one starts a fresh segment). */
export async function readTranscript(file: string): Promise<{ segments: any[][]; usage: { input: number; cacheRead: number }[]; compactions: number }> {
  const segments: any[][] = [[]];
  const usage: { input: number; cacheRead: number }[] = [];
  let compactions = 0;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "compaction") { compactions++; segments.push([]); continue; }
    if (entry.type !== "message" || !entry.message || entry.message.role === "system") continue;
    segments.at(-1)!.push(entry.message);
    if (entry.message.role === "assistant" && entry.message.usage) usage.push({ input: entry.message.usage.input ?? 0, cacheRead: entry.message.usage.cacheRead ?? 0 });
  }
  return { segments, usage, compactions };
}

export function sampleTranscripts(root: string, count: number, seed: string, minImages = 20, minBytes = 3_000_000): string[] {
  const candidates: string[] = [];
  for (const session of readdirSync(root)) {
    let names: string[] = [];
    try { names = readdirSync(join(root, session, "workers")); } catch { continue; }
    for (const name of names) {
      if (!/^W\d+-.*\.jsonl$/.test(name)) continue;
      const file = join(root, session, "workers", name);
      if (statSync(file).size >= minBytes) candidates.push(file);
    }
  }
  void minImages;
  return shuffle(candidates.sort(), rng(seed)).slice(0, count);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const out = args.shift()!;
  const files = args[0] === "--sample" ? sampleTranscripts(args[3]!, Number(args[1]), args[2]!) : args;
  const results: ReplayResult[] = [];
  for (const file of files) {
    const { segments, usage, compactions } = await readTranscript(file);
    const images = segments.flat().reduce((sum, m) => sum + (m.role === "toolResult" ? (m.content ?? []).filter((b: any) => b?.type === "image").length : 0), 0);
    if (images < 20) continue;
    const result = { file, compactions, ...replayMessages(segments, usage) };
    results.push(result);
    console.log(JSON.stringify({ file: file.split("/").slice(-3).join("/"), requests: result.requests, images: result.images, ...Object.fromEntries(Object.entries(result.policies).map(([name, s]) => [name, { uncachedK: Math.round(s.uncachedTokens / 1000), breaks: s.breaks, keptMin: s.keptMin }])) }));
  }
  const totals: Record<string, PolicyStats> = {};
  for (const result of results) for (const [name, s] of Object.entries(result.policies)) {
    const t = totals[name] ??= emptyStats();
    for (const key of Object.keys(t) as (keyof PolicyStats)[]) t[key] = key === "keptMin" ? Math.min(t.keptMin, s.keptMin) : t[key] + s[key];
  }
  await writeFile(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), policies: POLICIES, transcripts: results.length, totals, results }, null, 2)}\n`);
  console.log(JSON.stringify(totals, null, 1));
}
