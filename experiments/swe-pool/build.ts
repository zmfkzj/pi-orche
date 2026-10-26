/**
 * Round-2 SWE task pool P2 (results/cb-ab/PROTOCOL-R2.md "Pool P2"): set up the first 48 D1∧D2 records of
 * results/swe-pool/r2/prescreen.json exactly as experiments/advisor-reviewer/setup-swe.ts sets up a task, but into
 * fixtures/advisor-bench/swe-r2/<fixtureId>/ and results/advisor-reviewer/cache/swe-r2/<fixtureId>/ (the old pool is only read).
 * Model-free. The fixture id is the instance id, as setup-swe.ts names it (interface tasks' dataset ids end in `_interface`).
 *
 *   npx tsx experiments/swe-pool/build.ts --list
 *   npx tsx experiments/swe-pool/build.ts --scratch <dir> --fidelity <old-pool id> [...]   (setup-swe.ts equivalence check, scratch only)
 *   npx tsx experiments/swe-pool/build.ts --scratch <dir> [--concurrency 3]
 *
 * Per record (setup-swe.ts `setup`): hidden/test.patch, reference/fix.patch; src/ = `git archive` of the base commit fetched with
 * `git fetch --depth 1` (no history) plus the build-generated .py files the package needs; venv/ = Python virtualenv with the
 * dataset's install command made non-editable exactly as setup-swe.ts transforms it, pip removed, read-only; task.json with
 * setup-swe.ts's fields; validation with the hidden tests applied: every FAIL_TO_PASS test fails on base and passes with the reference
 * fix (D4); PASS_TO_PASS tests failing with the reference fix are excluded and listed.
 *
 * Schedule (no effect on any outcome): setups run concurrently (at most 4), then every validation runs alone, in pool order.
 * A network failure of a setup is retried once; every other failure is recorded with its reason and makes the record D4 = false.
 * Per record: results/swe-pool/r2/logs/<fixtureId>.log and results/swe-pool/r2/build/<fixtureId>.{setup,validation}.json (written
 * once; a rerun after an interruption continues with the records that have none, and never retries a recorded failure). When all 48
 * are done: results/swe-pool/r2/pool.json and README.md (written once, never overwritten).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchStatus, sweLayout } from "../advisor-reviewer/tasks.js";
import { CommandError, Log, MemoryGovernor, diskAvailable, gitArchive, isNetworkFailure, killActive, memAvailable, removeTree, run, runSweTests, sh } from "./env.js";
import { POOL_SEED, PRESCREEN_OUT, REPO, STAGE3_SEED, readRecords, seededOrder, sha256Hex, type PrescreenEntry, type RawRecord } from "./prescreen.js";

export const POOL_SIZE = 48;
export const TRANCHE_SIZE = 20;
export const STAGE3_SIZE = 10;
export const FIXTURES_R2 = "fixtures/advisor-bench/swe-r2";
export const CACHE_R2 = "results/advisor-reviewer/cache/swe-r2";
export const OUT_R2 = "results/swe-pool/r2";
/** pip / build temp files of the install step: on disk next to the venv (removed after the install), not on the tmpfs /tmp. */
export const INSTALL_TMP = "tmp.install";
export const MAX_CONCURRENCY = 4;

/** setup-swe.ts names a fixture by the instance id. */
export const fixtureIdOf = (id: string): string => id;

/** The first `size` D1∧D2 entries of the prescreen, in pool order. */
export function selectBuild(entries: readonly PrescreenEntry[], size = POOL_SIZE): PrescreenEntry[] {
  return [...entries].sort((a, b) => a.order - b.order).filter(entry => entry.d1 && entry.d2).slice(0, size);
}

/** The dataset's install command as setup-swe.ts transforms it: non-editable, without --root-user-action=ignore. */
export const transformInstall = (install: unknown): string => String(install).replace(/(pip install[^&;]*?)\s-e\s+/g, "$1 ").replace(/--root-user-action=ignore/g, "");

/** task.json fields known before the environment exists, in setup-swe.ts's order. */
export function manifestOf(raw: RawRecord): any {
  const r = raw.record;
  const testCmd: string = r.install_config.test_cmd;
  const testFiles = [...new Set(testCmd.split(/\s+/).filter((part: string) => /\.py$/.test(part)))];
  return {
    id: fixtureIdOf(raw.id), title: r.problem_statement.split("\n")[0].replace(/^#+\s*/, "").slice(0, 120), repo: r.repo, baseCommit: r.base_commit, createdAt: r.created_at,
    problemStatement: r.problem_statement, interface: r.interface || "", failToPass: r.FAIL_TO_PASS, passToPass: r.PASS_TO_PASS, testFiles,
    testCmd, datasetInstall: r.install_config.install, datasetPython: r.install_config.python,
    source: { dataset: "SWE-rebench (nebius/SWE-rebench, 2026 releases)", file: raw.recordFile, recordSha256: raw.recordSha256 },
  };
}

export interface Roots {
  /** Where <fixtureId>/{task.json,hidden,reference} go. */
  fixtures: string;
  /** Where <fixtureId>/{src,venv} go (and get-pip.py). */
  cache: string;
  /** Throwaway build and validation copies. */
  scratch: string;
}

/** A failure of one named step of a setup or validation. */
export class StepError extends Error {
  constructor(readonly step: string, readonly error: unknown) { super(`${step}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw error instanceof StepError ? error : new StepError(name, error); }
}

/** The short reason of a failure (its step and the end of the failing command's error output) and whether the network caused it. */
export function describeFailure(error: unknown): { step: string; reason: string; network: boolean; message: string } {
  const stepName = error instanceof StepError ? error.step : "harness";
  const cause = error instanceof StepError ? error.error : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  let detail: string;
  if (cause instanceof CommandError) {
    const tail = cause.stderr.trim().split("\n").slice(-12).join("\n").slice(-900);
    detail = `${cause.timedOut ? "timed out" : `exit ${cause.code ?? cause.signal}`}${tail ? `: ${tail}` : ""}`;
  } else detail = message.slice(0, 900);
  return { step: stepName, reason: `${stepName}: ${detail}`, network: isNetworkFailure(message), message };
}

/** setup-swe.ts `setup` up to the first task.json write (fixture patches, source snapshot, virtualenv); returns the manifest. */
export async function setupRecord(raw: RawRecord, roots: Roots, log: Log, governor?: MemoryGovernor): Promise<any> {
  const r = raw.record;
  const id = fixtureIdOf(raw.id);
  const fixture = join(roots.fixtures, id), cache = join(roots.cache, id);
  await step("fixture", async () => {
    await mkdir(join(fixture, "hidden"), { recursive: true });
    await mkdir(join(fixture, "reference"), { recursive: true });
    await writeFile(join(fixture, "hidden/test.patch"), r.test_patch);
    await writeFile(join(fixture, "reference/fix.patch"), r.patch);
  });
  const manifest = manifestOf(raw);

  // Source snapshot of the base commit, without history.
  if (!existsSync(join(cache, "src"))) {
    const clone = join(cache, "clone");
    await removeTree(clone);
    await mkdir(clone, { recursive: true });
    try {
      await step("fetch", async () => {
        await sh("git init -q && git remote add origin https://github.com/" + r.repo + ".git", clone, log);
        await sh(`git fetch -q --depth 1 origin ${r.base_commit}`, clone, log);
      });
      await step("archive", async () => {
        await removeTree(join(cache, "src.tmp"));
        await mkdir(join(cache, "src.tmp"), { recursive: true });
        await gitArchive(clone, r.base_commit, join(cache, "src.tmp"), log);
      });
    } finally { await removeTree(clone); }
    await rename(join(cache, "src.tmp"), join(cache, "src"));
  }
  // Virtualenv: the dataset's install command, non-editable, from a throwaway copy of the source.
  if (!existsSync(join(cache, "venv/.ready"))) {
    await step("venv", async () => {
      if (existsSync(join(cache, "venv"))) await sh(`chmod -R u+w venv && rm -rf venv`, cache, log);
      await sh("python3 -m venv --without-pip venv", cache, log);
    });
    const getPip = join(roots.cache, "get-pip.py");
    await step("get-pip", async () => {
      if (!existsSync(getPip)) await sh(`curl -sSf -m 120 https://bootstrap.pypa.io/get-pip.py -o ${getPip}`, roots.cache, log);
      await sh(`venv/bin/python ${getPip} -q`, cache, log);
    });
    const build = await mkdtemp(join(roots.scratch, "swe-build-"));
    const installTmp = join(cache, INSTALL_TMP);
    try {
      await step("install", async () => {
        await cp(join(cache, "src"), build, { recursive: true });
        await removeTree(installTmp);
        await mkdir(installTmp, { recursive: true });
        // setuptools-scm and friends need a version without git metadata.
        const env = { ...process.env, PATH: `${join(cache, "venv/bin")}:${process.env.PATH}`, SETUPTOOLS_SCM_PRETEND_VERSION: "0.0.0+bench", PIP_DISABLE_PIP_VERSION_CHECK: "1", TMPDIR: installTmp };
        const install = transformInstall(r.install_config.install);
        manifest.install = install;
        await sh(install, build, log, { env, governor, label: id });
      });
      await step("generated-files", async () => {
        // Files the build generated inside the package (absent from the source): copy them into the snapshot.
        const layout = sweLayout(join(cache, "src"));
        const site = (await sh(`venv/bin/python -c "import sysconfig;print(sysconfig.get_paths()['purelib'])"`, cache, log)).trim();
        const generated: string[] = [];
        for (const dist of readdirSync(site).filter(name => name.endsWith(".dist-info"))) {
          const recordFile = join(site, dist, "RECORD");
          if (!existsSync(recordFile)) continue;
          for (const line of readFileSync(recordFile, "utf8").split("\n")) {
            const path = line.split(",")[0];
            if (!path || path.includes(".dist-info/") || path.startsWith("..") || !path.endsWith(".py")) continue;
            const top = path.split("/")[0]!;
            if (!existsSync(join(cache, "src", layout, top))) continue;
            if (!existsSync(join(cache, "src", layout, path))) { await mkdir(dirname(join(cache, "src", layout, path)), { recursive: true }); await cp(join(site, path), join(cache, "src", layout, path)); generated.push(join(layout, path)); }
          }
        }
        manifest.generatedFiles = generated;
        manifest.pythonPath = layout;
        if (generated.length) log.note(`generated files copied into src: ${generated.join(", ")}`);
      });
    } finally { await removeTree(build); await removeTree(installTmp); }
    // No pip inside the environment the models use (dependencies are fixed; nothing may be downloaded), then read-only.
    await step("seal-venv", async () => {
      await sh("venv/bin/python -m pip uninstall -y -q pip", cache, log);
      await sh("chmod -R a-w venv", cache, log);
      await sh("chmod u+w venv && touch venv/.ready && chmod u-w venv", cache, log);
    });
  } else {
    const previous = JSON.parse(await readFile(join(fixture, "task.json"), "utf8").catch(() => "{}"));
    manifest.install = previous.install; manifest.generatedFiles = previous.generatedFiles ?? []; manifest.pythonPath = previous.pythonPath ?? sweLayout(join(cache, "src"));
    log.note("venv/.ready exists: environment reused (setup-swe.ts rerun semantics)");
  }
  manifest.pythonVersion = (await step("python-version", () => sh("venv/bin/python --version", cache, log))).trim();
  await writeFile(join(fixture, "task.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** setup-swe.ts `summarize`: the status of every FAIL_TO_PASS and PASS_TO_PASS test, and the counts. */
export function summarize(manifest: { failToPass: string[]; passToPass: string[] }, statuses: Map<string, string>): { status: Record<string, string>; counts: Record<string, number> } {
  const status: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const id of [...manifest.failToPass, ...manifest.passToPass]) {
    const value = matchStatus(statuses, id);
    status[id] = value;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return { status, counts };
}

export interface VariantResult { ms: number; status: Record<string, string>; counts: Record<string, number>; exit: number | null }

/** setup-swe.ts's validation verdict from the base and reference runs (pure). */
export function verdict(manifest: { failToPass: string[]; passToPass: string[] }, base: VariantResult, reference: VariantResult) {
  const f2pFailBase = manifest.failToPass.every(t => base.status[t] !== "PASSED");
  const f2pPassRef = manifest.failToPass.every(t => reference.status[t] === "PASSED");
  const excludedPassToPass = manifest.passToPass.filter(t => reference.status[t] !== "PASSED");
  return {
    f2pFailBase, f2pPassRef, excludedPassToPass,
    f2pPassingOnBase: manifest.failToPass.filter(t => base.status[t] === "PASSED"),
    f2pNotPassingWithReference: manifest.failToPass.filter(t => reference.status[t] !== "PASSED").map(t => ({ test: t, status: reference.status[t] ?? "MISSING" })),
  };
}

/** setup-swe.ts's validation: starting code vs reference fix, both with the hidden tests; task.json gets the result. */
export async function validateRecord(manifest: any, roots: Roots, log: Log) {
  const fixture = join(roots.fixtures, manifest.id), cache = join(roots.cache, manifest.id);
  const results: Partial<Record<"base" | "reference", VariantResult>> = {};
  for (const variant of ["base", "reference"] as const) {
    const copy = await mkdtemp(join(roots.scratch, `swe-${variant}-`));
    try {
      await step(`${variant}-copy`, () => cp(join(cache, "src"), copy, { recursive: true }));
      if (variant === "reference") await step("apply-fix", () => run("git", ["apply", "--whitespace=nowarn", join(fixture, "reference/fix.patch")], copy, log));
      await step(`${variant}-apply-tests`, () => run("git", ["apply", "--whitespace=nowarn", join(fixture, "hidden/test.patch")], copy, log));
      const started = Date.now();
      const result = await step(`${variant}-tests`, () => runSweTests(manifest, join(cache, "venv"), copy, join(copy, ".bench-bin"), log));
      results[variant] = { ms: Date.now() - started, ...summarize(manifest, result.statuses), exit: result.exit };
    } finally { await removeTree(copy); }
  }
  const base = results.base!, reference = results.reference!;
  const outcome = verdict(manifest, base, reference);
  manifest.excludedPassToPass = outcome.excludedPassToPass;
  manifest.validation = {
    at: new Date().toISOString(), valid: outcome.f2pFailBase && outcome.f2pPassRef, f2pFailOnBase: outcome.f2pFailBase, f2pPassWithReference: outcome.f2pPassRef,
    base: { ms: base.ms, counts: base.counts }, reference: { ms: reference.ms, counts: reference.counts },
    excludedPassToPass: manifest.excludedPassToPass.length,
  };
  await writeFile(join(fixture, "task.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  log.note(`${manifest.id}: valid=${manifest.validation.valid} f2p ${manifest.failToPass.length} p2p ${manifest.passToPass.length} excluded ${manifest.excludedPassToPass.length} (${manifest.pythonVersion}, ${Math.round(reference.ms / 1000)}s)`);
  return { manifest, base, reference, outcome };
}

export interface ListRecord { id: string; fixtureId: string; order: number; d4Valid: boolean; interface: boolean; multiFile: boolean }

/**
 * The derived lists. stage1.T1: the first 20 D4-valid records without interface text, in pool order; stage1.T2: the next 20 such
 * records (possibly fewer) (PROTOCOL-R2.md "Tranches"). stage3.pool: the first 10 D4-valid multiFile records (interface allowed) in
 * order of sha256("ultra-ho-r2-2026-10-24:" + id) ascending (stage3-r2/PREREGISTRATION.md "Calibration").
 */
export function deriveLists(records: readonly ListRecord[]) {
  const inOrder = [...records].sort((a, b) => a.order - b.order);
  const withoutInterface = inOrder.filter(record => record.d4Valid && !record.interface);
  const multiFile = inOrder.filter(record => record.d4Valid && record.multiFile);
  const byId = new Map(multiFile.map(record => [record.id, record]));
  const ranking = seededOrder(multiFile.map(record => record.id), STAGE3_SEED).map((id, index) => ({ rank: index + 1, fixtureId: byId.get(id)!.fixtureId, sha256: sha256Hex(STAGE3_SEED + id) }));
  return {
    stage1: {
      rule: "T1 = the first 20 d4Valid records without interface text, in pool order; T2 = the next 20 such records (possibly fewer)",
      eligible: withoutInterface.length,
      T1: withoutInterface.slice(0, TRANCHE_SIZE).map(record => record.fixtureId),
      T2: withoutInterface.slice(TRANCHE_SIZE, 2 * TRANCHE_SIZE).map(record => record.fixtureId),
    },
    stage3: {
      rule: `pool = the first 10 d4Valid multiFile records (interface allowed) in order of sha256("${STAGE3_SEED}" + id) ascending`,
      seed: STAGE3_SEED,
      eligible: multiFile.length,
      pool: ranking.slice(0, STAGE3_SIZE).map(item => item.fixtureId),
      ranking,
    },
  };
}

// ---- state of a build ----------------------------------------------------------------------------------------------------------------

interface Attempt { attempt: number; startedAt: string; endedAt: string; ok: boolean; step?: string; reason?: string; network?: boolean }
interface SetupState { id: string; fixtureId: string; order: number; startedAt: string; endedAt: string; ok: boolean; attempts: Attempt[]; reason: string | null; manifestSha256?: string }
interface ValidationState {
  id: string; fixtureId: string; startedAt: string; endedAt: string; ok: boolean; reason: string | null; step?: string;
  validation?: any; excludedPassToPass?: string[]; f2pPassingOnBase?: string[]; f2pNotPassingWithReference?: { test: string; status: string }[];
  base?: VariantResult; reference?: VariantResult;
}

const writeOnce = (path: string, value: unknown): void => { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); };
const readJson = <T>(path: string): T | undefined => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined);
const fileSha = (path: string): string | null => (existsSync(path) ? sha256Hex(readFileSync(path)) : null);

async function forEachConcurrent<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const item = items[next++]!; await work(item); }
  }));
}

const GiB = 2 ** 30;
async function waitForResources(paths: { scratch: string; cache: string }, log: (text: string) => void, label: string): Promise<void> {
  const deadline = Date.now() + 30 * 60_000;
  let warned = false;
  while (Date.now() < deadline) {
    const memory = memAvailable(), scratch = diskAvailable(paths.scratch), cache = diskAvailable(paths.cache);
    if (memory >= 4 * GiB && scratch >= 2 * GiB && cache >= 20 * GiB) return;
    if (!warned) { log(`${label}: waiting for resources (MemAvailable ${(memory / GiB).toFixed(1)} GiB, scratch ${(scratch / GiB).toFixed(1)} GiB, cache disk ${(cache / GiB).toFixed(1)} GiB)`); warned = true; }
    await new Promise(done => setTimeout(done, 15_000));
  }
  log(`${label}: resources still low after 30 min; starting anyway`);
}

/** get-pip.py into the cache root once (setup-swe.ts's curl command; a partial download never stays behind). */
async function ensureGetPip(cacheRoot: string, log: Log): Promise<void> {
  const target = join(cacheRoot, "get-pip.py");
  if (existsSync(target)) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await sh(`curl -sSf -m 120 https://bootstrap.pypa.io/get-pip.py -o ${target}.part`, cacheRoot, log);
      await rename(`${target}.part`, target);
      return;
    } catch (error) {
      await removeTree(`${target}.part`);
      if (attempt === 2 || !isNetworkFailure(String(error instanceof Error ? error.message : error))) throw error;
      log.note("get-pip.py: network failure, retrying once");
    }
  }
}

function checkScratch(scratch: string | undefined): string {
  if (!scratch) throw new Error("--scratch <dir> is required (throwaway build and validation copies)");
  const dir = resolve(scratch);
  if (!isAbsolute(scratch) || dir === "/tmp" || dir === "/" || !relative(REPO, dir).startsWith("..")) throw new Error(`--scratch ${scratch}: must be an absolute directory outside the repository and not /tmp itself`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function notInsideGitWorkTree(dir: string): Promise<void> {
  // Build and validation copies must not be inside a git work tree (git apply and version plugins would see it).
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], dir, new Log("/dev/null")).then(() => true, () => false);
  if (inside) throw new Error(`${dir} is inside a git work tree`);
}

function setOomScoreAdj(value: number): void {
  // This build's processes are the first the kernel kills under memory pressure, never another session's.
  try { writeFileSync("/proc/self/oom_score_adj", String(value)); } catch { /* not Linux or not permitted */ }
}

/** `batch` 1: the first POOL_SIZE D1∧D2 records in pool order; batch 2 (PROTOCOL-R2 amendment R2-A2): the next POOL_SIZE. */
function loadSelection(repo: string, batch = 1): { prescreenSha256: string; selected: PrescreenEntry[]; records: Map<string, RawRecord> } {
  const path = join(repo, PRESCREEN_OUT);
  const text = readFileSync(path, "utf8");
  const document = JSON.parse(text);
  const selected = selectBuild(document.entries as PrescreenEntry[], batch * POOL_SIZE).slice((batch - 1) * POOL_SIZE);
  if (selected.length !== POOL_SIZE) throw new Error(`${selected.length} D1∧D2 records in batch ${batch} of the prescreen; ${POOL_SIZE} needed`);
  const records = new Map(readRecords(repo).map(item => [item.id, item]));
  for (const entry of selected) {
    const raw = records.get(entry.id);
    if (!raw || raw.recordSha256 !== entry.recordSha256 || raw.recordFile !== entry.recordFile) throw new Error(`${entry.id}: the record differs from the prescreen's`);
  }
  return { prescreenSha256: sha256Hex(text), selected, records };
}

// ---- the build ----------------------------------------------------------------------------------------------------------------------

interface Paths { fixtures: string; cache: string; out: string; build: string; logs: string }
const pathsOf = (repo: string): Paths => ({ fixtures: join(repo, FIXTURES_R2), cache: join(repo, CACHE_R2), out: join(repo, OUT_R2), build: join(repo, OUT_R2, "build"), logs: join(repo, OUT_R2, "logs") });

async function setupPhase(selected: readonly PrescreenEntry[], records: Map<string, RawRecord>, roots: Roots, paths: Paths, concurrency: number, say: (text: string) => void): Promise<void> {
  const pending = selected.filter(entry => !existsSync(join(paths.build, `${fixtureIdOf(entry.id)}.setup.json`)));
  say(`setup: ${pending.length} of ${selected.length} records pending, concurrency ${concurrency}`);
  const governor = new MemoryGovernor(2.5 * GiB, 5 * GiB, say);
  governor.start();
  try {
    await forEachConcurrent(pending, concurrency, async entry => {
      const fixtureId = fixtureIdOf(entry.id);
      const log = new Log(join(paths.logs, `${fixtureId}.log`));
      await waitForResources({ scratch: roots.scratch, cache: roots.cache }, say, fixtureId);
      const startedAt = new Date().toISOString();
      const attempts: Attempt[] = [];
      let manifest: any;
      say(`setup start #${entry.order} ${fixtureId}`);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const attemptStart = new Date().toISOString();
        log.note(`==== setup ${fixtureId} (pool order ${entry.order}), attempt ${attempt}`);
        try {
          manifest = await setupRecord(records.get(entry.id)!, roots, log, governor);
          attempts.push({ attempt, startedAt: attemptStart, endedAt: new Date().toISOString(), ok: true });
          break;
        } catch (error) {
          const failure = describeFailure(error);
          attempts.push({ attempt, startedAt: attemptStart, endedAt: new Date().toISOString(), ok: false, step: failure.step, reason: failure.reason, network: failure.network });
          log.note(`setup failed (${failure.network ? "network" : "not network"}) at ${failure.reason}`);
          if (!failure.network || attempt === 2) break;
          log.note("network failure: retrying the setup once");
        }
      }
      const last = attempts[attempts.length - 1]!;
      const state: SetupState = {
        id: entry.id, fixtureId, order: entry.order, startedAt, endedAt: new Date().toISOString(), ok: last.ok, attempts,
        reason: last.ok ? null : `setup failed at ${last.reason}`, ...(last.ok ? { manifestSha256: fileSha(join(roots.fixtures, fixtureId, "task.json"))! } : {}),
      };
      writeOnce(join(paths.build, `${fixtureId}.setup.json`), state);
      say(`setup ${state.ok ? "done" : "FAILED"} #${entry.order} ${fixtureId}${state.ok ? ` (${manifest?.pythonVersion})` : `: ${state.reason?.split("\n")[0]}`}`);
    });
  } finally { governor.stop(); }
}

async function validationPhase(selected: readonly PrescreenEntry[], roots: Roots, paths: Paths, say: (text: string) => void): Promise<void> {
  for (const entry of selected) {
    const fixtureId = fixtureIdOf(entry.id);
    const setup = readJson<SetupState>(join(paths.build, `${fixtureId}.setup.json`));
    const target = join(paths.build, `${fixtureId}.validation.json`);
    if (!setup?.ok || existsSync(target)) continue;
    const log = new Log(join(paths.logs, `${fixtureId}.log`));
    const startedAt = new Date().toISOString();
    log.note(`==== validation ${fixtureId} (pool order ${entry.order})`);
    say(`validation start #${entry.order} ${fixtureId}`);
    let state: ValidationState;
    try {
      const manifest = JSON.parse(await readFile(join(roots.fixtures, fixtureId, "task.json"), "utf8"));
      const { base, reference, outcome } = await validateRecord(manifest, roots, log);
      const problems = [
        ...(outcome.f2pFailBase ? [] : [`F2P passing on base: ${outcome.f2pPassingOnBase.join(", ")}`]),
        ...(outcome.f2pPassRef ? [] : [`F2P not passing with the reference fix: ${outcome.f2pNotPassingWithReference.map(item => `${item.test} ${item.status}`).join(", ")}`]),
      ];
      state = {
        id: entry.id, fixtureId, startedAt, endedAt: new Date().toISOString(), ok: true, reason: problems.length ? `invalid: ${problems.join("; ")}`.slice(0, 1500) : null,
        validation: manifest.validation, excludedPassToPass: manifest.excludedPassToPass, f2pPassingOnBase: outcome.f2pPassingOnBase, f2pNotPassingWithReference: outcome.f2pNotPassingWithReference, base, reference,
      };
    } catch (error) {
      const failure = describeFailure(error);
      log.note(`validation failed at ${failure.reason}`);
      state = { id: entry.id, fixtureId, startedAt, endedAt: new Date().toISOString(), ok: false, step: failure.step, reason: `validation failed at ${failure.reason}` };
    }
    writeOnce(target, state);
    say(`validation #${entry.order} ${fixtureId}: ${state.ok && state.validation?.valid ? "VALID" : state.reason?.split("\n")[0]}`);
  }
}

export interface PoolRecord extends ListRecord {
  built: boolean;
  validation: null | { valid: boolean; f2pFailOnBase: boolean; f2pPassWithReference: boolean; failToPass: number; passToPass: number; excludedPassToPass: number; base: { counts: Record<string, number>; ms: number; exit: number | null }; reference: { counts: Record<string, number>; ms: number; exit: number | null }; at: string };
  reason: string | null;
  setupAttempts: number;
  networkRetry: boolean;
  sha256: { taskJson: string | null; testPatch: string | null; fixPatch: string | null };
}

function poolRecords(selected: readonly PrescreenEntry[], paths: Paths): PoolRecord[] | undefined {
  const out: PoolRecord[] = [];
  for (const entry of selected) {
    const fixtureId = fixtureIdOf(entry.id);
    const setup = readJson<SetupState>(join(paths.build, `${fixtureId}.setup.json`));
    if (!setup) return undefined;
    const checked = setup.ok ? readJson<ValidationState>(join(paths.build, `${fixtureId}.validation.json`)) : undefined;
    if (setup.ok && !checked) return undefined;
    const manifest = setup.ok ? JSON.parse(readFileSync(join(paths.fixtures, fixtureId, "task.json"), "utf8")) : undefined;
    const v = checked?.ok ? checked.validation : undefined;
    out.push({
      id: entry.id, fixtureId, order: entry.order, multiFile: entry.multiFile, interface: entry.interface,
      built: setup.ok, d4Valid: Boolean(v?.valid),
      validation: v ? {
        valid: v.valid, f2pFailOnBase: v.f2pFailOnBase, f2pPassWithReference: v.f2pPassWithReference, failToPass: manifest.failToPass.length, passToPass: manifest.passToPass.length, excludedPassToPass: v.excludedPassToPass,
        base: { counts: v.base.counts, ms: v.base.ms, exit: checked!.base?.exit ?? null }, reference: { counts: v.reference.counts, ms: v.reference.ms, exit: checked!.reference?.exit ?? null }, at: v.at,
      } : null,
      reason: setup.ok ? checked!.reason : setup.reason,
      setupAttempts: setup.attempts.length, networkRetry: setup.attempts.length > 1,
      sha256: { taskJson: fileSha(join(paths.fixtures, fixtureId, "task.json")), testPatch: fileSha(join(paths.fixtures, fixtureId, "hidden/test.patch")), fixPatch: fileSha(join(paths.fixtures, fixtureId, "reference/fix.patch")) },
    });
  }
  return out;
}

const md = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n+/g, " ");

export function renderReadme(pool: any, prescreenCounts: any, fidelity: any | undefined): string {
  const records = pool.records as PoolRecord[];
  const count = (test: (record: PoolRecord) => boolean) => records.filter(test).length;
  const lines: string[] = [];
  lines.push("# SWE task pool P2 (round 2)", "");
  lines.push(`Built ${pool.builtAt} under \`results/cb-ab/PROTOCOL-R2.md\` "Pool P2" (stage-3 list: \`results/ultra-ho/stage3-r2/PREREGISTRATION.md\` "Calibration"). Deterministic and model-free: no model call of any kind; no judgement of task content beyond the mechanical rules.`, "");
  lines.push("## Commands", "", "```", ...pool.commands, "```", "");
  lines.push("## Counts", "");
  lines.push("| screen | records |", "|---|---|");
  lines.push(`| SWE-rebench 2026 records (\`rebench-2026_0{1,2,3}.jsonl\`) | ${prescreenCounts.records} |`);
  lines.push(`| already set up in \`fixtures/advisor-bench/swe\` (excluded) | ${prescreenCounts.excluded} |`);
  lines.push(`| pool after exclusion (expected ${prescreenCounts.expectedPool}) | ${prescreenCounts.pool} |`);
  lines.push(`| D1 (FAIL_TO_PASS and problem statement non-empty) | ${prescreenCounts.d1} |`);
  lines.push(`| D2 (≥ 2 hunks in non-test Python source) | ${prescreenCounts.d2} |`);
  lines.push(`| D1 ∧ D2 | ${prescreenCounts.d1d2} (multiFile ${prescreenCounts.d1d2MultiFile}, interface ${prescreenCounts.d1d2Interface}) |`);
  lines.push(`| set up: the first ${POOL_SIZE} D1 ∧ D2 in pool order (orders ${records[0]?.order}–${records[records.length - 1]?.order}) | ${records.length} (multiFile ${count(r => r.multiFile)}, interface ${count(r => r.interface)}) |`);
  lines.push(`| built (environment complete) | ${count(r => r.built)} |`);
  lines.push(`| D4-valid (F2P fail on base, pass with the reference fix) | ${count(r => r.d4Valid)} (without interface ${count(r => r.d4Valid && !r.interface)}, with interface ${count(r => r.d4Valid && r.interface)}, multiFile ${count(r => r.d4Valid && r.multiFile)}) |`, "");
  lines.push("## Lists", "");
  lines.push(`- **stage1.T1** (${pool.stage1.T1.length}; ${pool.stage1.rule}): ${pool.stage1.T1.map((id: string) => `\`${id}\``).join(", ") || "none"}`);
  lines.push(`- **stage1.T2** (${pool.stage1.T2.length}): ${pool.stage1.T2.map((id: string) => `\`${id}\``).join(", ") || "none"}`);
  lines.push(`- **stage3.pool** (${pool.stage3.pool.length}; ${pool.stage3.rule}): ${pool.stage3.pool.map((id: string) => `\`${id}\``).join(", ") || "none"}`, "");
  lines.push("## Records", "", "| order | fixture id | multiFile | interface | built | D4 | validation (base → reference) / reason |", "|---|---|---|---|---|---|---|");
  for (const record of records) {
    const v = record.validation;
    const detail = v ? `F2P ${v.failToPass}, P2P ${v.passToPass} (excluded ${v.excludedPassToPass}); base ${JSON.stringify(v.base.counts)} → reference ${JSON.stringify(v.reference.counts)}${record.reason ? `; ${record.reason}` : ""}` : record.reason ?? "";
    lines.push(`| ${record.order} | \`${record.fixtureId}\` | ${record.multiFile ? "yes" : ""} | ${record.interface ? "yes" : ""} | ${record.built ? "yes" : "**no**"} | ${record.d4Valid ? "**valid**" : "no"} | ${md(detail).slice(0, 700)} |`);
  }
  lines.push("", "## Failures (D4 = false) with reasons", "");
  const failed = records.filter(record => !record.d4Valid);
  if (!failed.length) lines.push("None.");
  for (const record of failed) lines.push(`- #${record.order} \`${record.fixtureId}\`${record.built ? "" : " (not built)"}: ${md(record.reason ?? "invalid").slice(0, 1200)}`);
  lines.push("", "## Method", "");
  for (const note of pool.method as string[]) lines.push(`- ${note}`);
  if (fidelity) {
    lines.push("", "## Equivalence check against setup-swe.ts (old-pool records rebuilt in scratch)", "");
    for (const item of fidelity.records) lines.push(`- \`${item.id}\`: ${item.identical ? "task.json identical to the old fixture except the run-specific fields" : `differences: ${item.differences.map((d: any) => `${d.field} (new ${JSON.stringify(d.mine)}, old ${JSON.stringify(d.old)})`).join("; ")}`}; patches identical: ${item.patchesIdentical}`);
  }
  lines.push("", "## Wall time", "", `${pool.wallTime.note}`, "");
  lines.push("## Files", "", "- `prescreen.json`: every one of the pool's records with its D1/D2 decision and reason.", "- `pool.json`: the 48 set-up records and the derived lists.", "- `build/<fixtureId>.setup.json`, `build/<fixtureId>.validation.json`: per-record setup attempts and validation (per-test statuses).", "- `logs/<fixtureId>.log`: every command of the record with its output; `logs/_run.log`: the schedule.", `- Fixtures: \`${FIXTURES_R2}/<fixtureId>/\`; environments: \`${CACHE_R2}/<fixtureId>/{src,venv}\`.`);
  return `${lines.join("\n")}\n`;
}

const METHOD = [
  "Each record is set up by the steps of `experiments/advisor-reviewer/setup-swe.ts` (`experiments/swe-pool/build.ts setupRecord`/`validateRecord`): the same commands (git init/fetch --depth 1/archive, `python3 -m venv --without-pip`, get-pip.py, the dataset install command transformed by setup-swe.ts's regex, the generated-files copy, pip uninstall, chmod), the same task.json fields and the same validation (tasks.ts `matchStatus`; `pythonWrappers`/`runSweTests` re-implemented with an explicit venv path, same scripts and command).",
  "Location-only differences: fixtures in `fixtures/advisor-bench/swe-r2/`, environments in `results/advisor-reviewer/cache/swe-r2/`; throwaway build and validation copies in the worker's scratch directory instead of `os.tmpdir()`; pip/build temporary files of the install step in `<cache>/<fixtureId>/tmp.install` (TMPDIR, on disk, removed after the install) instead of the tmpfs `/tmp`.",
  "Schedule-only differences: setups ran concurrently (see the command); every validation ran afterwards, alone, in pool order. A memory governor could pause (SIGSTOP) the newest concurrent install while MemAvailable < 2.5 GiB (see `logs/_run.log`); paused time did not count against the 30-min limit. Every command ran in its own process group, killed when the command ended.",
  "Retries: a setup failure classified as a network failure (`env.ts isNetworkFailure`) was retried once; every other failure is recorded with its reason and makes the record D4 = false. No record was patched by hand.",
];

async function fidelityCheck(ids: readonly string[], scratch: string, records: Map<string, RawRecord>, outFile: string): Promise<number> {
  if (existsSync(outFile)) { console.error(`${relative(REPO, outFile)} exists; refusing to overwrite`); return 1; }
  const base = join(scratch, "fidelity");
  const roots: Roots = { fixtures: join(base, "fixtures"), cache: join(base, "cache"), scratch: join(base, "work") };
  for (const dir of [roots.fixtures, roots.cache, roots.scratch, join(base, "logs")]) mkdirSync(dir, { recursive: true });
  const say = (text: string) => console.log(`[${new Date().toISOString()}] ${text}`);
  await ensureGetPip(roots.cache, new Log(join(base, "logs", "_get-pip.log")));
  const results: any[] = [];
  for (const id of ids) {
    const raw = records.get(id);
    const oldDir = join(REPO, "fixtures/advisor-bench/swe", id);
    if (!raw || !existsSync(join(oldDir, "task.json"))) throw new Error(`${id}: not an old-pool record`);
    const log = new Log(join(base, "logs", `${id}.log`));
    say(`fidelity ${id}: setup`);
    const started = Date.now();
    let mine: any;
    try {
      await setupRecord(raw, roots, log);
      ({ manifest: mine } = await validateRecord(JSON.parse(readFileSync(join(roots.fixtures, id, "task.json"), "utf8")), roots, log));
    } catch (error) { results.push({ id, error: describeFailure(error).reason }); say(`fidelity ${id}: failed ${describeFailure(error).reason}`); continue; }
    const old = JSON.parse(readFileSync(join(oldDir, "task.json"), "utf8"));
    const differences = compareManifests(mine, old);
    const patchesIdentical = ["hidden/test.patch", "reference/fix.patch"].every(file => fileSha(join(roots.fixtures, id, file)) === fileSha(join(oldDir, file)));
    results.push({ id, seconds: Math.round((Date.now() - started) / 1000), identical: differences.length === 0, differences, patchesIdentical, keyOrderIdentical: JSON.stringify(Object.keys(mine)) === JSON.stringify(Object.keys(old)) });
    say(`fidelity ${id}: ${differences.length ? `${differences.length} difference(s)` : "identical"}; patches identical ${patchesIdentical}`);
  }
  writeOnce(outFile, { checkedAt: new Date().toISOString(), note: "old-pool records rebuilt with build.ts into scratch and compared with fixtures/advisor-bench/swe/<id>/task.json; run-specific fields (validation.at, validation.*.ms) are not compared", records: results });
  return 0;
}

/** Fields of two task.json documents that differ, run-specific ones (validation.at, *.ms) left out. */
export function compareManifests(mine: any, old: any): { field: string; mine: unknown; old: unknown }[] {
  const strip = (manifest: any) => {
    const copy = JSON.parse(JSON.stringify(manifest));
    if (copy.validation) { delete copy.validation.at; delete copy.validation.base?.ms; delete copy.validation.reference?.ms; }
    return copy;
  };
  const a = strip(mine), b = strip(old);
  const out: { field: string; mine: unknown; old: unknown }[] = [];
  const walk = (x: any, y: any, prefix: string) => {
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])]) walk(x[key], y[key], prefix ? `${prefix}.${key}` : key);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field: prefix, mine: x, old: y });
  };
  walk(a, b, "");
  return out;
}

function parseArgs(argv: readonly string[]): { scratch?: string; concurrency: number; fidelity: string[]; list: boolean; batch: number } {
  const out = { scratch: undefined as string | undefined, concurrency: 3, fidelity: [] as string[], list: false, batch: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--scratch") out.scratch = argv[++i];
    else if (arg === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (arg === "--list") out.list = true;
    else if (arg === "--batch") out.batch = Number(argv[++i]);
    else if (arg === "--fidelity") { while (argv[i + 1] && !argv[i + 1]!.startsWith("--")) out.fidelity.push(argv[++i]!); }
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > MAX_CONCURRENCY) throw new Error(`--concurrency must be 1..${MAX_CONCURRENCY}`);
  if (out.batch !== 1 && out.batch !== 2) throw new Error("--batch must be 1 or 2 (2: PROTOCOL-R2 amendment R2-A2)");
  return out;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const { prescreenSha256, selected, records } = loadSelection(REPO, args.batch);
  if (args.list) {
    for (const entry of selected) console.log(`${entry.order}\t${fixtureIdOf(entry.id)}\tmultiFile=${entry.multiFile}\tinterface=${entry.interface}`);
    return 0;
  }
  const scratch = checkScratch(args.scratch);
  await notInsideGitWorkTree(scratch);
  setOomScoreAdj(1000);
  const stopAll = () => { killActive(); process.exit(130); };
  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);
  process.once("exit", () => killActive());
  if (args.fidelity.length) return fidelityCheck(args.fidelity, scratch, records, join(REPO, OUT_R2, "fidelity.json"));

  const paths = pathsOf(REPO);
  const suffix = args.batch === 1 ? "" : `-batch${args.batch}`;
  const poolFile = join(paths.out, `pool${suffix}.json`), readmeFile = join(paths.out, `README${suffix}.md`);
  if (existsSync(poolFile) || existsSync(readmeFile)) { console.error(`${OUT_R2}/pool${suffix}.json or README${suffix}.md exists; the pool is frozen, refusing to run`); return 1; }
  for (const dir of [paths.fixtures, paths.cache, paths.build, paths.logs]) mkdirSync(dir, { recursive: true });
  const roots: Roots = { fixtures: paths.fixtures, cache: paths.cache, scratch: join(scratch, "build") };
  mkdirSync(roots.scratch, { recursive: true });
  const runLog = new Log(join(paths.logs, `_run${suffix}.log`));
  const say = (text: string) => { const line = `[${new Date().toISOString()}] ${text}`; console.log(line); runLog.write(line); };
  say(`build start: ${selected.length} records (pool orders ${selected[0]!.order}-${selected[selected.length - 1]!.order}), prescreen sha256 ${prescreenSha256}, scratch ${roots.scratch}, concurrency ${args.concurrency}, argv ${JSON.stringify(argv)}`);
  await ensureGetPip(paths.cache, runLog);
  say(`get-pip.py sha256 ${fileSha(join(paths.cache, "get-pip.py"))}`);
  await setupPhase(selected, records, roots, paths, args.concurrency, say);
  await validationPhase(selected, roots, paths, say);

  const built = poolRecords(selected, paths);
  if (!built) { say("not every record is done; rerun to continue"); return 1; }
  const states = selected.flatMap(entry => [readJson<SetupState>(join(paths.build, `${fixtureIdOf(entry.id)}.setup.json`)), readJson<ValidationState>(join(paths.build, `${fixtureIdOf(entry.id)}.validation.json`))]).filter(Boolean) as { startedAt: string; endedAt: string }[];
  const first = states.map(state => state.startedAt).sort()[0]!, last = states.map(state => state.endedAt).sort().at(-1)!;
  const lists = deriveLists(built);
  const prescreenDoc = JSON.parse(readFileSync(join(REPO, PRESCREEN_OUT), "utf8"));
  const pool = {
    builtAt: new Date().toISOString(),
    protocol: { pool: 'results/cb-ab/PROTOCOL-R2.md "Pool P2"', stage3: 'results/ultra-ho/stage3-r2/PREREGISTRATION.md "Calibration"' },
    seeds: { pool: POOL_SEED, stage3: STAGE3_SEED },
    prescreen: { path: PRESCREEN_OUT, sha256: prescreenSha256, counts: prescreenDoc.counts },
    batch: args.batch,
    selection: args.batch === 1 ? `the first ${POOL_SIZE} D1∧D2 records in pool order` : `D1∧D2 records ${POOL_SIZE + 1}-${2 * POOL_SIZE} in pool order (PROTOCOL-R2 amendment R2-A2); its stage1.T1 list is the amended T2, its other lists are not used`,
    fixtures: FIXTURES_R2, cache: CACHE_R2,
    environment: { python: built.find(record => record.built) ? JSON.parse(readFileSync(join(paths.fixtures, built.find(record => record.built)!.fixtureId, "task.json"), "utf8")).pythonVersion : null, getPipSha256: fileSha(join(paths.cache, "get-pip.py")) },
    commands: [
      "npx tsx experiments/swe-pool/prescreen.ts",
      "npx tsx experiments/swe-pool/build.ts --list",
      ...(existsSync(join(paths.out, "fidelity.json")) ? ["npx tsx experiments/swe-pool/build.ts --scratch <scratch> --fidelity <old-pool ids>   (equivalence check; fidelity.json)"] : []),
      `npx tsx experiments/swe-pool/build.ts --scratch <scratch> --concurrency ${args.concurrency}`,
    ],
    method: METHOD,
    wallTime: { firstStart: first, lastEnd: last, note: `setup and validation of the 48 records: ${first} → ${last} (${((Date.parse(last) - Date.parse(first)) / 60_000).toFixed(1)} min)` },
    counts: { records: built.length, built: built.filter(r => r.built).length, d4Valid: built.filter(r => r.d4Valid).length, d4ValidWithoutInterface: built.filter(r => r.d4Valid && !r.interface).length, d4ValidWithInterface: built.filter(r => r.d4Valid && r.interface).length, d4ValidMultiFile: built.filter(r => r.d4Valid && r.multiFile).length, networkRetries: built.filter(r => r.networkRetry).length },
    records: built,
    ...lists,
    ...(args.batch === 2 ? { r2a2: { rule: "T2 = the first 20 D4-valid records without interface text among the next 48 D1∧D2 records in pool order", T2: lists.stage1.T1 } } : {}),
  };
  writeOnce(poolFile, pool);
  writeFileSync(readmeFile, renderReadme(pool, prescreenDoc.counts, readJson(join(paths.out, "fidelity.json"))), { flag: "wx" });
  say(`pool.json and README.md written: built ${pool.counts.built}, d4Valid ${pool.counts.d4Valid}; T1 ${lists.stage1.T1.length}, T2 ${lists.stage1.T2.length}, stage3 ${lists.stage3.pool.length}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.stack : error); killActive(); process.exit(1); });
}
