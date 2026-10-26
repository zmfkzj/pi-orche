/**
 * r2 of the MDSD comparison (docs/mdsd-ab-bench.md, "r2: strategy x model matrix"): the three strategies of r1's admitted MDSD search
 * round, each run once on GPT 6.1 Sol and once on Claude Sonnet 5.5 (both at max), in ONE `/orche mdsd` run of r1's prompt on the
 * commit-free 2de1f04 snapshot. The orche config pins the run's first (and only) search round to the recovered r1 call
 * (mdsd.replication) and gives every explorer cell a private scratch directory (mdsd.explorerScratch); main, the orchestrator and its
 * verifiers stay on gpt-6.1-sol/max as in r1. The frozen runtime/provider, input prompt, sandbox, proxy and guard are run.ts's.
 *
 *   node --import tsx experiments/mdsd-ab/matrix.ts prepare <runDir>         run.ts prepare + pinned round + matrix config + admission
 *   node --import tsx experiments/mdsd-ab/matrix.ts preflight <runDir>       one direct `pi` request per model at max (route check)
 *   node --import tsx experiments/mdsd-ab/matrix.ts run <runDir> [--toy]     the matrix once (toy: two toy strategies x two models)
 *   node --import tsx experiments/mdsd-ab/matrix.ts summarize <runDir> [--toy]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMdsdConfig } from "../../src/orchestrator/mdsd-config.js";
import { MdsdRun } from "../../src/orchestrator/mdsd.js";
import {
  AGENT, AUDIT_PATTERNS, HOME, LIMITS, MDSD, NODE, PI_CLI, PROVIDER_MOUNT, REPO, RUNTIME_MOUNT, TARGET_COMMIT, THINKING, agentDir, catalogEntries,
  filesUnder, git, orcheConfig, prepare as prepareInputs, readJsonl, runGuarded, sandboxArgs, sha, startProxy, taskRuns, write,
} from "./run.js";

export const PROVIDER = "cliproxyapi";
export const MODELS = ["gpt-6.1-sol", "claude-sonnet-5-5"] as const;
export const MODEL_REFS = MODELS.map(id => `${PROVIDER}/${id}`);

// ---- the recorded r1 round --------------------------------------------------------------------------------------------------------
const R1 = join(REPO, "results/mdsd-ab/r1");
const R1_RECORDS = join(R1, "mdsd/records/mdsd-ab-mdsd");
/** r1's orchestrator transcript: line 10 is the admitted search call (line 8 the proposal refused for budget). */
export const R1_CALL = { file: join(R1_RECORDS, "workers/W1-2026-10-17T11-12-59-139Z.jsonl"), line: 10 };
/** The runtime's record of that admission (plan, strategies, allocations). */
export const R1_ADMITTED = { file: join(R1_RECORDS, "2026-10-17T11-12-59-279Z_task-22d7e0d8/events.jsonl"), line: 4 };
const R1_SCRATCH = "/tmp/pi-orche/tmp/pi-orche/mdsd-ab-mdsd/W1";
/**
 * The only edits of the recovered call: r1's scratch paths (the r1 orchestrator's directory and sub-paths of it) become "your scratch
 * directory", which the runtime names in every cell's prompt (each cell's own). Each text must occur exactly once.
 */
export const SUBSTITUTIONS = [
  { where: "plan.constraints[4]", from: `Use your scratch directory ${R1_SCRATCH} for temporary files`, to: "Use your scratch directory for temporary files" },
  { where: "workers[0].request", name: "ultra-contracts", from: `Probes under ${R1_SCRATCH}/ultra-contracts.`, to: "Probes under your scratch directory." },
  { where: "workers[1].request", name: "routing-lifecycle", from: `Temporary files only ${R1_SCRATCH}/routing-lifecycle.`, to: "Temporary files only in your scratch directory." },
  { where: "workers[2].request", name: "oneshot-host", from: `Probes only ${R1_SCRATCH}/oneshot-host.`, to: "Probes only in your scratch directory." },
] as const;

export interface PinnedWorker { name: string; role: "answer"; request: string; strategy: Record<string, any> }
export interface PinnedRound { plan: Record<string, any>; workers: PinnedWorker[] }

const lineOf = (file: string, line: number) => readFileSync(file, "utf8").split("\n")[line - 1] ?? "";
const once = (text: string, sub: { where: string; from: string; to: string }) => {
  const found = text.split(sub.from).length - 1;
  if (found !== 1) throw new Error(`${sub.where}: expected the recorded text once, found it ${found} time(s)`);
  return text.replace(sub.from, () => sub.to);
};

/** The admitted r1 search call, checked against the runtime's admission event, and its normalized copy (the pinned round). */
export function recoverRound(): { line: string; call: any; admitted: any; round: PinnedRound } {
  const line = lineOf(R1_CALL.file, R1_CALL.line);
  const calls = (JSON.parse(line)?.message?.content ?? []).filter((part: any) => part?.type === "toolCall" && part.arguments?.reason === "search");
  if (calls.length !== 1) throw new Error(`${R1_CALL.file}:${R1_CALL.line}: expected one search spawn call, found ${calls.length}`);
  const call = calls[0].arguments;
  const admitted = JSON.parse(lineOf(R1_ADMITTED.file, R1_ADMITTED.line) || "null");
  if (admitted?.stage !== "search" || JSON.stringify(admitted.plan) !== JSON.stringify(call.plan)) throw new Error(`${R1_ADMITTED.file}:${R1_ADMITTED.line} is not the admission of this call's plan`);
  if (admitted.workers?.length !== call.workers.length || admitted.workers.some((worker: any, index: number) => worker.name !== call.workers[index].name || JSON.stringify(worker.strategy) !== JSON.stringify(call.workers[index].strategy)))
    throw new Error("the admitted strategies differ from the call's");
  const [constraint, ...requests] = SUBSTITUTIONS;
  const constraints = [...call.plan.constraints];
  constraints[4] = once(constraints[4], constraint);
  const workers: PinnedWorker[] = call.workers.map((worker: any, index: number) => {
    const sub = requests[index];
    if (!sub || sub.name !== worker.name || worker.role !== "answer") throw new Error(`unexpected recorded worker ${index}: ${worker.name} (${worker.role})`);
    return { name: worker.name, role: "answer", request: once(worker.request, sub), strategy: worker.strategy };
  });
  const round = { plan: { ...call.plan, constraints }, workers };
  if (/\/tmp\//.test(JSON.stringify(round))) throw new Error("a recorded scratch path is left in the pinned round");
  return { line, call, admitted, round };
}

// ---- the matrix config -------------------------------------------------------------------------------------------------------------
/** r1's MDSD bounds with the r2 changes only: one search round (the matrix), totals doubled for twice the explorers, per-cell scratch. */
export const MATRIX_MDSD = { ...MDSD, maxRounds: 1, total: { costUSD: 2 * MDSD.total.costUSD, requests: 2 * MDSD.total.requests }, explorerScratch: true };
const TOY_BUDGET = { requests: 8, minutes: 6, costUSD: 0.5, outputTokens: 12_000 };
const TOY_MDSD = { ...MATRIX_MDSD, explorer: { requests: 10, minutes: 8, costUSD: 0.6, outputTokens: 12_000 }, total: { costUSD: 6, requests: 200 } };
export const LIMITS_R2 = { envelopeUSD: 2 * LIMITS.envelopeUSD, toyEnvelopeUSD: 8, preflightEnvelopeUSD: 2, piGuardMs: LIMITS.piGuardMs, toyGuardMs: 30 * 60_000, preflightGuardMs: 5 * 60_000 };
export const PREFLIGHT_PROMPT = "Routing preflight: reply with the single word OK.";

export function matrixConfig(round: PinnedRound, toy = false): Record<string, any> {
  return { ...orcheConfig(), mdsd: { ...(toy ? TOY_MDSD : MATRIX_MDSD), replication: { models: MODEL_REFS.map(model => ({ model, thinking: THINKING })), round } } };
}

/** Two toy strategies with the first two recorded signatures (operators, direction, reasoning, validation) on the toy repository. */
export function toyRound(round: PinnedRound): PinnedRound {
  const [a, b] = round.workers;
  const strategy = (base: PinnedWorker, framing: string, hypothesis_space: string[], evidence_scope: string[], method: string[]) => ({ ...base.strategy, framing, hypothesis_space, evidence_scope, method, budget: TOY_BUDGET });
  return {
    plan: { objective: "Answer the read-only question about calc.js in the current directory: which function computes the average, and does it handle an empty list.", constraints: ["Read only: no repository changes or commits.", "Use your scratch directory for temporary files (not /tmp or the repository)."], success: ["the averaging function with file:line", "its empty-list behaviour, with evidence"], rationale: "Routing preflight of the r2 matrix path on a toy repository." },
    workers: [
      { name: "toy-backward", role: "answer", request: "Start from the claim that mean([]) is well defined and work backward through calc.js; reproduce the empty-list result with one small node probe file in your scratch directory. Return findings f1 etc with file:line.", strategy: strategy(a!, "mean as a contract to refute", ["empty input yields NaN", "division by zero is unguarded"], ["calc.js mean", "scratch probe"], ["work back from the result", "run one probe"]) },
      { name: "toy-split", role: "answer", request: "Split calc.js into its functions and check each one's handling of an empty list by reading the code. Return findings f1 etc with file:line.", strategy: strategy(b!, "calc.js as separate functions", ["sum of an empty list", "reduce initial value"], ["calc.js sum", "README.md"], ["read each function", "compare their contracts"]) },
    ],
  };
}

/** The runtime's own admission of the pinned search call (parse, pin check, cap, budget): throws its refusal; never edits the pin. */
export function admission(config: Record<string, any>): { cells: number; worstUSD: number; worstRequests: number; searchLimitUSD: number; searchLimitRequests: number } {
  const settings = parseMdsdConfig(config.mdsd);
  const pin = settings.replication?.round;
  if (!pin) throw new Error("no pinned round in the matrix config");
  const run = new MdsdRun({ orchestrator: "W1", cwd: "/repo", readOnly: true, settings, ledger: () => ({ calls: [], checks: 0, bookkeeping: 0, tag: true }) as any, maxSubWorkers: config.single?.maxSubWorkers });
  const call = run.resolve({ reason: "search", workers: pin.workers.map(worker => ({ name: worker.name, role: "answer", request: "pinned" })) } as any);
  (run as any).validate("search", call.workers, call);
  const models = settings.replication!.models.length;
  const budgets = pin.workers.map(worker => (worker.strategy as any).budget);
  return {
    cells: models * pin.workers.length,
    worstUSD: models * budgets.reduce((sum, budget) => sum + budget.costUSD * settings.hardStopAt, 0),
    worstRequests: models * budgets.reduce((sum, budget) => sum + Math.ceil(budget.requests * settings.hardStopAt) + 2, 0),
    searchLimitUSD: settings.total.costUSD * (1 - settings.reserve), searchLimitRequests: Math.floor(settings.total.requests * (1 - settings.reserve)),
  };
}

// ---- prepare -----------------------------------------------------------------------------------------------------------------------
const resultsOf = (runDir: string) => join(REPO, "results/mdsd-ab", basename(runDir));

async function prepareMatrix(runDir: string): Promise<void> {
  if (basename(runDir) === "r1" || existsSync(join(resultsOf(runDir), "matrix.json"))) throw new Error(`${resultsOf(runDir)} exists; use a fresh run directory`);
  await prepareInputs(runDir);
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  const body = await readFile(join(runDir, "input/prompt-body.md"), "utf8");
  const r1Prompt = JSON.parse(readFileSync(join(R1, "mdsd/meta.json"), "utf8")).command.promptSha256;
  if (sha(`/orche mdsd ${body}`) !== r1Prompt) throw new Error("the input prompt differs from r1's");
  const { line, call, admitted, round } = recoverRound();
  const toy = toyRound(round);
  const pinned = join(runDir, "pinned");
  await mkdir(pinned, { recursive: true });
  await writeFile(join(pinned, "r1-call-line.jsonl"), `${line}\n`);
  await write(join(pinned, "r1-call.json"), call);
  await write(join(pinned, "r1-admitted.json"), admitted);
  await write(join(pinned, "round.json"), round);
  await write(join(pinned, "substitutions.json"), SUBSTITUTIONS);
  await write(join(pinned, "toy-round.json"), toy);
  const catalog = catalogEntries(JSON.parse(readFileSync(join(AGENT, "cliproxyapi-models.json"), "utf8")));
  const entries = MODELS.map(id => { const entry = catalog.find(item => item.id === id); if (!entry) throw new Error(`${id} is not in the CLIProxyAPI catalog`); if (entry.thinkingLevelMap?.[THINKING] !== THINKING) throw new Error(`${id}: thinking ${THINKING} is not mapped to effort ${THINKING}`); return entry; });
  const config = matrixConfig(round), toyConfig = matrixConfig(toy, true);
  const rubric = readFileSync(join(R1, "rubric.sha256"), "utf8").trim().split(/\s+/)[0];
  if (rubric !== sha(readFileSync(join(R1, "rubric.md")))) throw new Error("r1's rubric changed");
  await writeFile(join(runDir, "rubric.sha256"), `${rubric}  results/mdsd-ab/r1/rubric.md\n`);
  const matrix = {
    r1: { call: { ...R1_CALL, file: R1_CALL.file.slice(REPO.length + 1), lineSha256: sha(line) }, admitted: { ...R1_ADMITTED, file: R1_ADMITTED.file.slice(REPO.length + 1), sha256: sha(lineOf(R1_ADMITTED.file, R1_ADMITTED.line)) }, promptSha256: r1Prompt, runtimeDigest: "c2af6e14f62a17dddaa76bf5d32c9bd1d0e05a8f68e23769ba9f415b2212be4f", rubricSha256: rubric },
    pinned: { roundSha256: sha(JSON.stringify(round)), callSha256: sha(JSON.stringify(call)), toyRoundSha256: sha(JSON.stringify(toy)), substitutions: SUBSTITUTIONS.length, strategies: round.workers.map(worker => ({ name: worker.name, operators: worker.strategy.operators, direction: worker.strategy.direction, budget: worker.strategy.budget })) },
    cells: round.workers.flatMap(worker => MODEL_REFS.map(model => ({ strategy: worker.name, model, thinking: THINKING, allocation: worker.strategy.budget }))),
    models: entries.map(entry => ({ ref: `${PROVIDER}/${entry.id}`, cost: entry.cost, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, thinkingLevelMap: entry.thinkingLevelMap, compat: entry.compat })),
    prices: Object.fromEntries(entries.map(entry => [entry.id, entry.cost])),
    config: { orche: config, sha256: sha(JSON.stringify(config)), admission: admission(config) },
    toyConfig: { orche: toyConfig, sha256: sha(JSON.stringify(toyConfig)), admission: admission(toyConfig) },
    limits: { ...LIMITS_R2, orche: LIMITS.orche },
    roles: { main: `${MODEL_REFS[0]}/${THINKING}`, orchestrator: `${MODEL_REFS[0]}/${THINKING} (models.strong-orchestrator)`, verifiers: "inherit the orchestrator (r1)", cells: MODEL_REFS.map(model => `${model}/${THINKING}`) },
    target: manifest.target, runtime: manifest.runtime, prompt: { sha256: manifest.prompt.sha256, oneShotSha256: sha(`/orche mdsd ${body}`) },
    proxySha256: sha(readFileSync(join(REPO, "experiments/mdsd-ab/proxy.mjs"))), runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    frozenAt: new Date().toISOString(),
  };
  await write(join(runDir, "matrix.json"), matrix);
  const results = resultsOf(runDir);
  await mkdir(results, { recursive: true });
  await cp(pinned, join(results, "pinned"), { recursive: true });
  for (const name of ["matrix.json", "manifest.json", "rubric.sha256"]) await copyFile(join(runDir, name), join(results, name));
  console.log(`prepared ${runDir}: runtime ${manifest.runtime.digest.slice(0, 12)}, prompt ${manifest.prompt.sha256.slice(0, 12)} (= r1), ${matrix.cells.length} cells, admission ${JSON.stringify(matrix.config.admission)}`);
}

// ---- shared run pieces -------------------------------------------------------------------------------------------------------------
export function sandboxEnv(proxyUrl: string, apiKey: string): NodeJS.ProcessEnv {
  return {
    HOME, USER: process.env.USER ?? "arthur", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb",
    PATH: [join(NODE, ".."), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    TMPDIR: "/tmp/pi-orche/tmp", PI_CODING_AGENT_DIR: AGENT, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    CLIPROXYAPI_BASE_URL: proxyUrl, CLIPROXYAPI_API_KEY: apiKey, CLIPROXYAPI_FAST: "0",
  };
}
export const piArgs = (model: string, sessionId: string, prompt: string, orche: boolean) => [NODE, PI_CLI, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve",
  "-e", join(PROVIDER_MOUNT, "extensions/index.ts"), ...(orche ? ["-e", join(RUNTIME_MOUNT, "src/extension/index.ts")] : []), "--model", model, "--thinking", THINKING, "--mode", "json", "--session-id", sessionId, prompt];

export async function redact(dir: string, secrets: string[]): Promise<void> {
  for (const file of filesUnder(dir, /\.(json|jsonl|txt|md)$/)) {
    const text = readFileSync(file, "utf8");
    if (secrets.some(secret => secret && text.includes(secret))) await writeFile(file, secrets.reduce((acc, secret) => secret ? acc.split(secret).join("[REDACTED]") : acc, text));
  }
}

export interface Transcript { id: string; file: string; agent: string; models: string[]; thinking: string[]; responseModels: Record<string, number>; first?: string; last?: string; lastText?: string; reports: any[] }
/** Pi session transcripts below `root`, by session id (line 1); the agent is the file name's worker id (orche records) or main. */
export function sessionTranscripts(...roots: string[]): Map<string, Transcript> {
  const out = new Map<string, Transcript>();
  for (const root of roots) for (const file of filesUnder(root, /\.jsonl$/)) {
    const entries = readJsonl(file);
    const head = entries[0];
    if (head?.type !== "session" || !head.id || out.has(head.id)) continue;
    const responseModels: Record<string, number> = {};
    let lastText: string | undefined;
    const reports: any[] = [];
    for (const entry of entries) {
      const message = entry?.message;
      if (message?.role !== "assistant") continue;
      const key = `${message.provider}/${message.model}`; responseModels[key] = (responseModels[key] ?? 0) + 1;
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "text" && part.text?.trim()) lastText = part.text;
        if (part?.type === "toolCall" && part.name === "report_result") reports.push({ at: entry.timestamp, arguments: part.arguments });
      }
    }
    out.set(head.id, {
      id: head.id, file, agent: /^(W\d+(?:\.\d+)*)-\d{4}-/.exec(basename(file))?.[1] ?? "main",
      models: entries.filter(entry => entry?.type === "model_change").map(entry => `${entry.provider}/${entry.modelId}`),
      thinking: entries.filter(entry => entry?.type === "thinking_level_change").map(entry => entry.thinkingLevel),
      responseModels, first: head.timestamp, last: entries.at(-1)?.timestamp, ...(lastText ? { lastText } : {}), reports,
    });
  }
  return out;
}

/** File content hashes below `root` (`.git` and the node_modules mount point aside): the target's immutability is checked on these. */
export function contentHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), name = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && (entry.name === ".git" || entry.name === "node_modules")) continue;
      if (entry.isSymbolicLink()) out[name] = `symlink:${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path, name);
      else out[name] = entry.isFile() ? sha(readFileSync(path)) : "special";
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}
/** Before/after: changed and removed snapshot files, files created outside orche's `.orche/` tool-output spill, and the spill (gitignored). */
export function hashDiff(before: Record<string, string>, after: Record<string, string>) {
  const changed = Object.keys(before).filter(name => name in after && after[name] !== before[name]);
  const removed = Object.keys(before).filter(name => !(name in after));
  const created = Object.keys(after).filter(name => !(name in before));
  const spill = created.filter(name => name.startsWith(".orche/"));
  const added = created.filter(name => !name.startsWith(".orche/"));
  return { files: Object.keys(before).length, changed, removed, added, spill: spill.length, unchanged: !changed.length && !removed.length && !added.length };
}

/**
 * The confidentiality audit of every tool call: AUDIT_PATTERNS (run.ts) after the run's own scratch root is masked, plus, for the
 * explorer cells, any path into another agent's scratch directory (a sibling cell's or the orchestrator's round files) and any read
 * of another agent's `.orche/artifacts` tool-output spill (same-user processes; mode 0700 does not separate them, so it is audited).
 */
export function auditMatrix(files: string[], scratchRoot: string, cells: ReadonlySet<string>): { calls: number; hits: string[]; cross: string[]; review: string[] } {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let calls = 0;
  const hits: string[] = [], cross: string[] = [], review: string[] = [];
  for (const file of files) {
    const entries = readJsonl(file);
    const agent = /^(W\d+(?:\.\d+)*)-\d{4}-/.exec(basename(file))?.[1] ?? "main";
    const own = new Set<string>();
    for (const entry of entries) if (entry?.message?.role === "toolResult") for (const match of JSON.stringify(entry.message.content ?? "").matchAll(/Full output(?: saved to|:) (\.orche\/artifacts\/[\w.-]+)/g)) own.add(match[1]!);
    const ownScratch = new RegExp(`${escape(scratchRoot)}/${escape(agent)}(?!\\d|\\.\\d)`, "g");
    for (const entry of entries) {
      if (entry?.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
      for (const part of entry.message.content) {
        if (part?.type !== "toolCall") continue;
        calls++;
        const text = JSON.stringify(part.arguments ?? {});
        const where = `${agent} ${part.name} ${text.slice(0, 220)}`;
        const masked = text.replace(ownScratch, "<own-scratch>");
        const isCell = cells.has(agent);
        if (isCell && masked.includes(scratchRoot)) cross.push(`${where} [another agent's scratch]`);
        const general = masked.split(scratchRoot).join("<run-scratch>");
        for (const pattern of AUDIT_PATTERNS) if (pattern.test(general)) hits.push(`${where} [${pattern}]`);
        if (!isCell) continue;
        for (const match of general.matchAll(/\.orche\/artifacts\/[\w.-]+/g)) if (!own.has(match[0])) cross.push(`${where} [another agent's tool-output spill]`);
        if (/\.orche(?!\/artifacts\/[\w.-])/.test(general)) review.push(`${where} [.orche listing]`);
      }
    }
  }
  return { calls, hits, cross, review };
}

/** The commit-free target: a fresh repository that fetches the snapshot commit itself (depth 1) and checks it out; no commit is made. */
export async function snapshot(armDir: string, toy: boolean): Promise<{ dir: string; head?: string; tree?: string }> {
  const dir = join(armDir, "target");
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "--quiet", "--initial-branch=master"]);
  if (toy) {
    await writeFile(join(dir, "calc.js"), "export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n\nexport function mean(xs) {\n  return sum(xs) / xs.length;\n}\n");
    await writeFile(join(dir, "README.md"), "Tiny calculator helpers.\n");
  } else {
    const commit = git(REPO, ["rev-parse", `${TARGET_COMMIT}^{commit}`]).toString().trim();
    git(dir, ["fetch", "--quiet", "--depth", "1", "--no-tags", `file://${REPO}`, commit]);
    git(dir, ["update-ref", "refs/heads/master", commit]);
    git(dir, ["checkout", "--quiet", "--force", "master"]);
    for (const name of ["FETCH_HEAD", "logs"]) await import("node:fs/promises").then(fs => fs.rm(join(dir, ".git", name), { recursive: true, force: true }));
  }
  await writeFile(join(dir, ".git/info/exclude"), "node_modules\n");
  await mkdir(join(dir, "node_modules"), { recursive: true }); // mount point
  if (toy) return { dir };
  return { dir, head: git(dir, ["rev-parse", "HEAD"]).toString().trim(), tree: git(dir, ["rev-parse", "HEAD^{tree}"]).toString().trim() };
}

// ---- preflight ---------------------------------------------------------------------------------------------------------------------
/** One direct `pi` request per model through the proxy (no orche): the request-level model and effort, Pi's recorded route, the answer. */
async function preflight(runDir: string): Promise<void> {
  const dir = join(runDir, "preflight");
  if (existsSync(join(dir, "preflight.json"))) throw new Error(`${dir}: the preflight runs once`);
  const matrix = JSON.parse(await readFile(join(runDir, "matrix.json"), "utf8"));
  await mkdir(join(dir, "pi-orche/tmp"), { recursive: true });
  await mkdir(join(dir, "target/node_modules"), { recursive: true });
  await write(join(dir, "envelope.json"), { capUSD: LIMITS_R2.preflightEnvelopeUSD, prices: matrix.prices });
  const proxy = await startProxy(join(dir, "wire.jsonl"), join(dir, "envelope.json"));
  const agent = await agentDir(dir, proxy.url, orcheConfig());
  const runs: any[] = [];
  try {
    for (const ref of MODEL_REFS) {
      const sessionId = `mdsd-ab-preflight-${ref.split("/")[1]}`;
      const args = [...sandboxArgs({ agent: agent.dir, target: join(dir, "target"), runtime: join(runDir, "runtime"), provider: join(runDir, "provider"), scratch: join(dir, "pi-orche") }), "--", ...piArgs(ref, sessionId, PREFLIGHT_PROMPT, false)];
      const outcome = await runGuarded("bwrap", args, { env: sandboxEnv(proxy.url, agent.apiKey), stdout: join(dir, `${sessionId}.events.jsonl`), stderr: join(dir, `${sessionId}.stderr.txt`), guardMs: LIMITS_R2.preflightGuardMs });
      runs.push({ ref, sessionId, exit: outcome.code, guardFired: outcome.guardFired, ms: outcome.endedAt - outcome.startedAt });
    }
  } finally { proxy.child.kill("SIGTERM"); }
  const wire = readJsonl(join(dir, "wire.jsonl")).filter(entry => entry.method === "POST" && entry.model);
  const transcripts = sessionTranscripts(join(agent.dir, "sessions"));
  for (const run of runs) {
    const id = run.ref.split("/")[1];
    const mine = wire.filter(entry => entry.session === run.sessionId);
    const transcript = transcripts.get(run.sessionId);
    run.requests = mine.map(entry => ({ model: entry.model, effort: entry.effort, updateEfforts: entry.updateEfforts, status: entry.status, respModel: entry.respModel, finalModel: entry.finalModel, final: entry.final, maxOutput: entry.maxOutput, usage: entry.usage, rawUsage: entry.rawUsage, costUSD: entry.costUSD, providerError: entry.providerError, ms: Date.parse(entry.endAt) - Date.parse(entry.at) }));
    run.transcript = transcript ? { models: transcript.models, thinking: transcript.thinking, responseModels: transcript.responseModels, answer: transcript.lastText?.slice(0, 200) } : undefined;
    run.checks = {
      exited: run.exit === 0 && !run.guardFired, requests: mine.length > 0,
      requestModel: mine.every(entry => entry.model === id), requestEffort: mine.every(entry => entry.effort === THINKING && (entry.updateEfforts ?? []).every((effort: string) => effort === THINKING)),
      http200: mine.every(entry => entry.status === 200 && !entry.providerError), usage: mine.every(entry => entry.usage),
      piRoute: !!transcript && transcript.models.length > 0 && transcript.models.every(model => model === run.ref) && Object.keys(transcript.responseModels).every(model => model === run.ref),
      piThinking: !!transcript && transcript.thinking.length > 0 && transcript.thinking.every(level => level === THINKING),
    };
    run.pass = Object.values(run.checks).every(Boolean);
  }
  const result = { at: new Date().toISOString(), prompt: PREFLIGHT_PROMPT, runs, unmatched: wire.filter(entry => !runs.some(run => run.sessionId === entry.session)).length, pass: runs.length === MODEL_REFS.length && runs.every(run => run.pass), unobserved: "what CLIProxyAPI sends upstream for effort max (its translation per vendor) is not visible to this proxy" };
  await write(join(dir, "preflight.json"), result);
  const results = join(resultsOf(runDir), "preflight");
  await mkdir(results, { recursive: true });
  for (const name of readdirSync(dir)) if (/\.(json|jsonl|txt)$/.test(name)) await copyFile(join(dir, name), join(results, name));
  await cp(join(agent.dir, "sessions"), join(results, "sessions"), { recursive: true }).catch(() => undefined);
  await redact(results, agent.secrets);
  console.log(JSON.stringify(result, null, 1).slice(0, 5000));
}

// ---- the matrix run ----------------------------------------------------------------------------------------------------------------
async function runMatrix(runDir: string, toy: boolean): Promise<void> {
  const id = toy ? "matrix-toy" : "matrix";
  const armDir = join(runDir, id);
  if (existsSync(join(armDir, "meta.json"))) throw new Error(`${armDir} exists; the matrix runs once`);
  const matrix = JSON.parse(await readFile(join(runDir, "matrix.json"), "utf8"));
  const preflightResult = JSON.parse(await readFile(join(runDir, "preflight/preflight.json"), "utf8"));
  if (!preflightResult.pass) throw new Error("the route preflight did not pass; no matrix run");
  const entry = toy ? matrix.toyConfig : matrix.config;
  if (sha(JSON.stringify(entry.orche)) !== entry.sha256) throw new Error("the matrix config changed since prepare");
  const admitted = admission(entry.orche);
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  const body = await readFile(join(runDir, toy ? "input/toy-prompt.md" : "input/prompt-body.md"), "utf8");
  if (sha(body) !== (toy ? manifest.toyPrompt.sha256 : manifest.prompt.sha256)) throw new Error("input prompt changed since prepare");
  if (!toy && readFileSync(join(runDir, "rubric.sha256"), "utf8").split(/\s+/)[0] !== sha(readFileSync(join(R1, "rubric.md")))) throw new Error("the rubric changed since prepare");
  await mkdir(armDir, { recursive: true });
  const meta: any = { id, toy, runDir, preparedAt: Date.now(), config: entry.sha256, admission: admitted, runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), proxySha256: sha(readFileSync(join(REPO, "experiments/mdsd-ab/proxy.mjs"))) };
  const save = () => write(join(armDir, "meta.json"), meta);
  await save();
  const target = await snapshot(armDir, toy);
  if (!toy && (target.head !== manifest.target.commit || target.tree !== manifest.target.tree)) throw new Error(`snapshot ${target.head}/${target.tree} != ${manifest.target.commit}/${manifest.target.tree}`);
  const before = contentHashes(target.dir);
  await write(join(armDir, "target-before.json"), before);
  meta.target = { head: target.head, tree: target.tree, files: Object.keys(before).length, digest: sha(JSON.stringify(before)) };
  const scratch = join(armDir, "pi-orche");
  await mkdir(join(scratch, "tmp"), { recursive: true });
  await write(join(armDir, "envelope.json"), { capUSD: toy ? LIMITS_R2.toyEnvelopeUSD : LIMITS_R2.envelopeUSD, prices: matrix.prices });
  const proxy = await startProxy(join(armDir, "wire.jsonl"), join(armDir, "envelope.json"));
  const agent = await agentDir(armDir, proxy.url, entry.orche);
  const prompt = `/orche mdsd ${body}`;
  await writeFile(join(armDir, "prompt.txt"), prompt);
  const sessionId = `mdsd-ab-${id}`;
  const args = [...sandboxArgs({ agent: agent.dir, target: target.dir, runtime: join(runDir, "runtime"), provider: join(runDir, "provider"), scratch }), "--", ...piArgs(MODEL_REFS[0]!, sessionId, prompt, true)];
  const env = sandboxEnv(proxy.url, agent.apiKey);
  meta.command = { bwrap: args.slice(0, args.indexOf("--")), pi: args.slice(args.indexOf("--") + 1, -1), promptSha256: sha(prompt), env: Object.keys(env).sort() };
  meta.proxy = proxy.url;
  await save();
  // orche removes the orchestrator's scratch directory when its assignment ends (workers.ts removeScratchDir), and with it the
  // persisted round files; they are copied as they appear (every version, with its sha256), so the frozen round survives the run.
  const sessionScratch = join(scratch, "tmp/pi-orche", sessionId);
  const rounds = join(armDir, "rounds"), seen = new Map<string, string>();
  const copyRounds = () => { try { for (const file of filesUnder(sessionScratch, /^mdsd-.*\.(md|json)$/)) { const bytes = readFileSync(file), digest = sha(bytes), name = basename(file); if (seen.get(name) === digest) continue; seen.set(name, digest); mkdirSync(rounds, { recursive: true }); writeFileSync(join(rounds, name), bytes); appendFileSync(join(rounds, "copies.jsonl"), `${JSON.stringify({ name, sha256: digest, bytes: bytes.length, at: new Date().toISOString() })}\n`); } } catch { /* next tick */ } };
  const copier = setInterval(copyRounds, 500);
  try {
    meta.pi = await runGuarded("bwrap", args, { env, stdout: join(armDir, "events.jsonl"), stderr: join(armDir, "stderr.txt"), guardMs: toy ? LIMITS_R2.toyGuardMs : LIMITS_R2.piGuardMs });
  } finally { clearInterval(copier); copyRounds(); proxy.child.kill("SIGTERM"); }
  meta.wallMs = meta.pi.endedAt - meta.pi.startedAt;
  const after = contentHashes(target.dir);
  await write(join(armDir, "target-after.json"), after);
  meta.targetCheck = hashDiff(before, after);
  meta.targetGit = { head: toy ? undefined : git(target.dir, ["rev-parse", "HEAD"]).toString().trim(), status: git(target.dir, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]).toString().split("\n").filter(Boolean).slice(0, 200) };
  const scratchRoot = `/tmp/pi-orche/tmp/pi-orche/${sessionId}`;
  const transcripts = [...filesUnder(join(agent.dir, "orche/records"), /\.jsonl$/).filter(file => file.includes("/workers/")), ...filesUnder(join(agent.dir, "sessions"), /\.jsonl$/)];
  const search = readJsonl(filesUnder(join(agent.dir, "orche/records"), /^events\.jsonl$/)[0] ?? "").find(event => event.type === "mdsd" && event.stage === "search");
  meta.audit = auditMatrix(transcripts, scratchRoot, new Set((search?.workers ?? []).map((worker: any) => String(worker.id))));
  meta.wire = existsSync(join(armDir, "wire.jsonl.totals.json")) ? JSON.parse(readFileSync(join(armDir, "wire.jsonl.totals.json"), "utf8")) : undefined;
  meta.secrets = agent.secrets.map(secret => sha(secret).slice(0, 8));
  await save();
  const results = join(resultsOf(runDir), id);
  await mkdir(results, { recursive: true });
  for (const name of ["meta.json", "events.jsonl", "stderr.txt", "wire.jsonl", "wire.jsonl.totals.json", "envelope.json", "prompt.txt", "target-before.json", "target-after.json"]) if (existsSync(join(armDir, name))) await copyFile(join(armDir, name), join(results, name));
  await cp(join(agent.dir, "orche/records"), join(results, "records"), { recursive: true }).catch(() => undefined);
  await cp(join(agent.dir, "sessions"), join(results, "sessions"), { recursive: true }).catch(() => undefined);
  if (existsSync(rounds)) await cp(rounds, join(results, "rounds"), { recursive: true });
  if (existsSync(sessionScratch)) for (const cell of readdirSync(sessionScratch).filter(name => /^W1\.\d+$/.test(name))) {
    for (const file of filesUnder(join(sessionScratch, cell), /./)) {
      if (statSync(file).size > 262_144) continue;
      const to = join(results, "cell-scratch", cell, file.slice(join(sessionScratch, cell).length + 1));
      await mkdir(dirname(to), { recursive: true }); await copyFile(file, to);
    }
  }
  await redact(results, agent.secrets);
  console.log(`MATRIX ${id}: exit ${meta.pi.code}${meta.pi.signal ? ` ${meta.pi.signal}` : ""}${meta.pi.guardFired ? " (guard)" : ""}, ${Math.round(meta.wallMs / 1000)} s, ${meta.wire?.requests ?? "?"} requests, $${meta.wire?.costUSD ?? "?"}, audit hits ${meta.audit.hits.length}, cross ${meta.audit.cross.length}, review ${meta.audit.review.length}, target unchanged ${meta.targetCheck.unchanged} (spill ${meta.targetCheck.spill})`);
}

// ---- summary -----------------------------------------------------------------------------------------------------------------------
const countBy = <T>(items: T[], key: (item: T) => string) => items.reduce((acc: Record<string, number>, item) => { const name = key(item); acc[name] = (acc[name] ?? 0) + 1; return acc; }, {});
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
export function wireStats(entries: any[]) {
  const sum = (key: string) => entries.reduce((total, entry) => total + (entry.usage?.[key] ?? 0), 0);
  const starts = entries.map(entry => Date.parse(entry.at)), ends = entries.map(entry => Date.parse(entry.endAt ?? entry.at));
  const rawKeys = new Set<string>();
  const keysOf = (value: any, prefix = ""): void => { for (const [key, item] of Object.entries(value ?? {})) typeof item === "object" ? keysOf(item, `${prefix}${key}.`) : rawKeys.add(`${prefix}${key}`); };
  for (const entry of entries) keysOf(entry.rawUsage);
  return {
    requests: entries.length, statuses: countBy(entries, entry => String(entry.status)), routes: countBy(entries, entry => `${entry.model}@${entry.effort}`),
    updateEfforts: countBy(entries.flatMap(entry => entry.updateEfforts ?? []), effort => String(effort)), respModels: countBy(entries, entry => String(entry.finalModel ?? entry.respModel ?? "?")),
    input: sum("input"), cached: sum("cached"), cacheWrite: sum("cacheWrite"), output: sum("output"), reasoning: sum("reasoning"), rawUsageKeys: [...rawKeys].sort(),
    costUSD: round6(entries.reduce((total, entry) => total + (entry.costUSD ?? 0), 0)), unknownUsage: entries.filter(entry => !entry.usage).length, incomplete: countBy(entries.filter(entry => entry.incomplete), entry => String(entry.incomplete)),
    providerErrors: entries.filter(entry => entry.providerError || entry.error).map(entry => ({ id: entry.id, status: entry.status, ...(entry.providerError ?? {}), ...(entry.error ? { connection: entry.error } : {}) })),
    firstAt: entries.length ? new Date(Math.min(...starts)).toISOString() : undefined, lastEndAt: entries.length ? new Date(Math.max(...ends)).toISOString() : undefined,
    spanMs: entries.length ? Math.max(...ends) - Math.min(...starts) : 0, requestMs: entries.reduce((total, entry) => total + (Date.parse(entry.endAt ?? entry.at) - Date.parse(entry.at)), 0),
  };
}

async function summarizeMatrix(runDir: string, toy: boolean): Promise<void> {
  const id = toy ? "matrix-toy" : "matrix";
  const dir = join(resultsOf(runDir), id);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const wire = readJsonl(join(dir, "wire.jsonl")).filter(entry => entry.method === "POST" && entry.model);
  const transcripts = sessionTranscripts(...readdirSync(join(dir, "records")).map(name => join(dir, "records", name, "workers")), join(dir, "sessions"));
  const bySession = new Map([...transcripts.values()].map(item => [item.id, item]));
  const agentOf = (session: string) => bySession.get(session)?.agent;
  const task = taskRuns(join(dir, "records")).find(item => item.run.outcome?.mdsd);
  const run = task?.run;
  const events = task ? readJsonl(join(dir, "records", dirname(task.file), "events.jsonl")) : [];
  const stage = (name: string) => events.filter(event => event.type === "mdsd" && event.stage === name);
  /** Event time (ms): orche's run events carry `timestamp`. */
  const ms = (event: any): number | undefined => typeof event?.timestamp === "number" ? event.timestamp : typeof event?.at === "number" ? event.at : event?.timestamp ? Date.parse(event.timestamp) : undefined;
  // The search-end event is large; orche's record writer may keep only its stub ({ truncated, bytes }): the first truncated MDSD event
  // after the search event is then its place in time (its content is in the copied round JSON).
  const search = stage("search")[0], searchAt = events.indexOf(search);
  const searchEnd = stage("search-end")[0] ?? events.find((event, index) => index > searchAt && event.type === "mdsd" && event.truncated);
  const agents: any[] = run?.agents ?? [];
  const transcriptOf = (agent: string) => [...transcripts.values()].find(item => item.agent === agent);
  const wireOf = (agent: string) => { const session = transcriptOf(agent)?.id ?? (agent === "main" ? `mdsd-ab-${id}` : undefined); return wire.filter(entry => entry.session === session); };
  const explorers: any[] = run?.outcome?.mdsd?.explorers ?? [];
  const cells = (search?.workers ?? []).map((worker: any) => {
    const agent = agents.find(item => item.id === worker.id), explorer = explorers.find(item => item.id === worker.id), ended = (searchEnd?.explorers ?? []).find((item: any) => item.id === worker.id);
    const mine = wireOf(worker.id), transcript = transcriptOf(worker.id), model = String(worker.model ?? "");
    const doneAt = agent ? agent.startedAt + agent.durationMs : undefined;
    return {
      id: worker.id, strategy: worker.name, group: worker.group, model,
      route: {
        ok: mine.length > 0 && mine.every(entry => `${PROVIDER}/${entry.model}` === model && entry.effort === THINKING && (entry.updateEfforts ?? []).every((effort: string) => effort === THINKING)) && !!transcript && transcript.models.every(item => item === model) && transcript.thinking.length > 0 && transcript.thinking.every(level => level === THINKING),
        outcome: agent ? { model: agent.model, thinking: agent.thinking, modelSource: agent.modelSource, thinkingSource: agent.thinkingSource } : undefined,
        transcriptModels: transcript?.models, transcriptThinking: transcript?.thinking, responseModels: transcript?.responseModels,
      },
      status: explorer?.status ?? ended?.status, findings: explorer?.findings, allocated: explorer?.allocated, actual: explorer?.actual, overshoot: explorer?.overshoot, wrapUp: explorer?.wrapUp, stoppedBy: ended?.stoppedBy,
      startedAt: agent?.startedAt, durationMs: agent?.durationMs, requestsByRuntime: agent?.requests, barrierWaitMs: doneAt && ms(searchEnd) ? ms(searchEnd)! - doneAt : undefined,
      wire: wireStats(mine),
    };
  });
  const cellIds = new Set(cells.map((cell: any) => cell.id));
  // The audit again from the copied records with this file's audit code (the at-run result stays in meta.json).
  const audited = auditMatrix([...transcripts.values()].map(item => item.file), `/tmp/pi-orche/tmp/pi-orche/mdsd-ab-${id}`, cellIds as Set<string>);
  const verifiers = agents.filter(agent => agent.role === "verify").map(agent => ({ id: agent.id, model: agent.model, thinking: agent.thinking, modelSource: agent.modelSource, startedAt: agent.startedAt, durationMs: agent.durationMs, wire: wireStats(wireOf(agent.id)) }));
  const others = agents.filter(agent => agent.id !== "W1" && !cellIds.has(agent.id) && agent.role !== "verify").map(agent => ({ id: agent.id, role: agent.role, wire: wireStats(wireOf(agent.id)) }));
  const known = new Set([...transcripts.keys(), `mdsd-ab-${id}`]);
  const unmatched = wire.filter(entry => !known.has(entry.session));
  const group = (name: string, entries: any[]) => ({ name, ...wireStats(entries) });
  const cellWire = (model: string) => cells.filter((cell: any) => cell.model === model).flatMap((cell: any) => wireOf(cell.id));
  const roundJson = existsSync(join(dir, "rounds")) ? readdirSync(join(dir, "rounds")).find(name => name.endsWith(".json")) : undefined;
  const roundSha = roundJson ? sha(readFileSync(join(dir, "rounds", roundJson))) : undefined;
  const w1 = transcriptOf("W1");
  const finalReport = w1?.reports.at(-1);
  if (finalReport) await write(join(dir, "final-report.json"), finalReport);
  let finalText = "";
  for (const event of readJsonl(join(dir, "events.jsonl"))) { const message = event?.message; if (event?.type === "message_end" && message?.role === "assistant" && Array.isArray(message.content)) { const text = message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(""); if (text.trim()) finalText = text; } }
  await writeFile(join(dir, "final-text.md"), finalText);
  await mkdir(join(dir, "cell-reports"), { recursive: true });
  for (const cell of cells) { const report = transcriptOf(cell.id)?.reports.at(-1); if (report) await write(join(dir, "cell-reports", `${cell.id}-${cell.strategy}-${cell.model.split("/")[1]}.json`), report); }
  const at = (event: any) => ms(event) ? new Date(ms(event)!).toISOString() : undefined;
  const summary = {
    id, exit: meta.pi?.code, guardFired: meta.pi?.guardFired, wallMs: meta.wallMs, startedAt: meta.pi ? new Date(meta.pi.startedAt).toISOString() : undefined, endedAt: meta.pi ? new Date(meta.pi.endedAt).toISOString() : undefined,
    target: { ...meta.target, check: meta.targetCheck, git: meta.targetGit }, audit: { ...audited, atRun: { hits: meta.audit?.hits?.length, cross: meta.audit?.cross?.length, review: meta.audit?.review?.length } },
    complete: cells.length === 6 * (toy ? 2 / 3 : 1) && cells.every((cell: any) => cell.status === "done" && cell.route.ok),
    timeline: { search: at(search), searchEnd: at(searchEnd), searchEndTruncated: !!searchEnd?.truncated, barrierMs: ms(search) && ms(searchEnd) ? ms(searchEnd)! - ms(search)! : undefined, verification: stage("verification").map(at), gates: stage("gate").map(event => ({ at: at(event), passed: event.passed ?? (event.rejected ? false : undefined) })), end: at(stage("end")[0]), phases: run?.outcome?.mdsd?.phases, task: run ? { start: run.start, end: run.end, durationMs: run.durationMs } : undefined },
    frozen: { roundFile: roundJson, sha256: roundSha, eventSha256: searchEnd?.sha256, matches: !!roundSha && roundSha === searchEnd?.sha256, copies: existsSync(join(dir, "rounds/copies.jsonl")) ? readJsonl(join(dir, "rounds/copies.jsonl")) : [] },
    cells, verifiers, others,
    orchestrator: agents.find(agent => agent.id === "W1") ? { ...(({ sessionFile, ...rest }) => rest)(agents.find(agent => agent.id === "W1")), wire: wireStats(wireOf("W1")) } : undefined,
    main: wireStats(wireOf("main")),
    groups: [group("main", wireOf("main")), group("orchestrator W1", wireOf("W1")), ...MODEL_REFS.map(model => group(`cells ${model}`, cellWire(model))), group("verifiers", verifiers.flatMap(item => wireOf(item.id))), group("other sub-workers", others.flatMap(item => wireOf(item.id))), group("unmatched", unmatched)],
    unmatched: { requests: unmatched.length, sessions: countBy(unmatched, entry => String(entry.session)) },
    totals: meta.wire, mdsd: run?.outcome?.mdsd ? (({ explorers: _explorers, ...rest }) => rest)(run.outcome.mdsd) : undefined, outcome: run?.outcome ? { status: run.outcome.status, requests: run.outcome.requests, model: run.outcome.model } : undefined,
    finalReport: finalReport ? { at: finalReport.at, chars: JSON.stringify(finalReport.arguments).length } : undefined, finalTextChars: finalText.length,
  };
  await write(join(resultsOf(runDir), `summary-${id}.json`), summary);
  const table = cells.map((cell: any) => `${cell.id} ${cell.strategy} ${cell.model} route=${cell.route.ok} status=${cell.status} findings=${cell.findings} wire=${cell.wire.requests}req $${cell.wire.costUSD} out=${cell.wire.output} dur=${Math.round((cell.durationMs ?? 0) / 1000)}s wait=${Math.round((cell.barrierWaitMs ?? 0) / 1000)}s over=${JSON.stringify(cell.overshoot ?? [])}`);
  console.log([`complete=${summary.complete} exit=${summary.exit} wall=${Math.round((meta.wallMs ?? 0) / 1000)}s total=$${meta.wire?.costUSD} req=${meta.wire?.requests} unmatched=${unmatched.length} frozen(event sha)=${summary.frozen.matches} round sha=${roundSha?.slice(0, 12)} target=${meta.targetCheck?.unchanged} audit hits/cross/review=${audited.hits.length}/${audited.cross.length}/${audited.review.length}`, ...table, ...summary.groups.map(item => `${item.name}: ${item.requests} req $${item.costUSD} in=${item.input} cached=${item.cached} out=${item.output} routes=${JSON.stringify(item.routes)} upd=${JSON.stringify(item.updateEfforts)}`)].join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, runDir] = process.argv.slice(2);
  const toy = process.argv.includes("--toy");
  if (!runDir) throw new Error("usage: matrix.ts prepare|preflight|run|summarize <runDir> [--toy]");
  if (command === "prepare") await prepareMatrix(runDir);
  else if (command === "preflight") await preflight(runDir);
  else if (command === "run") await runMatrix(runDir, toy);
  else if (command === "summarize") await summarizeMatrix(runDir, toy);
  else throw new Error(`unknown command ${command}`);
  process.exit(0);
}
