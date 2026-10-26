/**
 * ultra-ho commands (experiments/ultra-ho/README.md):
 *
 *   npx tsx experiments/ultra-ho/cli.ts freeze <out> <name>                       copy the CURRENT working tree's orche into <out>/rt-<name>
 *   npx tsx experiments/ultra-ho/cli.ts driver <plan.json> [--detach] [--rerun <unit>[,<unit>]]
 *   npx tsx experiments/ultra-ho/cli.ts status <out>
 *   npx tsx experiments/ultra-ho/cli.ts summarize <out>                           writes <out>/summary.{json,md}
 *   npx tsx experiments/ultra-ho/cli.ts reextract <out>                           re-derive fidelity.json / tasks.json of completed units (no model)
 *   npx tsx experiments/ultra-ho/cli.ts pick-task                                 the live-validation task rule
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detach, drive, harnessDigest, resolveOut, status } from "./driver.js";
import { freezeRuntime, pickLiveTask } from "./env.js";
import { reextract } from "./run-one.js";
import { writeSummary } from "./summarize.js";

const USAGE = "usage: cli.ts freeze <out> <name> | driver <plan.json> [--detach] [--rerun <unit>[,<unit>]] | status <out> | summarize <out> | reextract <out> | pick-task";

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flag = (name: string) => { const index = rest.indexOf(name); if (index < 0) return undefined; const value = rest[index + 1]; rest.splice(index, 2); return value; };
  switch (command) {
    case "freeze": {
      const [out, name] = rest;
      if (!out || !name) break;
      const { dir, revision } = await freezeRuntime(resolveOut(out), name);
      console.log(`frozen ${dir}: ${revision.fileCount} files, digest ${revision.digest}, HEAD ${revision.head?.slice(0, 12) ?? "unborn"}, ${revision.dirty.length} dirty path(s)${revision.sourceDiffers?.length ? `; WARNING: changed while copying: ${revision.sourceDiffers.join(", ")}` : ""}`);
      return 0;
    }
    case "driver": {
      const detached = rest.includes("--detach");
      if (detached) rest.splice(rest.indexOf("--detach"), 1);
      const rerun = flag("--rerun");
      const [plan] = rest;
      if (!plan) break;
      if (detached) {
        const { pid, output } = await detach(plan, rerun ? ["--rerun", rerun] : []);
        console.log(`driver started detached: pid ${pid}, output ${output}`);
        return 0;
      }
      const states = await drive(plan, { ...(rerun ? { rerun: rerun.split(",").filter(Boolean) } : {}) });
      return states.every(state => state.status === "completed") ? 0 : 1;
    }
    case "status": {
      const [out] = rest;
      if (!out) break;
      console.log(status(out));
      return 0;
    }
    case "summarize": {
      const [out] = rest;
      if (!out) break;
      console.log(await writeSummary(out));
      return 0;
    }
    case "reextract": {
      const [outInput] = rest;
      if (!outInput) break;
      const out = resolveOut(outInput);
      const harness = harnessDigest().digest;
      for (const name of readdirSync(out).filter(item => /^manifest-.+\.json$/.test(item)).sort()) {
        for (const unit of JSON.parse(readFileSync(join(out, name), "utf8")).units ?? []) {
          const dir = join(out, "runs", unit.id);
          if (!existsSync(join(dir, "meta.json"))) continue;
          try { const result = await reextract(dir, harness); console.log(`reextracted ${result.unit}: ${result.tasks} orche task(s), ${result.violations} route violation(s)`); }
          catch (error) { console.log(`skipped ${unit.id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
      return 0;
    }
    case "pick-task": {
      console.log(JSON.stringify(await pickLiveTask(), null, 2));
      return 0;
    }
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
