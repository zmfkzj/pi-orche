/**
 * Bounded real-model trial of `single.strongReflection` (src/single/reflection.ts, docs/strong-reflection.md): one strong-mode
 * implement assignment through orche's real WorkerPool on a small fixture whose hand-off context carries a plausible false premise
 * (it says the parser only accepts unit-suffixed strings; the code and README also accept bare numbers and JSON numbers as seconds).
 * The two arms differ only in `single.strongReflection` (off / on): same fixture, request, model, effort, limits and config otherwise.
 * One process per cell (the private agent dir is PI_CODING_AGENT_DIR); outputs go to results/ (gitignored). The overlay holds copies of
 * ~/.pi/agent/{auth,models,cliproxyapi,cliproxyapi-models}.json and npm/node_modules/@router-for-me/pi-cliproxyapi-provider (a link to
 * the installed provider package; the harness writes the overlay's orche.config.json). Unset PI_SESSION_FILE, PI_MODEL and PI_PROVIDER first.
 *
 *   PI_CODING_AGENT_DIR=<overlay> node --import tsx experiments/strong-reflection/trial.ts <out> <off|on> [model] [thinking]
 *
 * Result: <out>/meta.json (status, grade, reflection, requests/usage, the worker's tool calls after the prompt), the transcript
 * under <out>/records. A cell is one observation: it shows what the model did with the prompt, never that the prompt helps in general.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "../..");
const [outArg, arm, modelArg = "cliproxyapi/gpt-6-astra", thinking = "high"] = process.argv.slice(2);
if (!outArg || (arm !== "on" && arm !== "off")) throw new Error("usage: trial.ts <out> <off|on> [provider/model] [thinking]");
const out = resolve(outArg);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("PI_CODING_AGENT_DIR must be the cell's private agent dir");

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "durations", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# durations\n\n`parseDuration(value)` turns a duration from a config file into milliseconds.\n\n- `\"90s\"` → 90000, `\"5m\"` → 300000\n- A bare number is seconds, for v1 config files: `\"120\"` → 120000, and a JSON number `30` → 30000\n- Surrounding whitespace is ignored: `\" 5m \"` → 300000\n- Anything else throws an `Error` whose message starts with `invalid duration`.\n",
  "src/duration.js": [
    "const UNITS = { s: 1000, m: 60_000 };",
    "",
    "/** Milliseconds of a config-file duration (see README). */",
    "export function parseDuration(value) {",
    "  if (typeof value === \"number\" && Number.isFinite(value) && value >= 0) return value * 1000;",
    "  const text = String(value).trim();",
    "  const match = /^(\\d+)([sm])$/.exec(text);",
    "  if (match) return Number(match[1]) * UNITS[match[2]];",
    "  if (/^\\d+$/.test(text)) return Number(text) * 1000;",
    "  throw new Error(`invalid duration: ${value}`);",
    "}",
    "",
  ].join("\n"),
  "test/duration.test.js": [
    "import { test } from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { parseDuration } from \"../src/duration.js\";",
    "",
    "test(\"seconds and minutes\", () => {",
    "  assert.equal(parseDuration(\"90s\"), 90_000);",
    "  assert.equal(parseDuration(\"5m\"), 300_000);",
    "});",
    "",
    "test(\"invalid input throws\", () => {",
    "  assert.throws(() => parseDuration(\"abc\"), /invalid duration/);",
    "});",
    "",
  ].join("\n"),
};

const REQUEST = [
  "Intent/Purpose: config files need hour durations and combined durations.",
  "Requirements:",
  "R1: parseDuration accepts hours: \"2h\" returns 7200000.",
  "R2: parseDuration accepts combined forms in descending unit order: \"1h30m\" returns 5400000 and \"1m30s\" returns 90000.",
  "R3: Existing behaviour is preserved.",
  "R4: Tests cover the new forms and `npm test` passes.",
  "Constraints and non-goals: no new dependencies; no commits.",
  "Assumptions: units are lower-case h, m, s.",
  "Original request",
  "duration 파서에 시간 단위(h)와 '1h30m' 같은 조합 형식을 추가해줘. 기존 동작은 깨지면 안 돼.",
].join("\n");
// The hand-off's plausible false premise (the code and README say otherwise).
const CONTEXT = "Main's note: parseDuration currently accepts only strings with a unit suffix (s or m); the parser is src/duration.js and its tests are test/duration.test.js.";

/** Hidden acceptance cases (never shown to the worker). */
const CASES: [unknown, number | "throws"][] = [
  ["2h", 7_200_000], ["1h30m", 5_400_000], ["1m30s", 90_000], ["90s", 90_000], ["5m", 300_000],
  ["120", 120_000], [30, 30_000], [" 5m ", 300_000], ["abc", "throws"], ["", "throws"],
];

async function grade(workspace: string) {
  const results: { input: unknown; expected: unknown; actual: unknown; pass: boolean }[] = [];
  try {
    const { parseDuration } = await import(`${pathToFileURL(join(workspace, "src/duration.js")).href}?t=${Date.now()}`);
    for (const [input, expected] of CASES) {
      let actual: unknown;
      try { actual = parseDuration(input); } catch (error) { actual = `throws ${error instanceof Error ? error.message : String(error)}`; }
      const pass = expected === "throws" ? typeof actual === "string" && /^throws invalid duration/.test(actual) : actual === expected;
      results.push({ input, expected, actual, pass });
    }
  } catch (error) { results.push({ input: "import", expected: "module", actual: String(error), pass: false }); }
  let npmTest = "";
  try { npmTest = execFileSync("npm", ["test", "--silent"], { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).slice(-400); npmTest = `pass ${npmTest.match(/# pass \d+/)?.[0] ?? ""}`; }
  catch (error) { npmTest = `fail ${String((error as { stdout?: string }).stdout ?? error).slice(-400)}`; }
  return { passed: results.filter(item => item.pass).length, total: results.length, failed: results.filter(item => !item.pass), npmTest };
}

/** Tool calls of the worker transcript, in order, with where the reflection prompt arrived. */
function transcript(file: string) {
  const calls: { index: number; name: string; args: string }[] = [];
  let reflectionAt: number | undefined;
  let assistant = 0;
  const usage = { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (message.role === "assistant") {
      assistant++;
      usage.requests++;
      usage.input += message.usage?.input ?? 0; usage.output += message.usage?.output ?? 0; usage.cacheRead += message.usage?.cacheRead ?? 0; usage.cost += message.usage?.cost?.total ?? 0;
      for (const part of message.content ?? []) if (part.type === "toolCall") calls.push({ index: assistant, name: part.name, args: JSON.stringify(part.arguments).slice(0, 300) });
    }
    if (message.role === "toolResult" && reflectionAt === undefined && JSON.stringify(message.content).includes("지금까지의 대화를 한 걸음 떨어져 바라보라.")) reflectionAt = assistant;
  }
  return { usage, reflectionAt, calls, afterReflection: reflectionAt === undefined ? [] : calls.filter(call => call.index > reflectionAt!) };
}

const jsonl = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? jsonl(join(dir, entry.name)) : entry.name.endsWith(".jsonl") && entry.name !== "events.jsonl" ? [join(dir, entry.name)] : []);

async function main() {
  await mkdir(out, { recursive: true });
  const workspace = join(out, "workspace");
  for (const [path, text] of Object.entries(FILES)) { await mkdir(join(workspace, path, ".."), { recursive: true }); await writeFile(join(workspace, path), text); }
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=trial", "-c", "user.email=trial@example.invalid", ...args], { cwd: workspace, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "fixture");
  const config = {
    mainMode: "strong",
    providerExtensions: ["npm:@router-for-me/pi-cliproxyapi-provider"],
    default: { model: modelArg, thinking },
    models: { "strong-orchestrator": { model: modelArg, thinking } },
    routes: {},
    limits: { overallMs: 20 * 60_000, assignmentMs: 20 * 60_000, maxExtensions: 0 },
    records: { enabled: true, dir: join(out, "records") },
    single: { ledger: false, spawn: false, advisor: false, ...(arm === "on" ? { strongReflection: true } : {}) },
    thinkingPolicy: "fixed",
    concurrentSessions: { enabled: false },
  };
  await writeFile(join(agentDir!, "orche.config.json"), JSON.stringify(config, null, 2));
  const { OrcheController } = await import(pathToFileURL(join(REPO, "src/extension/controller.ts")).href);
  const { WorkerPool, TaskFailedError } = await import(pathToFileURL(join(REPO, "src/extension/workers.ts")).href);
  const pool = new WorkerPool({ controller: new OrcheController({ agentDir }), agentDir, scratchBase: join(out, "scratch") });
  const started = Date.now();
  const meta: any = { arm, model: modelArg, thinking, config, request: REQUEST, context: CONTEXT, startedAt: started };
  try {
    const result = await pool.execute({ role: "implement", request: REQUEST, context: CONTEXT, cwd: workspace, projectTrusted: false, mainMode: "strong", thinking, currentSession: { id: `strong-reflection-${arm}` } });
    meta.status = result.details.status; meta.reflection = result.details.reflection; meta.requests = result.details.requests; meta.plan = result.details.plan; meta.checklist = result.details.checklist; meta.text = result.text;
  } catch (error) {
    meta.status = "failed"; meta.error = String(error instanceof Error ? error.message : error).slice(0, 3000);
    if (error instanceof TaskFailedError) meta.details = { reflection: (error as any).details?.reflection, requests: (error as any).details?.requests };
  } finally { await pool.dispose(); }
  meta.durationMs = Date.now() - started;
  meta.grade = await grade(workspace);
  meta.diff = execFileSync("git", ["diff", "--stat"], { cwd: workspace, encoding: "utf8" });
  const files = jsonl(join(out, "records")).filter(file => !file.includes(".advisor"));
  meta.transcripts = files.map(file => ({ file, ...transcript(file) }));
  await writeFile(join(out, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify({ arm, status: meta.status, grade: `${meta.grade.passed}/${meta.grade.total}`, npmTest: meta.grade.npmTest.slice(0, 20), reflection: meta.reflection, requests: meta.requests, durationMs: meta.durationMs }));
}
await main();
