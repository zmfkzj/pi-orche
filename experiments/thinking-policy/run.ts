/**
 * Run the thinking-policy comparison (bench.ts) and write the results:
 *   npx tsx experiments/thinking-policy/run.ts [repeat]
 * → results/thinking-policy/bench-<date>.json and .md (gitignored; no paid model calls: a deterministic scripted faux model).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ARMS, formatMatrix, runMatrix, SCENARIOS } from "./bench.js";

const repeat = Number(process.argv[2] ?? 2);
const started = Date.now();
const results = await runMatrix({ repeat });
const first = results.slice(0, results.length / repeat);
const stable = first.every((result, index) => results.filter((_, i) => i % first.length === index).every(other =>
  other.correct === result.correct && other.requests === result.requests && other.lengthStops === result.lengthStops && other.efforts.join() === result.efforts.join()));
const date = new Date().toISOString().slice(0, 10);
const dir = join(import.meta.dirname, "../../results/thinking-policy");
await mkdir(dir, { recursive: true });
const piVersion = (JSON.parse(await readFile(join(import.meta.dirname, "../../node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")) as { version: string }).version;
let commit = "unknown";
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain"], { cwd: import.meta.dirname, encoding: "utf8" }).trim() ? " + uncommitted changes" : ""); } catch { /* not a git checkout */ }
const meta = { date, repeat, commit, piCodingAgent: piVersion, stableAcrossRepeats: stable, durationMs: Date.now() - started, arms: ARMS, scenarios: SCENARIOS, node: process.version };
await writeFile(join(dir, `bench-${date}.json`), `${JSON.stringify({ meta, results }, null, 1)}\n`);
const markdown = `# Thinking-policy comparison ${date}\n\nThe real orche_task stack (WorkerPool → AgentManager → Pi AgentSession, task_plan, report rewrite at B, output-limit recovery) with a deterministic scripted faux model; baseline B = high, step S = medium; ${repeat} repeats, stable across repeats: ${stable}; orche ${commit}, pi-coding-agent ${piVersion}. **The scenario behaviours are assumptions written into the script (bench.ts SCENARIOS): this shows whether each arm's mechanics work, not answer quality, how often a real model behaves like this, real tokens or latency.**\n\n${formatMatrix(first)}\n`;
await writeFile(join(dir, `bench-${date}.md`), markdown);
console.log(markdown);
