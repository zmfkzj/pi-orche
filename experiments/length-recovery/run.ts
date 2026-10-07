/**
 * Run the length-recovery benchmark matrix (bench.ts) and write the results:
 *   npx tsx experiments/length-recovery/run.ts [repeat]
 * → results/length-recovery/bench-<date>.json and .md (no paid model calls; a deterministic faux provider).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ASSUMPTIONS, formatMatrix, MODELS, runMatrix, STRATEGIES } from "./bench.js";

const repeat = Number(process.argv[2] ?? 3);
const started = Date.now();
const results = await runMatrix({ repeat });
const first = results.slice(0, results.length / repeat);
const stable = first.every((result, index) => results.filter((_, i) => i % first.length === index).every(other =>
  other.reported === result.reported && other.requests === result.requests && other.compactions === result.compactions && other.outputTokens === result.outputTokens));
const date = new Date().toISOString().slice(0, 10);
const dir = join(import.meta.dirname, "../../results/length-recovery");
await mkdir(dir, { recursive: true });
const piVersion = (JSON.parse(await readFile(join(import.meta.dirname, "../../node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")) as { version: string }).version;
let commit = "unknown";
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain"], { cwd: import.meta.dirname, encoding: "utf8" }).trim() ? " + uncommitted changes" : ""); } catch { /* not a git checkout */ }
const meta = { date, repeat, commit, piCodingAgent: piVersion, stableAcrossRepeats: stable, durationMs: Date.now() - started, strategies: STRATEGIES, models: MODELS, assumptions: ASSUMPTIONS, node: process.version };
await writeFile(join(dir, `bench-${date}.json`), `${JSON.stringify({ meta, results }, null, 1)}\n`);
const markdown = `# Length-recovery benchmark ${date}\n\nDeterministic faux provider through orche's AgentManager and Pi's AgentSession; ${repeat} repeats, stable across repeats: ${stable}; orche ${commit}, pi-coding-agent ${piVersion}. Each strategy runs the production recovery (src/pi/length-recovery.ts) with the options in STRATEGIES. Model behaviours are assumptions (bench.ts MODELS). Requests, compactions, length stops and token counts are counted in the run (tokens as the faux provider estimates them, about 4 characters per token); **est. $ and est. s are estimates** from the assumed prices and speeds in bench.ts ASSUMPTIONS, not bills or measured latency. No real model was called: this is not a measurement of real-model quality, latency or how often each behaviour occurs.\n\n${formatMatrix(first)}\n`;
await writeFile(join(dir, `bench-${date}.md`), markdown);
console.log(markdown);
