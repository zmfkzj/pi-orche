/**
 * Build a frozen candidate pool of the headroom-pool study (model-free, deterministic): the pool's source records, their exposure
 * facts (exposure.ts), the mechanical prescreen M1..M3 and the seeded order (protocol.ts). Writes results/headroom-pool/pool-<P>.json
 * once (never overwritten), with the sha256 of every source file.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { collect, factsOf, SCAN_DEPTH, SETUP_ONLY_ROOTS } from "./exposure.js";
import { exposed, ORDER_SEED, orderKey, POOLS, prescreen, selectPool, upstreamKey, type PoolEntry, type PoolName, type RawRecord } from "./protocol.js";

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

export function readSource(repo: string, file: string): RawRecord[] {
  return readFileSync(join(repo, file), "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as RawRecord);
}

export interface PoolFile {
  name: PoolName; builtAt: string; source: { dataset: string; splits: string[]; files: { path: string; sha256: string; records: number }[] };
  rules: { orderSeed: string; cap: number; scanDepth: number; setupOnlyRoots: readonly string[] };
  counts: Record<string, number>; pool: PoolEntry[]; excluded: PoolEntry[];
}

/** Compute the pool (deterministic over the repository state; no write). */
export function computePool(repo: string, name: PoolName): Omit<PoolFile, "builtAt"> {
  const source = POOLS[name];
  const files = source.files.map(path => {
    if (!existsSync(join(repo, path))) throw new Error(`pool ${name}: source file ${path} is missing`);
    return { path, sha256: sha256File(join(repo, path)), records: readSource(repo, path).length };
  });
  const records = source.files.flatMap((path, index) => readSource(repo, path).map(record => ({ record, split: source.splits[index]! })));
  const scan = collect(repo);
  // First pass without aliases; then every exposed upstream key (records, historical fixtures, iso-token runs) marks its aliases.
  const exposedKeys = new Map<string, string>();
  for (const { record } of records) if (exposed(factsOf(record.instance_id, scan))) exposedKeys.set(upstreamKey(record.instance_id), record.instance_id);
  for (const fixture of scan.historical) if (!exposedKeys.has(upstreamKey(fixture))) exposedKeys.set(upstreamKey(fixture), fixture);
  for (const run of scan.isoRuns) if (!exposedKeys.has(upstreamKey(run.task))) exposedKeys.set(upstreamKey(run.task), run.task);
  const entries: PoolEntry[] = records.map(({ record, split }) => ({
    id: record.instance_id, upstream: upstreamKey(record.instance_id), order: orderKey(record.instance_id), split, createdAt: record.created_at, repo: record.repo,
    prescreen: prescreen(record), exposure: factsOf(record.instance_id, scan, exposedKeys),
  }));
  const { pool, excluded } = selectPool(entries, source.cap);
  const counts: Record<string, number> = { records: entries.length, pool: pool.length };
  for (const entry of excluded) { const key = `excluded ${entry.excluded!.split(":")[0]!}`; counts[key] = (counts[key] ?? 0) + 1; }
  return { name, source: { dataset: source.dataset, splits: source.splits, files }, rules: { orderSeed: ORDER_SEED, cap: source.cap, scanDepth: SCAN_DEPTH, setupOnlyRoots: SETUP_ONLY_ROOTS }, counts, pool, excluded };
}

/** Write <out>/pool-<P>.json once. */
export async function writePool(repo: string, out: string, name: PoolName): Promise<PoolFile> {
  const path = join(out, `pool-${name}.json`);
  if (existsSync(path)) throw new Error(`${path} exists: a frozen pool is never overwritten`);
  const file: PoolFile = { ...computePool(repo, name), builtAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}
