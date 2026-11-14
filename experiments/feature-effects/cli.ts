/**
 * Run the feature-effect measurements and write JSON results (results/ is not versioned).
 *
 *   PI_SKILLCACHE_HOME=<private scratch dir> npx tsx experiments/feature-effects/cli.ts [--out DIR] [--reps 30] [--limit N]
 *     [--records ~/.pi/agent/orche/records] [--sessions ~/.pi/agent/sessions] [--skip-records]
 *
 * Reads the recorded transcripts read-only and keeps aggregates only (no prompt text or tool output). The SkillCache benchmark refuses
 * to run unless PI_SKILLCACHE_HOME is set to a directory outside the user's agent home; the user's own SkillCache directory is checked
 * to be byte-for-byte unchanged (its existence and file listing) before and after.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { aggregateCuts, replayTranscript, runScenarios, summaryNoteDelta, type CutMetrics } from "./decision-memory.js";
import { assertScratchHome, isWorkerTranscript, listJsonl, loadProvider, runBench, runNegatives, workload } from "./skillcache.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(flag("--out") ?? join("results", "feature-effects", stamp));
const reps = Number(flag("--reps") ?? 30);
const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
const recordsDir = flag("--records") ?? join(homedir(), ".pi", "agent", "orche", "records");
const sessionsDir = flag("--sessions") ?? join(homedir(), ".pi", "agent", "sessions");
const home = process.env.PI_SKILLCACHE_HOME;
if (!home) throw new Error("set PI_SKILLCACHE_HOME to a private scratch directory");
assertScratchHome(home);

const userCache = join(homedir(), ".pi", "agent", "skillcache");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const fingerprint = () => existsSync(userCache) ? JSON.stringify(walk(userCache).map(path => [path, statSync(path).size, statSync(path).mtimeMs])) : "absent";
const before = fingerprint();
const rev = (dir: string) => { try { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return undefined; } };
const dirty = (dir: string) => { try { return execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; } catch { return undefined; } };

mkdirSync(out, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
const started = Date.now();

// Decision memory: fixtures, the summary-prompt delta, then the replay of real worker transcripts.
const scenarios = runScenarios();
const note = summaryNoteDelta();
let replay: { files: number; cuts: number; aggregate: ReturnType<typeof aggregateCuts>; failedFiles: number } | undefined;
const workerFiles = has("--skip-records") ? [] : listJsonl(recordsDir, isWorkerTranscript).sort().slice(0, limit);
if (workerFiles.length) {
  const cuts: CutMetrics[] = [];
  let failedFiles = 0;
  for (const file of workerFiles) {
    try { cuts.push(...await replayTranscript(file)); } catch { failedFiles++; }
  }
  replay = { files: workerFiles.length, cuts: cuts.length, aggregate: aggregateCuts(cuts), failedFiles };
}
write("decision-memory.json", { scenarios, summaryNote: note, replay });

// SkillCache: the controlled benchmark and negative cases in the scratch home, then the workload ceiling.
const provider = await loadProvider();
if (!provider) throw new Error("pi-skillcache checkout not found (set ORCHE_SKILLCACHE_DIR)");
const bench = await runBench(provider, { home, repetitions: reps });
const negatives = await runNegatives(provider, { home, repetitions: reps });
const sessionFiles = has("--skip-records") ? [] : listJsonl(sessionsDir, () => true, 1).sort().slice(0, limit);
const workloads = has("--skip-records") ? undefined : {
  workerAssignments: await workload(provider, workerFiles),
  mainSessions: await workload(provider, sessionFiles),
};
write("skillcache.json", { bench, negatives, workloads });

const after = fingerprint();
write("conditions.json", {
  started: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000),
  orche: { revision: rev("."), dirtyFiles: dirty(".") }, provider: { dir: provider.dir, revision: rev(provider.dir), dirtyFiles: dirty(provider.dir) },
  node: process.version, recordsDir, sessionsDir, workerTranscripts: workerFiles.length, mainSessionFiles: sessionFiles.length, limit: limit ?? null, repetitions: reps,
  skillcacheHome: home, userSkillcacheUnchanged: before === after, userSkillcacheState: before === "absent" ? "absent" : "present",
});
if (before !== after) throw new Error(`the user's SkillCache directory changed: ${userCache}`);
console.log(`results: ${out}`);
