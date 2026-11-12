/**
 * Environment of the stage evaluation (experiments/stage-eval): frozen orche runtimes (one per stage label), the private agent
 * dir of a run, the Pi invocation shared by every arm, and the task workspaces / independent grader reused from
 * experiments/ultra-ab/env.ts (original tests and runner config restored, hidden tests added, integrity checked).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MODEL, THINKING, orcheConfig, type Kind, type Rates } from "./protocol.js";

import { gradeWorkspace as gradeCode, loadTask as loadCode, type Task } from "../ultra-ab/env.js";
import { IMAGE_INSTRUCTION, IMAGE_TASK_ID, gradeImage } from "./image-task.js";
import type { Integrity } from "./protocol.js";

export { prepareWorkspace, pythonWrappers, textFiles, type Task } from "../ultra-ab/env.js";

export const REPO = process.env.STAGE_EVAL_REPO ?? new URL("../../", import.meta.url).pathname;
export const AGENT = join(homedir(), ".pi/agent");
/** The provider every arm needs to reach CLIProxyAPI: the oh-my-pi-extensions bundle of the official provider (model access only). */
export const PROVIDER_BUNDLE = process.env.STAGE_EVAL_PROVIDER ?? join(REPO, "../cliproxyapi/src/index.ts");
export const UPSTREAM = "http://127.0.0.1:8317";
/** The generated image task (image-task.ts buildFixture), outside every workspace. */
export const IMAGE_FIXTURE = process.env.STAGE_EVAL_IMAGE_FIXTURE ?? join(REPO, "results/stage-eval/fixtures", IMAGE_TASK_ID);

/** A suite / SWE task (ultra-ab loader) or the live image task. */
export async function loadTask(id: string): Promise<Task> {
  if (id === IMAGE_TASK_ID) {
    if (!existsSync(join(IMAGE_FIXTURE, "hidden/truth.json"))) throw new Error(`${id}: build the fixture first (image-task.ts ${IMAGE_FIXTURE})`);
    return { id, kind: "image" as never, title: "Read a 16-frame console recording", instruction: IMAGE_INSTRUCTION, dir: IMAGE_FIXTURE, source: join(IMAGE_FIXTURE, "repo"), manifest: {} };
  }
  return loadCode(id);
}

/** Independent grade: the ultra-ab grader for code tasks, exact report.json comparison for the image task (integrity: nothing to protect). */
export async function gradeWorkspace(task: Task, workspace: string): Promise<{ grade: { passed: boolean; error?: string; checks: Record<string, { passed: boolean; detail: string }> }; integrity: Integrity }> {
  if ((task.kind as string) === "image") return { grade: await gradeImage(task.dir, workspace), integrity: { violations: [], suspicious: [] } };
  return gradeCode(task, workspace);
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).toString();

/** Catalog rates of the models a run may use, read from the user's provider catalog (copied into each run's agent dir too). */
export function catalogRates(file = join(AGENT, "cliproxyapi-models.json")): Record<string, Rates> {
  const catalog = JSON.parse(readFileSync(file, "utf8"));
  const out: Record<string, Rates> = {};
  for (const model of catalog.models ?? []) if (model?.id && model.cost) out[model.id] = { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, ...(model.cost.tiers ? { tiers: model.cost.tiers } : {}) };
  return out;
}

/** The private agent dir of one run: provider catalog and connection (base URL = this run's proxy), settings, orche config. */
export async function overlay(dir: string, proxyUrl: string, kind: Kind): Promise<{ apiKey: string; secrets: string[] }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(AGENT, name))) await copyFile(join(AGENT, name), join(dir, name));
  const connection = JSON.parse(await readFile(join(AGENT, "cliproxyapi.json"), "utf8"));
  await writeFile(join(dir, "cliproxyapi.json"), JSON.stringify({ ...connection, baseUrl: proxyUrl, fast: false }), { mode: 0o600 });
  await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProvider: MODEL.provider, defaultModel: MODEL.id, defaultThinkingLevel: THINKING, quietStartup: true, transport: "sse" }, null, 2));
  const secrets: string[] = [String(connection.apiKey ?? "")];
  if (kind !== "pure") {
    await writeFile(join(dir, "orche.config.json"), JSON.stringify(orcheConfig(kind), null, 2));
    // orche's Bash safety review (product default on) asks the Jev classifier (typesafe/jev-latest) before mutating commands; the
    // user's setup has that credential. Only the typesafe entry is copied (0600, removed with the run's temp dir). Pure Pi has no
    // such review, so it gets no classifier credential.
    const auth = existsSync(join(AGENT, "auth.json")) ? JSON.parse(await readFile(join(AGENT, "auth.json"), "utf8")) : {};
    if (auth.typesafe) { await writeFile(join(dir, "auth.json"), JSON.stringify({ typesafe: auth.typesafe }), { mode: 0o600 }); secrets.push(String(auth.typesafe.key ?? "")); }
  }
  return { apiKey: String(connection.apiKey ?? ""), secrets };
}

/** Environment of a Pi child process: private agent/session/temp dirs, this run's proxy, no inherited Pi/orche session variables. */
export function piEnv(base: NodeJS.ProcessEnv, options: { agentDir: string; sessionDir: string; temp: string; proxyUrl: string; apiKey: string; pathPrefix?: string; toolEvents?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of Object.keys(env)) if (/^(PI_|CLIPROXYAPI_|ORCHE_|STAGE_EVAL_|ULTRA_AB_|ADVISOR_BENCH_|npm_)/.test(name)) delete env[name];
  // npx/tsx put the harness's node_modules/.bin first on PATH; the agents must not see it (another Pi, vitest, tsx ...).
  const path = (base.PATH ?? "").split(":").filter(dir => dir && !dir.includes("/node_modules/.bin")).join(":");
  return {
    ...env, PI_CODING_AGENT_DIR: options.agentDir, PI_CODING_AGENT_SESSION_DIR: options.sessionDir, TMPDIR: options.temp, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    PI_CLIPROXYAPI_BUNDLED: "on", CLIPROXYAPI_BASE_URL: options.proxyUrl, CLIPROXYAPI_API_KEY: options.apiKey, CLIPROXYAPI_FAST: "0",
    ...(options.toolEvents ? { PI_ORCHE_TOOL_EVENTS: options.toolEvents } : {}),
    PATH: options.pathPrefix ? `${options.pathPrefix}:${path}` : path,
  };
}

/**
 * The Pi argv of every arm: no discovered extension, skill, prompt template, MCP server, context file or project-local file;
 * the provider bundle; orche (a frozen runtime) only for orche arms. Same model and thinking everywhere.
 */
export const piArgs = (runtime: string | undefined, extra: string[]): string[] => [
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--no-approve", "-e", PROVIDER_BUNDLE,
  ...(runtime ? ["-e", join(runtime, "src/extension/index.ts")] : []), "--model", `${MODEL.provider}/${MODEL.id}`, "--thinking", THINKING, ...extra,
];

// ---------------------------------------------------------------------------------------------------------------------------
// Frozen runtimes

export interface Revision { label: string; head: string; dirty: string[]; digest: string; diffSha256: string; files: Record<string, string>; frozenAt: string }

/**
 * Freeze orche as it is in the working tree NOW under <out>/runtimes/<label>: src/, package.json, tsconfig.json copied with
 * node_modules linked. REVISION.json records HEAD, the dirty list, a digest over every copied file and the sha256 of the
 * product diff against HEAD (saved as product.diff), so cumulative stages are identified without commits. Re-freezing a label
 * from a different tree is refused.
 */
export async function freezeRuntime(out: string, label: string): Promise<{ dir: string; digest: string }> {
  const rt = join(out, "runtimes", label);
  const files = git(REPO, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "package.json", "tsconfig.json"]).split("\n").filter(Boolean).filter(path => existsSync(join(REPO, path))).sort();
  const hash = createHash("sha256");
  const perFile: Record<string, string> = {};
  for (const path of files) { const sha = createHash("sha256").update(readFileSync(join(REPO, path))).digest("hex"); perFile[path] = sha; hash.update(`${path}\0${sha}\n`); }
  const digest = hash.digest("hex");
  if (existsSync(join(rt, "REVISION.json"))) {
    const existing: Revision = JSON.parse(readFileSync(join(rt, "REVISION.json"), "utf8"));
    if (existing.digest !== digest) throw new Error(`Runtime ${label} was frozen from a different tree (${existing.digest.slice(0, 12)} vs now ${digest.slice(0, 12)})`);
    return { dir: rt, digest };
  }
  await mkdir(rt, { recursive: true });
  for (const path of files) { await mkdir(join(rt, path, ".."), { recursive: true }); await copyFile(join(REPO, path), join(rt, path)); }
  await symlink(join(REPO, "node_modules"), join(rt, "node_modules"), "dir");
  const head = git(REPO, ["rev-parse", "HEAD"]).trim();
  const dirty = git(REPO, ["status", "--porcelain=v1"]).split("\n").filter(Boolean);
  // Product diff (tracked changes plus untracked product files) against HEAD.
  const tracked = git(REPO, ["diff", "HEAD", "--", "src", "package.json", "tsconfig.json"]);
  const untracked = git(REPO, ["ls-files", "--others", "--exclude-standard", "--", "src"]).split("\n").filter(Boolean)
    .map(path => `--- /dev/null\n+++ b/${path}\n${readFileSync(join(REPO, path), "utf8").split("\n").map(line => `+${line}`).join("\n")}\n`).join("");
  const diff = tracked + untracked;
  await writeFile(join(rt, "product.diff"), diff);
  const revision: Revision = { label, head, dirty, digest, diffSha256: createHash("sha256").update(diff).digest("hex"), files: perFile, frozenAt: new Date().toISOString() };
  await writeFile(join(rt, "REVISION.json"), JSON.stringify(revision, null, 2));
  return { dir: rt, digest };
}

export function frozenRuntime(out: string, label: string): { dir: string; digest: string } {
  const rt = join(out, "runtimes", label);
  return { dir: rt, digest: JSON.parse(readFileSync(join(rt, "REVISION.json"), "utf8")).digest };
}
