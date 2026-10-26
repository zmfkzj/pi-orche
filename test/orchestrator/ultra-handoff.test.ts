/**
 * The analysts' hand-off of ultra mode, round 2 ("H2": src/orchestrator/ultra.ts, docs/orchestrator.md 14.2). Every existing workspace
 * file a finished exploration analyst names in its own report is a finding of that exploration round. Before any candidate copy is
 * made, every pending finding must be assigned (one implementation candidate owns its path through its files AND names it in its
 * request; an answer candidate: names it), kept as read-only context (`reference`, named in a request) or left out (`excluded`), both
 * with a reason and a successful check of the orchestrator made after that round whose arguments or output name the file, or lie
 * outside the assignment's write scope (recorded automatically); otherwise the candidates call is refused before anything is made.
 * A mention without ownership (round 1's path dump), or ownership without a mention, is no transfer.
 *
 * Replayed from results/ultra-ab/main/runs/tox-dev__tox-3904/B/r1: the analyst reported the TOML sibling
 * src/tox/config/loader/toml/_replace.py:46–57 (in its data, next to the INI cause in its summary), both candidate rounds were scoped to
 * the INI loader only, and the hidden TOML test failed. Model-free, through the code paths a real assignment uses: orche_spawn as
 * createSpawnTool runs it with UltraRun as its stage contract, the probes around every call (with the call's arguments and its result
 * text, as src/extension/workers.ts hands them over), a real tool-call ledger, a real git workspace with real candidate copies and real
 * shell checks. Sub-workers are scripted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSpawnTool, mdsdSpawnParametersFor, planSpawn, spawnParametersFor, type PlannedWorker, type SpawnContext, type SubWorkerOutcome } from "../../src/orchestrator/spawn.js";
import { subWorkerFloor, UltraRun, ultraSection, type UltraState } from "../../src/orchestrator/ultra.js";
import { toolResultText } from "../../src/extension/workers.js";
import { evidenceLedgerOf, recordToolCall } from "../../src/pi/tool-evidence.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
/** spawn.ts of the round-1 hand-off runtime as frozen for the stage-3 study (read only). */
const FROZEN_SPAWN = fileURLToPath(new URL("../../results/ultra-ho/stage3/rt-handoff/src/orchestrator/spawn.ts", import.meta.url));

const INI = "src/tox/config/loader/ini/factor.py";
const TOML = "src/tox/config/loader/toml/_replace.py";
const SETS = "src/tox/config/sets.py";

/** A git workspace shaped like tox's config loaders, with dependency directories, and a file outside it. */
async function repo(): Promise<{ base: string; cwd: string; scratch: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "orche-ultra-handoff-")));
  dirs.push(base);
  const cwd = join(base, "repo");
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\n.venv/\n",
    [INI]: "def filter_for_env(value, name):\n    return value\n",
    [TOML]: "def unroll_refs_and_apply_substitutions(value):\n    return value\n",
    [SETS]: "class ConfigSet:\n    pass\n",
    "docs/usage.rst": "Usage\n=====\n",
    Makefile: "test:\n\tpytest\n",
    "node_modules/pkg/index.js": "module.exports = 1;\n",
    ".venv/lib/site.py": "x = 1\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  execFileSync("git", ["init", "-q"], { cwd });
  await writeFile(join(base, "outside.txt"), "outside the workspace\n");
  return { base, cwd, scratch: join(base, "scratch") };
}

/** What a scripted sub-worker reports: a status, or a whole report (summary and data, as report_result gives them). */
type Reply = string | { status: string; summary?: string; data?: unknown };
type Act = (worker: PlannedWorker) => Promise<Reply> | Reply;
type Spec = { name: string; role: string; request: string; files?: string[]; from?: string };
const w = (name: string, role: string, request: string, files?: string[]): Spec => ({ name, role, request, ...(files ? { files } : {}) });
const outcome = (worker: PlannedWorker, reply: Reply): SubWorkerOutcome => {
  const report = typeof reply === "string" ? { status: reply } : reply;
  return {
    id: worker.id, name: worker.name, role: worker.role, reason: worker.reason, status: report.status, summary: report.summary ?? `${worker.name} ${report.status}`,
    ...(report.data !== undefined ? { data: report.data } : {}), model: "p/m", modelSource: "orchestrator", requests: 1, models: {}, startedAt: Date.now(), durationMs: 1, costUSD: 0,
    // A writer in the shared workspace reports its owned files as changed (the pool's snapshot diff); candidates are diffed by UltraRun.
    changes: worker.role === "implement" && !worker.workspace ? [...(worker.files ?? [])] : [],
    ...(worker.files ? { files: worker.files } : {}), ...(worker.workspace ? { workspace: worker.workspace } : {}),
  };
};
const textOf = (result: unknown) => ((result as { content?: { type: string; text?: string }[] }).content ?? []).map(part => part.text ?? "").join("\n");

/**
 * One ultra orchestrator assignment as the worker pool builds it: UltraRun (with main's `files` as its `scope` when given) as the stage
 * contract of createSpawnTool's orche_spawn, a ledger with refs from T1, every call between beginCall (with its arguments) and endCall,
 * and its result text readable afterwards (`callText`, as the worker pool reads it from the orchestrator's session).
 */
async function orchestrator(options: { cwd?: string; scratch?: string; base?: string; carried?: UltraState; scope?: string[]; readOnly?: boolean } = {}) {
  const made = options.cwd ? { cwd: options.cwd, scratch: options.scratch!, base: options.base! } : await repo();
  const { cwd, scratch, base } = made;
  const session = {};
  const ledger = evidenceLedgerOf(session);
  ledger.tag = true;
  const events: Record<string, unknown>[] = [];
  const texts = new Map<string, string>();
  const ultra = new UltraRun({ orchestrator: "W1", cwd, readOnly: !!options.readOnly, scratch, ledger: () => ledger, callText: id => texts.get(id), verifyCommands: ["sh test/basis.sh"], ...(options.carried ? { carried: options.carried } : {}), ...(options.scope ? { scope: options.scope } : {}), onEvent: event => events.push(event) });
  const acts = new Map<string, Act>();
  const started: string[] = [];
  let sub = 0;
  let n = 0;
  const context: SpawnContext = {
    orchestrator: "W1", ultra, ...(options.scope ? { scope: options.scope } : {}), ...(options.readOnly ? { readOnly: true } : {}),
    nextId: () => { sub = Math.max(sub, subWorkerFloor(ultra.state, "W1")) + 1; ultra.state.subWorkers = sub; return `W1.${sub}`; },
    runWorker: async worker => { started.push(worker.id); return outcome(worker, await (acts.get(worker.name)?.(worker) ?? (worker.role === "verify" ? "passed" : "done"))); },
  };
  const tool = createSpawnTool(() => context, { ultra: true });
  const call = async (name: string, input: Record<string, unknown>, run: () => Promise<{ isError?: boolean; text?: string }>) => {
    const id = `c${++n}`;
    await ultra.beginCall(id, name, input);
    let isError = false;
    let text = "";
    // A tool that throws ends as an error result (Pi's behaviour), like a refusal it returns itself.
    try { const result = await run(); isError = !!result.isError; text = result.text ?? ""; } catch (error) { isError = true; text = error instanceof Error ? error.message : String(error); }
    texts.set(id, text);
    const ref = recordToolCall(session, { toolCallId: id, toolName: name, input, isError }, { request: n, atBaseline: true }).ref;
    await ultra.endCall(id);
    return { ref, isError, text };
  };
  const spawn = (reason: string, workers: Spec[], scripted: Record<string, Act> = {}, extra: Record<string, unknown> = {}) => {
    for (const [name, act] of Object.entries(scripted)) acts.set(name, act);
    const params = { reason, workers, ...extra };
    return call("orche_spawn", params, async () => {
      const result = await tool.execute(`spawn-${n}`, params as never, undefined, undefined, undefined as never);
      return { isError: !!(result as { isError?: boolean }).isError, text: textOf(result) };
    });
  };
  /** A real shell command of the orchestrator (its output is the result text); a failing exit is an error result. */
  const shell = (command: string) => call("bash", { command }, async () => { try { return { text: execSync(command, { cwd, stdio: "pipe", shell: "/bin/sh" }).toString() }; } catch { return { isError: true }; } });
  /** The orchestrator's read tool: its argument names the file. */
  const read = (path: string) => call("read", { path }, async () => ({ text: await readFile(join(cwd, path), "utf8") }));
  /** The orchestrator's grep tool over a directory: only its output (grep -rn's lines) names the files it found. */
  const grep = (pattern: string, path: string) => call("grep", { pattern, path }, async () => ({ text: execFileSync("grep", ["-rn", pattern, path], { cwd }).toString() }));
  /** What the candidate copies directory holds for candidates and rounds (nothing before an accepted candidates call). */
  const copies = async () => (await readdir(join(scratch, "ultra")).catch(() => [] as string[])).filter(name => /^(W1\.\d+|round-)/.test(name));
  return { cwd, scratch, base, ultra, spawn, shell, read, grep, events, started, copies };
}
type Run = Awaited<ReturnType<typeof orchestrator>>;

/** The analyst's report of tox-3904 B/r1 (W1.3 there), shortened: the INI cause with line ranges in its summary, the TOML sibling in its data. */
const toxReport = {
  status: "done",
  summary: [
    "The root cause is host-ISA contamination of target-environment factors, not shell quoting.",
    `- \`${INI}:18–25\` combines factors extracted from the environment name with sys.platform and the host machine.`,
    `- Registered-only lookup is explained by \`${SETS}:152–162\`; factor.py:23–25 does not normalize aliases.`,
  ].join("\n"),
  data: { evidence: [`The same unconditional union exists in TOML at \`${TOML}:46–57\`; its intended policy needs a coordinated decision.`] },
};
/** An analyst that reports only the TOML sibling. */
const tomlReport = { status: "done", summary: `The TOML loader has the same unconditional union at \`${TOML}:46–57\`.` };

/** An exploration round: a basis builder writing test/basis.sh (the protected basis) and an analyst with `report`. */
async function explore(run: Run, report: Reply = toxReport, analyst = "cause") {
  const result = await run.spawn("exploration", [w("basis", "implement", "Acceptance tests for the ISA factor selection.", ["test/"]), w(analyst, "answer", `Hypotheses for the ISA factor bug in ${TOML}, each with a falsifying check.`)], {
    basis: async () => { await mkdir(join(run.cwd, "test"), { recursive: true }); await writeFile(join(run.cwd, "test", "basis.sh"), `grep -q filter_for_env ${INI}\n`); return "done"; },
    [analyst]: () => report,
  });
  expect(result.isError).toBe(false);
  return result;
}

/** The two candidates of tox-3904 B/r1's first round: both scoped to the INI loader only. */
const iniOnly = [
  w("explicit-isa", "implement", `Fix the INI factor selection in ${INI}: explicit ISA factors of the environment name win over the host ISA.`, [INI]),
  w("parsed-isa", "implement", `Fix the INI factor selection in ${INI} by parsing the ISA from the environment name; keep additive factors.`, [INI]),
];
const dispositions = (run: Run) => (run.ultra.state.handoff?.dispositions ?? []).map(item => [item.path, item.exploration, item.disposition, ...(item.by ? [item.by] : [])]);
/** Nothing was made, run or counted by a refused call (after the exploration's two sub-workers). */
async function nothingMade(run: Run) {
  expect(run.started).toEqual(["W1.1", "W1.2"]);
  expect(run.ultra.state).toMatchObject({ candidateRounds: 0, candidates: [], subWorkers: 2 });
  expect(await run.copies()).toEqual([]);
  expect(run.ultra.state.handoff!.dispositions).toEqual([]);
}

describe("ultra hand-off: tox-3904 B/r1 replayed", () => {
  it("refuses the INI-only candidates, naming the open TOML finding with the analyst, round, excerpt and problem; nothing is copied, run or counted", async () => {
    const run = await orchestrator();
    const explored = await explore(run);
    // Recorded from the analyst's whole report (its data, not only the summary); the basis builder's test/basis.sh never counts.
    expect(run.ultra.state.handoff!.findings.map(item => [item.path, item.round, item.lines, item.analysts])).toEqual([[INI, 1, "18-25", ["W1.2"]], [SETS, 1, "152-162", ["W1.2"]], [TOML, 1, "46-57", ["W1.2"]]]);
    expect(run.ultra.state.handoff!.findings.find(item => item.path === TOML)!.excerpt).toContain("The same unconditional union exists in TOML at");
    expect(run.ultra.state.handoff!.findings.every(item => item.excerpt.length <= 200)).toBe(true);
    expect(explored.text).toContain("Ultra hand-off: the analysts' reports name 3 workspace file(s) no candidates call has disposed of yet (analyst findings).");
    expect(explored.text).toContain(`${TOML}:46-57 (W1.2, round 1)`);
    expect(explored.text).toContain("assigned (the same candidate owns it in its files and names it in its request; a mention alone or ownership alone is no transfer)");
    expect(run.events).toContainEqual(expect.objectContaining({ stage: "handoff", exploration: 1, analysts: ["W1.2"], findings: expect.arrayContaining([expect.objectContaining({ path: TOML, round: 1, lines: "46-57" })]), pending: 3 }));

    const refused = await run.spawn("candidates", iniOnly);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Refused (ultra hand-off): 2 analyst finding(s) have no accepted disposition; no copy was made, no candidate ran and no candidate round was used.");
    expect(refused.text).toContain(`- ${TOML}:46-57 (analyst W1.2, exploration round 1): "`);
    expect(refused.text).toContain("The same unconditional union exists in TOML");
    expect(refused.text).toContain(`- ${SETS}:152-162 (analyst W1.2, exploration round 1)`);
    expect(refused.text).toContain("\n  in no candidate's request or files");
    expect(refused.text).not.toContain(`- ${INI}`); // both candidates own and name it: assigned
    expect(refused.text).toContain("(1) assign it: the same candidate owns it in its files (a directory dir/ owns its files) and names it in its request");
    expect(refused.text).toContain("(2) reference: [{path, reason, evidence}] gives it to the candidates as read-only context");
    expect(refused.text).toContain("(3) excluded: [{path, reason, evidence}] leaves it out");
    expect(refused.text).toContain("whose arguments or output name the file");
    await nothingMade(run);
    expect(run.events).toContainEqual(expect.objectContaining({ stage: "handoff", candidates: 1, refused: [expect.objectContaining({ path: SETS, exploration: 1, analysts: ["W1.2"] }), expect.objectContaining({ path: TOML, exploration: 1, lines: "46-57", analysts: ["W1.2"], problems: ["in no candidate's request or files"] })] }));

    // The same round with the sibling assigned and the registry read as context: it runs as round 1 with the next ids.
    const check = await run.shell(`grep -n "class ConfigSet" ${SETS}`);
    const accepted = await run.spawn("candidates", [iniOnly[0]!, { ...iniOnly[1]!, request: `${iniOnly[1]!.request} The TOML loader has the same union at ${TOML}:46-57: fix both loaders the same way; read ${SETS} for the registered keys.`, files: [INI, TOML] }],
      {}, { reference: [{ path: SETS, reason: "Explains the registered-key lookup; nothing to change there.", evidence: [`[orche ref ${check.ref}] the registry class`] }] });
    expect(accepted.isError).toBe(false);
    expect(run.started).toEqual(["W1.1", "W1.2", "W1.3", "W1.4"]);
    expect(run.ultra.state.candidateRounds).toBe(1);
    expect(run.ultra.state.handoff!.dispositions).toEqual([
      { path: INI, exploration: 1, disposition: "assigned", by: ["W1.3", "W1.4"], round: 1 },
      { path: SETS, exploration: 1, disposition: "reference", reason: "Explains the registered-key lookup; nothing to change there.", evidence: [check.ref], round: 1 },
      { path: TOML, exploration: 1, disposition: "assigned", by: ["W1.4"], round: 1 },
    ]);
    expect(accepted.text).toContain("Ultra hand-off: 3 analyst finding(s): assigned 2, reference 1, excluded 0, out of scope 0.");
    expect(run.ultra.lines()).toContain("Ultra hand-off: 3 analyst finding(s): assigned 2, reference 1, excluded 0, out of scope 0");
    // The record keeps each disposition with the finding's provenance and the assigned candidate ids.
    expect(run.events).toContainEqual(expect.objectContaining({ stage: "handoff", candidates: 1, dispositions: expect.arrayContaining([{ path: TOML, exploration: 1, disposition: "assigned", by: ["W1.4"], round: 1, analysts: ["W1.2"], lines: "46-57", excerpt: expect.stringContaining("The same unconditional union exists in TOML") }]) }));
  });
});

describe("ultra hand-off: assigned = owned through the files and named in the request by the same candidate", () => {
  it("a path dump is no transfer: every analyst path named in the requests while the files cover only the INI site is refused, naming the TOML finding", async () => {
    const run = await orchestrator();
    await explore(run);
    const dump = `Analyst paths: ${INI}:18-25, ${SETS}:152-162, ${TOML}:46-57.`;
    const refused = await run.spawn("candidates", [{ ...iniOnly[0]!, request: `${iniOnly[0]!.request} ${dump}` }, { ...iniOnly[1]!, request: `${iniOnly[1]!.request} ${dump}` }]);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Refused (ultra hand-off): 2 analyst finding(s)");
    expect(refused.text).toContain(`- ${TOML}:46-57 (analyst W1.2, exploration round 1): "`);
    expect(refused.text).toContain("named in the request of #1 explicit-isa, #2 parsed-isa but owned by no candidate");
    expect(refused.text).toContain(`- ${SETS}:152-162`);
    expect(refused.text).not.toContain(`- ${INI}`);
    await nothingMade(run);
  });

  it("refuses a mention without ownership, ownership without a mention, and a mention by one candidate while another owns it", async () => {
    const run = await orchestrator();
    await explore(run, tomlReport);
    const cases: [ReturnType<typeof w>[], string][] = [
      [[w("a", "implement", `Fix ${INI}; compare ${TOML}.`, [INI]), w("b", "implement", `Fix ${INI} another way.`, [INI])], "named in the request of #1 a but owned by no candidate"],
      [[w("a", "implement", `Fix ${INI}.`, [INI, TOML]), w("b", "implement", `Fix ${INI} another way.`, [INI])], "owned by #1 a but named in no candidate's request"],
      [[w("a", "implement", `Fix ${INI}; compare ${TOML}.`, [INI]), w("b", "implement", `Fix ${INI} another way.`, [INI, TOML])], "named in the request of #1 a but owned only by #2 b: one candidate must both own it and name it"],
      // A directory named without / owns only that path (as in ownership); a longer path that only contains the file names nothing.
      [[w("a", "implement", `Fix ${TOML}.bak and vendor/${TOML}.`, ["src/tox/config/loader/toml", INI]), w("b", "implement", "Approach B.", ["src/tox/config/loader/toml/"])], "owned by #2 b but named in no candidate's request"],
    ];
    for (const [workers, problem] of cases) {
      const refused = await run.spawn("candidates", workers);
      expect(refused.isError, problem).toBe(true);
      expect(refused.text).toContain(`- ${TOML}:46-57 (analyst W1.2, exploration round 1): "`);
      expect(refused.text).toContain(`\n  ${problem}`);
    }
    await nothingMade(run);
  });

  it("accepts an assignment through a file, a directory scope (dir/, dir/**) or the whole workspace (./), by request text relative or absolute, and records the candidate ids", async () => {
    const run = await orchestrator();
    await explore(run);
    const accepted = await run.spawn("candidates", [
      w("a", "implement", `Fix ${INI} so explicit ISA factors win; 분석가가 지목한 ./${SETS}를 함께 확인한다.`, ["src/tox/config/"]),
      w("b", "implement", `Fix ${INI} by parsing the ISA from the name; mirror it in ${join(run.cwd, TOML)}:46-57, which has the same union.`, ["src/tox/config/loader/**"]),
    ]);
    expect(accepted.isError).toBe(false);
    expect(dispositions(run)).toEqual([[INI, 1, "assigned", ["W1.3", "W1.4"]], [SETS, 1, "assigned", ["W1.3"]], [TOML, 1, "assigned", ["W1.4"]]]);
    expect(accepted.text).toContain("Ultra hand-off: 3 analyst finding(s): assigned 3, reference 0, excluded 0, out of scope 0.");
    // "./" owns the whole workspace.
    const whole = await orchestrator();
    await explore(whole, tomlReport);
    const all = await whole.spawn("candidates", [w("a", "implement", `Fix ${TOML}.`, ["./"]), w("b", "implement", `Fix ${INI}.`, [INI])]);
    expect(all.isError).toBe(false);
    expect(dispositions(whole)).toEqual([[TOML, 1, "assigned", ["W1.3"]]]);
  });
});

describe("ultra hand-off: reference and excluded need a reason and a later own check that names the file", () => {
  /** Candidates that assign the INI file and name the TOML sibling (for a reference) without owning it; sets.py is excluded where needed. */
  const naming = [
    w("explicit-isa", "implement", `Fix ${INI}: explicit ISA factors win; read ${TOML} for the TOML side, change nothing there.`, [INI]),
    w("parsed-isa", "implement", `Fix ${INI} by parsing the ISA from the environment name.`, [INI]),
  ];

  it("a reference with a reason, a check naming the file (in its arguments or its output) and the path named in a request is read-only context, not a transfer; an exclusion likewise leaves a file out", async () => {
    const run = await orchestrator();
    await explore(run);
    const read = await run.read(TOML);
    const registry = await run.shell(`grep -n "class ConfigSet" ${SETS}`);
    const accepted = await run.spawn("candidates", naming, {}, {
      reference: [{ path: TOML, reason: "The TOML side has its own decision; the candidates read it for consistency only.", evidence: [`[orche ref ${read.ref}] read the TOML substitution`] }],
      // The same normalization as the analysts' paths: an absolute path under the workspace, with a line suffix.
      excluded: [{ path: `${join(run.cwd, SETS)}:152-162`, reason: "Only explains the registered-key lookup.", evidence: [registry.ref] }],
    });
    expect(accepted.isError).toBe(false);
    expect(run.ultra.state.handoff!.dispositions).toEqual([
      { path: INI, exploration: 1, disposition: "assigned", by: ["W1.3", "W1.4"], round: 1 },
      { path: SETS, exploration: 1, disposition: "excluded", reason: "Only explains the registered-key lookup.", evidence: [registry.ref], round: 1 },
      { path: TOML, exploration: 1, disposition: "reference", reason: "The TOML side has its own decision; the candidates read it for consistency only.", evidence: [read.ref], round: 1 },
    ]);
    expect(accepted.text).toContain("Ultra hand-off: 3 analyst finding(s): assigned 1, reference 1, excluded 1, out of scope 0.");
    expect(run.ultra.lines()).toContain("Ultra hand-off: 3 analyst finding(s): assigned 1, reference 1, excluded 1, out of scope 0");

    // Only the output of a grep over the directory names the file: that grounds it too.
    const other = await orchestrator();
    await explore(other, tomlReport);
    const found = await other.grep("def unroll", "src/tox/config/loader/");
    expect(found.text).toContain(`${TOML}:1:def unroll`);
    const byOutput = await other.spawn("candidates", naming, {}, { reference: [{ path: TOML, reason: "Context only.", evidence: [found.ref] }] });
    expect(byOutput.isError).toBe(false);
    expect(dispositions(other)).toEqual([[TOML, 1, "reference"]]);
  });

  it("refuses a reference with unrelated evidence, without evidence, without a reason, not named in any request, or with a check that failed, came first or is not its own; and an exclusion with unrelated evidence", async () => {
    const run = await orchestrator();
    const before = await run.read(TOML);
    const explored = await explore(run, tomlReport);
    const failing = await run.shell(`grep -q never-there ${TOML}`);
    expect(failing.isError).toBe(true);
    const unrelated = await run.read(INI);
    const good = await run.read(TOML);
    const reference = (entry: Record<string, unknown>, workers = naming) => run.spawn("candidates", workers, {}, { reference: [{ path: TOML, reason: "Read for consistency only.", ...entry }] });
    const hint = `(cite a successful check of yours after ${explored.ref} whose arguments or output name ${TOML})`;
    const cases: [Record<string, unknown>, string, ReturnType<typeof w>[]?][] = [
      [{ evidence: [unrelated.ref] }, `${unrelated.ref} does not name this path in its arguments or output ${hint}`],
      [{ evidence: [] }, `its evidence cites no [orche ref Tn] ${hint}`],
      [{ evidence: ["looked at it: irrelevant"] }, `its evidence cites no [orche ref Tn] ${hint}`],
      [{ evidence: [good.ref], reason: "   " }, "its reason is empty"],
      [{ evidence: [good.ref] }, "its path is named in no candidate's request", iniOnly],
      [{ evidence: [before.ref] }, `${before.ref} ran before exploration round 1 reported it ${hint}`],
      [{ evidence: [`[orche ref ${failing.ref}, failed]`] }, `${failing.ref} failed ${hint}`],
      [{ evidence: [explored.ref] }, `${explored.ref} is orche_spawn, not your own check ${hint}`],
      [{ evidence: ["T99"] }, `T99 is no call of yours ${hint}`],
    ];
    for (const [entry, problem, workers] of cases) {
      const refused = await reference(entry, workers);
      expect(refused.isError, problem).toBe(true);
      expect(refused.text).toContain(`- ${TOML}:46-57 (analyst W1.2, exploration round 1)`);
      expect(refused.text).toContain(`reference not accepted: ${problem}`);
    }
    const unrelatedExclusion = await run.spawn("candidates", iniOnly, {}, { excluded: [{ path: TOML, reason: "The TOML loader is not part of this fix.", evidence: [unrelated.ref] }] });
    expect(unrelatedExclusion.text).toContain(`\n  in no candidate's request or files; excluded not accepted: ${unrelated.ref} does not name this path in its arguments or output ${hint}`);
    const both = await run.spawn("candidates", naming, {}, { reference: [{ path: TOML, reason: "Context.", evidence: [good.ref] }], excluded: [{ path: TOML, reason: "Out.", evidence: [good.ref] }] });
    expect(both.text).toContain("listed in both reference and excluded: give it one disposition");
    // An entry for a file no analyst reported is named as ignored; the open finding still refuses.
    const stray = await run.spawn("candidates", iniOnly, {}, { excluded: [{ path: "docs/usage.rst", reason: "docs", evidence: [good.ref] }], reference: [{ path: "Makefile", reason: "build", evidence: [good.ref] }] });
    expect(stray.text).toContain("Ignored reference entries (no open analyst finding): Makefile.");
    expect(stray.text).toContain("Ignored excluded entries (no open analyst finding): docs/usage.rst.");
    await nothingMade(run);
    // A grounded, relevant exclusion is accepted.
    const accepted = await run.spawn("candidates", iniOnly, {}, { excluded: [{ path: TOML, reason: "The TOML loader is not part of this fix.", evidence: [unrelated.ref, good.ref] }] });
    expect(accepted.isError).toBe(false);
    expect(run.ultra.state.handoff!.dispositions).toEqual([{ path: TOML, exploration: 1, disposition: "excluded", reason: "The TOML loader is not part of this fix.", evidence: [good.ref], round: 1 }]);
    expect(run.started).toEqual(["W1.1", "W1.2", "W1.3", "W1.4"]);
  });
});

describe("ultra hand-off: the assignment's write scope", () => {
  it("records a reported file outside main's files as out of scope without asking the candidates for it, and never lets them own it", async () => {
    const run = await orchestrator({ scope: ["src/tox/config/loader/ini/", "test/"] });
    const explored = await explore(run);
    expect(explored.text).toContain(`Your next candidates call is refused unless each of these is assigned (the same candidate owns it in its files and names it in its request; a mention alone or ownership alone is no transfer), or listed in its reference [{path, reason, evidence}] (read-only context, also named in a candidate's request) or excluded [{path, reason, evidence}], the evidence citing your own successful check (read, grep, bash) after the exploration round that reported the file, whose arguments or output name it: ${INI}:18-25 (W1.2, round 1).`);
    expect(explored.text).toContain(`Outside your write scope (recorded as out of scope, not required of the candidates): ${SETS}, ${TOML}.`);
    // Asking a candidate to own the out-of-scope sibling stays refused by the write scope (nothing pushes toward it).
    const outside = await run.spawn("candidates", [iniOnly[0]!, { ...iniOnly[1]!, request: `${iniOnly[1]!.request} Also ${TOML}.`, files: [INI, TOML] }]);
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain(`would own ${TOML} outside your own write scope`);
    expect(run.ultra.state.handoff!.dispositions).toEqual([]);
    // The in-scope finding still needs a real assignment: ownership alone is refused.
    const ownedOnly = await run.spawn("candidates", [w("a", "implement", "Approach A.", [INI]), w("b", "implement", "Approach B.", [INI])]);
    expect(ownedOnly.text).toContain(`- ${INI}:18-25 (analyst W1.2, exploration round 1)`);
    expect(ownedOnly.text).toContain("owned by #1 a, #2 b but named in no candidate's request");
    expect(ownedOnly.text).not.toContain(`- ${TOML}`);
    expect(ownedOnly.text).toContain("Files outside your write scope are recorded as out of scope automatically and are not listed; never give a candidate files outside your write scope.");
    const accepted = await run.spawn("candidates", iniOnly);
    expect(accepted.isError).toBe(false);
    expect(dispositions(run)).toEqual([[INI, 1, "assigned", ["W1.3", "W1.4"]], [SETS, 1, "out-of-scope"], [TOML, 1, "out-of-scope"]]);
    expect(accepted.text).toContain(`Ultra hand-off: 3 analyst finding(s): assigned 1, reference 0, excluded 0, out of scope 2 (outside the assignment's write scope, not required of the candidates: ${SETS}, ${TOML}).`);
    expect(run.ultra.lines()).toContain(`Ultra hand-off: 3 analyst finding(s): assigned 1, reference 0, excluded 0, out of scope 2 (outside the assignment's write scope, not required of the candidates: ${SETS}, ${TOML})`);
  });
});

describe("ultra hand-off: what is recorded", () => {
  it("empty findings impose nothing", async () => {
    const run = await orchestrator();
    const explored = await explore(run, { status: "done", summary: "The host ISA leaks into the factor selection; no file was named.", data: { evidence: ["python -c 'import sysconfig' -> ok"] } });
    expect(explored.text).not.toContain("Ultra hand-off:");
    expect(run.ultra.state.handoff).toEqual({ findings: [], dispositions: [] });
    const accepted = await run.spawn("candidates", [w("a", "implement", "Approach A.", [INI]), w("b", "implement", "Approach B.", [INI])]);
    expect(accepted.isError).toBe(false);
    expect(accepted.text).toContain("Ultra hand-off: 0 analyst finding(s): assigned 0, reference 0, excluded 0, out of scope 0.");
    expect(run.ultra.lines()).toContain("Ultra hand-off: 0 analyst finding(s): assigned 0, reference 0, excluded 0, out of scope 0");
  });

  it("counts only existing regular workspace files from finished analysts' own reports: not missing, outside, ignored, protected or linked-out paths", async () => {
    const run = await orchestrator();
    await mkdir(join(run.cwd, ".orche", "artifacts"), { recursive: true });
    await writeFile(join(run.cwd, ".orche", "artifacts", "grep.txt"), `${TOML}\n`);
    await symlink(run.base, join(run.cwd, "bridge")); // a link out of the workspace
    await symlink(join(run.base, "outside.txt"), join(run.cwd, "link-out.txt"));
    const noisy = {
      status: "done",
      summary: [
        `Checked ./Makefile and ${join(run.cwd, "docs/usage.rst")}:4; a bare usage.rst or factor.py names no workspace path.`,
        `Not files: src/tox/config/loader/missing.py:3, src/tox/config/loader/ (a directory), ../outside.txt, ${join(run.base, "outside.txt")}.`,
        `Elsewhere: node_modules/pkg/index.js, .venv/lib/site.py, .git/config, .orche/artifacts/grep.txt, test/basis.sh, ${join(run.scratch, "ultra", "W1.3", INI)}, bridge/outside.txt, link-out.txt.`,
      ].join("\n"),
    };
    await run.spawn("exploration", [w("basis", "implement", "Acceptance tests.", ["test/"]), w("cause", "answer", `Hypotheses; start at ${SETS}.`), w("skeptic", "answer", "Try to refute the hypotheses.")], {
      // The basis builder's report and a blocked analyst's report name files too: neither is an analyst's finished report.
      basis: async () => { await mkdir(join(run.cwd, "test"), { recursive: true }); await writeFile(join(run.cwd, "test", "basis.sh"), "true\n"); return { status: "done", summary: `test/basis.sh checks ${INI}` }; },
      cause: () => noisy,
      skeptic: () => ({ status: "blocked", summary: `Could not finish; ${TOML} looked related.` }),
    });
    expect(run.ultra.state.protectedPaths).toEqual(["test/"]);
    expect(run.ultra.state.handoff!.findings).toEqual([
      { path: "Makefile", round: 1, analysts: ["W1.2"], excerpt: expect.stringContaining("Checked ./Makefile") },
      { path: "docs/usage.rst", round: 1, lines: "4", analysts: ["W1.2"], excerpt: expect.stringContaining("docs/usage.rst:4") },
    ]);
  });

  it("read-only (answer) ultra: naming in an answer candidate's request suffices, files mean nothing, and excluded works as in a write run", async () => {
    const run = await orchestrator({ readOnly: true });
    await run.spawn("exploration", [w("sources", "answer", "Find the sources of the ISA factor selection."), w("cause", "answer", "Hypotheses for the ISA factor bug.")], { cause: () => toxReport });
    expect(run.ultra.state.handoff!.findings.map(item => item.path)).toEqual([INI, SETS, TOML]);
    const refused = await run.spawn("candidates", [w("a", "answer", `Explain the INI selection in ${INI}.`, [SETS, TOML]), w("b", "answer", `Explain the INI selection in ${INI} from the tests.`)]);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`- ${SETS}:152-162`);
    expect(refused.text).toContain(`- ${TOML}:46-57`);
    expect(refused.text).toContain("\n  named in no candidate's request");
    expect(refused.text).toContain("Resolve each in this call: (1) name its path in at least one candidate's request");
    expect(refused.text).not.toContain("owns it in its files");
    const check = await run.read(SETS);
    const accepted = await run.spawn("candidates", [w("a", "answer", `Explain the INI selection in ${INI}.`), w("b", "answer", `Explain whether ${TOML} has the same union as ${INI}.`)], {}, { excluded: [{ path: SETS, reason: "The registry is not part of the question.", evidence: [check.ref] }] });
    expect(accepted.isError).toBe(false);
    expect(dispositions(run)).toEqual([[INI, 1, "assigned", ["W1.3", "W1.4"]], [SETS, 1, "excluded"], [TOML, 1, "assigned", ["W1.4"]]]);
    expect(accepted.text).toContain("Ultra hand-off: 3 analyst finding(s): assigned 2, reference 0, excluded 1, out of scope 0.");
  });

  it("a later exploration round that reports an assigned file again makes a new finding: the next candidates call must dispose of it, an earlier check does not ground it, and a fix candidate takes it by the same rule", async () => {
    const run = await orchestrator();
    await explore(run);
    const first = await run.spawn("candidates", [w("a", "implement", `Fix ${INI} and ${SETS}.`, [INI, SETS]), w("b", "implement", `Fix ${INI} and ${TOML} together.`, [INI, TOML])], {
      a: async worker => { await writeFile(join(worker.workspace!, INI), "def filter_for_env(value, name):\n    return name\n"); return "done"; },
      b: async worker => { await writeFile(join(worker.workspace!, TOML), "def unroll_refs_and_apply_substitutions(value):\n    return value.strip()\n"); return "done"; },
    });
    expect(first.isError).toBe(false);
    expect(dispositions(run)).toEqual([[INI, 1, "assigned", ["W1.3", "W1.4"]], [SETS, 1, "assigned", ["W1.3"]], [TOML, 1, "assigned", ["W1.4"]]]);
    const early = await run.read(TOML);
    const round2 = await run.spawn("exploration", [w("recheck", "answer", "Re-examine the TOML side."), w("other", "answer", "Other angles.")], { recheck: () => ({ status: "done", summary: `Still: ${TOML}:46–57 needs the same policy.` }) });
    expect(round2.isError).toBe(false);
    expect(run.ultra.state.handoff!.findings.filter(item => item.path === TOML).map(item => [item.round, item.analysts])).toEqual([[1, ["W1.2"]], [2, ["W1.5"]]]);
    expect(run.events).toContainEqual(expect.objectContaining({ stage: "handoff", exploration: 2, reportedAgain: [TOML], pending: 1 }));
    expect(round2.text).toContain(`${TOML}:46-57 (W1.5, round 2)`);
    expect(run.ultra.lines()).toContain("Ultra hand-off: 4 analyst finding(s): assigned 3, reference 0, excluded 0, out of scope 0, not yet disposed 1");
    // The earlier assignment does not discharge it: a fix round that does not assign it is refused.
    const fixes = [{ ...w("fix-a", "implement", `Fix W1.3's ${INI} from its failure evidence.`, [INI]), from: "W1.3" }, w("fresh", "implement", `Another approach for ${INI}.`, [INI])];
    const refused = await run.spawn("candidates", fixes);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`Refused (ultra hand-off): 1 analyst finding(s)`);
    expect(refused.text).toContain(`- ${TOML}:46-57 (analyst W1.5, exploration round 2)`);
    // A check from before round 2 grounds no reference of the round-2 finding.
    const stale = await run.spawn("candidates", [{ ...fixes[0]!, request: `${fixes[0]!.request} Read ${TOML} for consistency.` }, fixes[1]!], {}, { reference: [{ path: TOML, reason: "Context.", evidence: [early.ref] }] });
    expect(stale.text).toContain(`${early.ref} ran before exploration round 2 reported it`);
    expect(run.ultra.state.candidateRounds).toBe(1);
    // A fix candidate (from W1.4) that owns and names it takes it.
    const accepted = await run.spawn("candidates", [{ ...w("fix-b", "implement", `Fix W1.4's ${TOML} from its failure evidence.`, [INI, TOML]), from: "W1.4" }, fixes[1]!]);
    expect(accepted.isError).toBe(false);
    expect(run.ultra.state.candidateRounds).toBe(2);
    expect(run.ultra.state.handoff!.dispositions.at(-1)).toEqual({ path: TOML, exploration: 2, disposition: "assigned", by: ["W1.7"], round: 2 });
    expect(run.ultra.lines()).toContain("Ultra hand-off: 4 analyst finding(s): assigned 4, reference 0, excluded 0, out of scope 0");
  });

  it("a continuation carries findings and dispositions: carried open ones still bind, disposed ones need nothing, a later round's findings must be disposed", async () => {
    // Assignment 1: exploration only, then the time cap.
    const first = await orchestrator();
    await explore(first);
    await first.ultra.end(false);
    const carried = structuredClone(first.ultra.state);
    expect(carried.handoff!.findings.map(item => [item.path, item.round])).toEqual([[INI, 1], [SETS, 1], [TOML, 1]]);
    // Assignment 2 (same worker and task): the carried findings still bind; a carried round dates from before every call (ref 0).
    const second = await orchestrator({ cwd: first.cwd, scratch: first.scratch, base: first.base, carried });
    expect(second.ultra.state.handoff).toEqual(carried.handoff);
    expect(second.ultra.lines()).toContain("Ultra hand-off: 3 analyst finding(s): assigned 0, reference 0, excluded 0, out of scope 0, not yet disposed 3");
    const refused = await second.spawn("candidates", iniOnly);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`- ${TOML}:46-57 (analyst W1.2, exploration round 1)`);
    // Any check of this assignment that names the file grounds a carried finding; one that names neither file grounds nothing.
    const unrelated = await second.shell(`grep -n def ${INI}`);
    const unrelatedRefusal = await second.spawn("candidates", iniOnly, {}, { excluded: [TOML, SETS].map(path => ({ path, reason: "Outside the INI selection this request is about.", evidence: [unrelated.ref] })) });
    expect(unrelatedRefusal.text).toContain(`excluded not accepted: ${unrelated.ref} does not name this path in its arguments or output (cite a successful check of yours whose arguments or output name ${TOML})`);
    const check = await second.shell(`grep -n def ${TOML} ${SETS}`);
    const accepted = await second.spawn("candidates", iniOnly, {}, { excluded: [TOML, SETS].map(path => ({ path, reason: "Outside the INI selection this request is about.", evidence: [check.ref] })) });
    expect(accepted.isError).toBe(false);
    expect(dispositions(second)).toEqual([[INI, 1, "assigned", ["W1.3", "W1.4"]], [SETS, 1, "excluded"], [TOML, 1, "excluded"]]);
    await second.ultra.end(false);
    // Assignment 3: a second exploration round reports the TOML file again (a new finding of round 2) and docs/usage.rst.
    const third = await orchestrator({ cwd: first.cwd, scratch: first.scratch, base: first.base, carried: structuredClone(second.ultra.state) });
    expect(third.ultra.state.handoff).toEqual(second.ultra.state.handoff);
    const early = await third.shell("cat docs/usage.rst");
    const round2 = await third.spawn("exploration", [w("docs", "answer", "Where is the ISA factor documented?"), w("toml", "answer", "Does the TOML loader share the bug?")], {
      docs: () => ({ status: "done", summary: "docs/usage.rst:1-2 documents the factor conditions." }),
      toml: () => ({ status: "done", summary: `Yes: ${TOML}:46–57 has the same union.` }),
    });
    expect(round2.isError).toBe(false);
    expect(round2.text).toContain("Ultra hand-off: the analysts' reports name 2 workspace file(s) no candidates call has disposed of yet");
    expect(third.ultra.state.handoff!.findings.filter(item => item.round === 2)).toEqual([
      { path: "docs/usage.rst", round: 2, lines: "1-2", analysts: ["W1.5"], excerpt: expect.any(String) },
      { path: TOML, round: 2, lines: "46-57", analysts: ["W1.6"], excerpt: expect.any(String) },
    ]);
    const second2 = [w("fix-a", "implement", `Fix ${INI} again: explicit ISA factors win.`, [INI]), w("fix-b", "implement", `Fix ${INI} again: parse the ISA; align ${TOML} with it.`, [INI, TOML])];
    const open = await third.spawn("candidates", second2.map(item => ({ ...item, request: item.request.replace(` align ${TOML} with it.`, "") })));
    expect(open.isError).toBe(true);
    expect(open.text).toContain("Refused (ultra hand-off): 2 analyst finding(s)");
    expect(open.text).toContain("- docs/usage.rst:1-2 (analyst W1.5, exploration round 2)");
    expect(open.text).toContain(`- ${TOML}:46-57 (analyst W1.6, exploration round 2)`);
    // This round's finding needs a check after its own exploration round: one made before it does not count.
    const stale = await third.spawn("candidates", second2, {}, { excluded: [{ path: "docs/usage.rst", reason: "Documentation only.", evidence: [early.ref] }] });
    expect(stale.text).toContain(`${early.ref} ran before exploration round 2 reported it`);
    const read = await third.shell("cat docs/usage.rst");
    const done = await third.spawn("candidates", second2, {}, { excluded: [{ path: "docs/usage.rst", reason: "Documentation only.", evidence: [read.ref] }] });
    expect(done.isError).toBe(false);
    expect(third.ultra.state.candidateRounds).toBe(2);
    expect(dispositions(third)).toEqual([[INI, 1, "assigned", ["W1.3", "W1.4"]], [SETS, 1, "excluded"], [TOML, 1, "excluded"], ["docs/usage.rst", 2, "excluded"], [TOML, 2, "assigned", ["W1.8"]]]);
    expect(third.ultra.state.handoff!.dispositions.find(item => item.path === "docs/usage.rst")).toEqual({ path: "docs/usage.rst", exploration: 2, disposition: "excluded", reason: "Documentation only.", evidence: [read.ref], round: 2 });
    expect(third.ultra.lines()).toContain("Ultra hand-off: 5 analyst finding(s): assigned 2, reference 0, excluded 3, out of scope 0");
    expect(await readFile(join(third.cwd, "docs/usage.rst"), "utf8")).toBe("Usage\n=====\n");
  });
});

describe("ultra hand-off: tools and prompt", () => {
  it("strong/single and MDSD orche_spawn schemas and behaviour are unchanged; reference and excluded are ultra-only and for candidates only", async () => {
    const properties = (schema: unknown) => (schema as { properties: Record<string, { items?: { properties: Record<string, unknown> } }> }).properties;
    const plain = createSpawnTool(() => "unused");
    const mdsd = createSpawnTool(() => "unused", { mdsd: true });
    const ultra = createSpawnTool(() => "unused", { ultra: true });
    expect(Object.keys(properties(plain.parameters))).toEqual(["reason", "workers"]);
    expect(Object.keys(properties(plain.parameters).workers!.items!.properties)).toEqual(["name", "role", "request", "files"]);
    expect(Object.keys(properties(mdsd.parameters))).toEqual(["reason", "workers", "plan", "adapt"]);
    expect(Object.keys(properties(mdsd.parameters).workers!.items!.properties)).toEqual(["name", "role", "request", "files", "strategy"]);
    expect(JSON.stringify(plain.parameters)).toBe(JSON.stringify(spawnParametersFor(4)));
    expect(JSON.stringify(mdsd.parameters)).toBe(JSON.stringify(mdsdSpawnParametersFor(4)));
    for (const tool of [plain, mdsd]) { expect(JSON.stringify(tool.parameters)).not.toContain("excluded"); expect(JSON.stringify(tool.parameters)).not.toContain('"reference"'); }
    expect(Object.keys(properties(ultra.parameters))).toEqual(["reason", "workers", "excluded", "reference"]);
    expect(Object.keys(properties(ultra.parameters).excluded!.items!.properties)).toEqual(["path", "reason", "evidence"]);
    expect(Object.keys(properties(ultra.parameters).reference!.items!.properties)).toEqual(["path", "reason", "evidence"]);
    // Outside ultra unknown excluded/reference change nothing (as before); in ultra they belong to a candidates call.
    let n = 0;
    expect(planSpawn({ reason: "parallelism", workers: [{ name: "a", role: "answer", request: "x" }, { name: "b", role: "answer", request: "y" }], excluded: [], reference: [] } as never, { nextId: () => `W1.${++n}` }).workers).toHaveLength(2);
    expect(planSpawn({ reason: "parallelism", workers: [{ name: "a", role: "implement", request: "x", files: ["a.py"] }, { name: "b", role: "implement", request: "y", files: ["b.py"] }], reference: [{ path: "a.py", reason: "r", evidence: ["T1"] }] } as never, { mdsd: true, nextId: () => `W1.${++n}` }).workers).toHaveLength(2);
    const run = await orchestrator();
    for (const [key, message] of [["excluded", 'excluded (analyst-reported files left out of the candidates, each with a reason and evidence) belongs to reason "candidates" only.'], ["reference", 'reference (analyst-reported files the candidates get as read-only context, each with a reason and evidence) belongs to reason "candidates" only.']] as const) {
      const refused = await run.spawn("exploration", [w("basis", "implement", "Acceptance tests.", ["test/"]), w("cause", "answer", "Hypotheses.")], {}, { [key]: [{ path: TOML, reason: "x", evidence: ["T1"] }] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(message);
    }
    expect(run.ultra.state.explorationRounds).toBe(0);
  });

  // The round-1 runtime as frozen for the stage-3 study (results/ is local, not versioned): the strong/single and MDSD schemas are byte for byte its.
  it.skipIf(!existsSync(FROZEN_SPAWN))("strong/single and MDSD orche_spawn schemas equal the frozen round-1 runtime's (results/ultra-ho/stage3/rt-handoff)", async () => {
    const frozen = await import(FROZEN_SPAWN) as typeof import("../../src/orchestrator/spawn.js");
    for (const max of [2, 4, 8]) {
      expect(JSON.stringify(spawnParametersFor(max))).toBe(JSON.stringify(frozen.spawnParametersFor(max)));
      expect(JSON.stringify(mdsdSpawnParametersFor(max))).toBe(JSON.stringify(frozen.mdsdSpawnParametersFor(max)));
    }
  });

  it("the ultra prompt states the enforced rule (implement: owned and named by the same candidate, reference, excluded, out of scope; answer: named or excluded), with no file named", () => {
    const implement = ultraSection(false);
    expect(implement).toContain("Hand-off (enforced): each existing workspace file a finished exploration analyst names in its report is a finding of that exploration round.");
    expect(implement).toContain("assign it (the same candidate owns the file in its files, a directory dir/ owning its files, and names it in its request with what to do; a mention without ownership, or ownership without a mention, is no transfer)");
    expect(implement).toContain("reference [{path, reason, evidence}] (read-only context, also named in a candidate's request) or excluded [{path, reason, evidence}], the evidence citing a successful check of yours made after that exploration round whose arguments or output name the file");
    expect(implement).toContain("Files outside your assignment's write scope are recorded as out of scope: never give them to a candidate.");
    expect(implement).toContain("A later round that reports the same file makes a new finding.");
    const answer = ultraSection(true);
    expect(answer).toContain("must name each pending finding's file in at least one candidate's request, or list it in that orche_spawn call's excluded [{path, reason, evidence}]");
    expect(answer).not.toContain("reference [");
    for (const text of [implement, answer]) expect(text).not.toMatch(/tox|_replace\.py|factor\.py/);
  });

  it("the worker pool reads an orchestrator's tool result from its session for the relevance test (src/extension/workers.ts)", () => {
    const session = { messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "x" } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "grep", content: [{ type: "text", text: `${TOML}:1:def x` }, { type: "image", data: "…" }, { type: "text", text: "[orche ref T4]" }], isError: false },
      { role: "toolResult", toolCallId: "c2", toolName: "bash", content: "plain text", isError: false },
    ] };
    expect(toolResultText(session, "c1")).toBe(`${TOML}:1:def x\n[orche ref T4]`);
    expect(toolResultText(session, "c2")).toBe("plain text");
    expect(toolResultText(session, "c3")).toBeUndefined();
  });
});
