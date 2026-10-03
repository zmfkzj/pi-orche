import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { resolve } from "node:path";
import { runOrchestrated } from "./orchestration/coordinator.js";
import { applyRouteOverrides, loadRouteConfig } from "./orchestration/routing.js";
const { values } = parseArgs({ options: { cwd: { type: "string" }, problem: { type: "string" }, "problem-file": { type: "string" }, config: { type: "string", default: "orche.config.json" }, route: { type: "string", multiple: true }, events: { type: "string" } } });
if (!values.cwd || Boolean(values.problem) === Boolean(values["problem-file"])) throw new Error("Usage: --cwd <dir> (--problem <text> | --problem-file <file>) [--config file] [--route role=provider/model:thinking] [--events file]");
const problem = values.problem ?? await readFile(values["problem-file"]!, "utf8");
const routes = applyRouteOverrides(await loadRouteConfig(values.config), values.route ?? []);
const stream = values.events ? createWriteStream(values.events) : undefined;
let streamError: Error | undefined;
stream?.on("error", error => { streamError ??= error; });
try {
  const report = await runOrchestrated({ cwd: resolve(values.cwd), problem, routes, sink: event => { if (stream && !streamError && !stream.destroyed) stream.write(JSON.stringify(event) + "\n"); } });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "done") process.exitCode = 1;
} finally {
  stream?.end();
  if (stream) await finished(stream).catch(error => { streamError ??= error; });
  if (streamError) { console.error(`Events output failed: ${streamError.message}`); process.exitCode = 1; }
}
