/**
 * Contamination scan of a combination-B study (README.md §checks): every absolute path that a worker's tool calls name outside its
 * own run directory (the run's temp dir with workspace/scratch, and its own records), and every such path that more than one run
 * names (a possible cross-run channel). Also flags paths into the harness, the frozen runtime, other runs' records or the hidden tests.
 *
 *   npx tsx experiments/decision-memory-b/contamination.ts <study dir> [--out file]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PATH = /(?:\/var\/tmp|\/tmp|\/home\/arthur)[^\s"'`;|)<>]*/g;

export function scan(dir: string) {
  const runs: { cell: string; outside: string[] }[] = [];
  const byPath = new Map<string, Set<string>>();
  const flagged: { cell: string; path: string; why: string }[] = [];
  const root = join(dir, "runs");
  for (const inst of readdirSync(root)) for (const arm of readdirSync(join(root, inst))) {
    const metaFile = join(root, inst, arm, "meta.json");
    if (!existsSync(metaFile)) continue;
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    const cell = `${inst}/${arm}`;
    const own = [meta.temp, meta.out].filter(Boolean) as string[];
    const outside = new Set<string>();
    for (const t of meta.transcripts ?? []) {
      for (const line of readFileSync(t.file, "utf8").split("\n")) {
        if (!line.includes('"toolCall"')) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        for (const part of entry?.message?.content ?? []) {
          if (part?.type !== "toolCall") continue;
          const text = JSON.stringify(part.arguments ?? {}).replace(/\\n/g, " ");
          for (const match of text.matchAll(PATH)) {
            const path = match[0].replace(/[.,]+$/, "");
            if (own.some(prefix => path.startsWith(prefix))) continue;
            outside.add(path);
            if (/\/frozen\/|experiments\/decision-memory|hidden\.test|stale-probe|\/runs\/p\d+\/[A-Z]+\/(meta|input)|orche\/src\//.test(path)) flagged.push({ cell, path, why: "harness, frozen runtime, grader or another run's data" });
            const other = /\/runs\/(p\d+\/[A-Z]+)\//.exec(path)?.[1];
            if (other && other !== cell) flagged.push({ cell, path, why: `another run's records (${other})` });
          }
        }
      }
    }
    for (const path of outside) { if (!byPath.has(path)) byPath.set(path, new Set()); byPath.get(path)!.add(cell); }
    runs.push({ cell, outside: [...outside].sort() });
  }
  const shared = [...byPath.entries()].filter(([, cells]) => cells.size > 1).map(([path, cells]) => ({ path, cells: [...cells].sort() }));
  return { runs: runs.filter(run => run.outside.length), shared, flagged };
}

if (process.argv[1]?.endsWith("contamination.ts")) {
  const result = scan(process.argv[2]!);
  const outIndex = process.argv.indexOf("--out");
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outIndex > 0) writeFileSync(process.argv[outIndex + 1]!, text);
  console.log(`runs naming outside paths: ${result.runs.length}; shared outside paths: ${result.shared.length}; flagged: ${result.flagged.length}`);
}
