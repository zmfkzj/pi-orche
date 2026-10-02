/** Session API: construct WorkerPool({controller, agentDir?, idleTtlMs?}), register
 * orcheTaskParameters with execute(args), and call dispose() on session_shutdown.
 * execute accepts OrcheRunArgs plus task parameters; onProgress feeds tool updates/UI.
 * formatWorkers(), stop(id|"all") and roster() implement the pool slash commands. */
import { Type, type Static } from "@sinclair/typebox";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentManager } from "../agent/agent-manager.js";
import type { AgentSnapshot } from "../agent/agent-handle.js";
import { normalizeOwnedPath, type TaskItem } from "../orchestration/backlog.js";
import { checkWriteRealPath, WRITE_TOOLS, WRITING_KINDS } from "../orchestration/ownership.js";
import { resolveRunLimits } from "../orchestration/limits.js";
import { taskWorkerInstructions } from "../orchestration/prompts.js";
import { orchestrationResultSchemas } from "../orchestration/result-schemas.js";
import { resolveRoute, resolveSpecialistRoute } from "../orchestration/routing.js";
import { WorkspaceAudit, type WorkspaceChange } from "../orchestration/workspace.js";
import { WORKER_TOOL_NAMES } from "../tools/index.js";
import { createGenerateImageTool } from "../tools/generate-image.js";
import { loadProviderExtensions, type ProviderExtensionHost } from "../pi/provider-extensions.js";
import { ensureBundledImageProvider } from "../pi/register-bundled-image-provider.js";
import { describeSource, discoverOrcheConfig, NoRouteError } from "./config.js";
import { OrcheController, withConcurrentWarning, type OrcheRunArgs } from "./controller.js";
import type { ConcurrentActivitySummary } from "./concurrent-sessions.js";

export const orcheTaskParameters = Type.Object({
  role: Type.Union([Type.Literal("explore"), Type.Literal("answer"), Type.Literal("implement"), Type.Literal("verify"), Type.Literal("game-asset"), Type.Literal("video")]),
  request: Type.String({ minLength: 1 }),
  context: Type.Optional(Type.String({ maxLength: 30_000 })),
  worker: Type.Optional(Type.String()),
  files: Type.Optional(Type.Array(Type.String())),
  git: Type.Optional(Type.Object({
    commit: Type.Optional(Type.Boolean({ description: "Authorize git commit for this assignment." })),
    push: Type.Optional(Type.Boolean({ description: "Authorize git push (implies commit). Never force-push." })),
    remote: Type.Optional(Type.String({ minLength: 1, description: "Push remote; origin when only branch is given; omit both to push the current branch to its upstream." })),
    branch: Type.Optional(Type.String({ minLength: 1, description: "Push branch; the current branch when omitted." })),
  }, {
    additionalProperties: false,
    description: "Git grant for THIS assignment only, allowed for implement, game-asset and video (rejected for explore, answer, verify). Set it only when the user explicitly asked in this conversation to commit and/or push; otherwise omit it and the worker will not commit. Scope the commit to this task's files where possible (pass files and name them in request).",
  })),
});
export type TaskParameters = Static<typeof orcheTaskParameters>;
export type TaskRole = TaskParameters["role"];
export interface TaskDetails {
  worker: string;
  role: TaskRole;
  status: string;
  durationMs: number;
  requests: number;
  changes: WorkspaceChange[];
  roster: string;
  retired?: string[];
  /** Other pi sessions that were active on the repository when the task started. */
  concurrentSessions?: ConcurrentActivitySummary;
  /** Present when the assignment carried a git grant: the commits it created and whether a push was detected. */
  git?: GitReport;
}
interface Worker {
  id: string;
  role: TaskRole;
  cwd: string;
  files?: readonly string[];
  summary: string;
  lastUsed: number;
  tree?: string;
  contextWindow?: number;
  imageConfig?: string;
  latestInput: number;
  timer?: ReturnType<typeof setTimeout>;
}
export interface WorkerPoolOptions {
  controller: OrcheController;
  agentDir?: string;
  idleTtlMs?: number;
}

/** The ownership canonicalizer in phases.ts is private; mirror its syntax here,
 * without changing the multi orchestrator, and use its shared path normalizer. */
function scopePaths(files: readonly string[]): string[] {
  return [...new Set(files.map(file => {
    const path = normalizeOwnedPath(file.replaceAll("\\", "/").replace(/\/\*\*(?:\/\*)?$/, "/"));
    if (!path || /[*?\[\]{}]/.test(path) || isAbsolute(file) || /^[A-Za-z]:/.test(file) || path.split("/")[0] === "..")
      throw new Error(`Unsupported ownership path ${JSON.stringify(file)}; use concrete files, directory prefixes ending /, or directory/**`);
    return path;
  }))];
}
// ---- git grant: validation, the line every assignment prompt carries, and the read-only commit/push report ----
const execFileAsync = promisify(execFile);
/** Roles that may write, hence the only ones that can be allowed to commit. */
export const GIT_GRANT_ROLES: readonly string[] = ["implement", "game-asset", "video"];
/** Commit lines listed in a result; `commitCount` keeps the true number. */
const MAX_COMMITS = 20;
const MAX_GITLINKS = 10;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const REMOTE_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;
const BRANCH_NAME = /^[A-Za-z0-9_][\w./+-]{0,199}$/;

/** The validated grant: `commit` is always true (push implies it); `remote` is set whenever `branch` is. */
export interface GitGrant {
  commit: true;
  push: boolean;
  remote?: string;
  branch?: string;
}
/** What a granted assignment did to the repository (TaskDetails.git). */
export interface GitReport {
  grant: GitGrant;
  /** False outside a git work tree (or when git fails): nothing below is known. */
  available: boolean;
  /** HEAD when the task started / ended (absent: unborn branch or unreadable) and the branch it ended on (absent: detached). */
  headBefore?: string;
  headAfter?: string;
  branch?: string;
  /** Commits reachable from the final HEAD but not from the starting one; `commits` lists at most 20 of them (`git log --oneline`, newest first). */
  commitCount: number;
  commits: string[];
  /** Submodule gitlinks that differ between the starting and the final HEAD: `path (old → new)`. */
  gitlinks: string[];
  /** Whether a remote-tracking ref (the upstream, or the granted target) moved to a commit now contained in HEAD. */
  push: "detected" | "not-detected" | "unknown";
  /** The remote-tracking refs that were compared; `pushed`: the ref moved to a commit now contained in HEAD. */
  refs: { ref: string; before?: string; after?: string; pushed: boolean }[];
}
interface GitBaseline {
  available: boolean;
  head?: string;
  refs: Map<string, string | undefined>;
}

/** Validate the `git` argument for `role`. Undefined: no grant (not given, or it enables nothing). */
export function resolveGitGrant(role: string, input: TaskParameters["git"]): GitGrant | undefined {
  if (input === undefined) return undefined;
  if (!GIT_GRANT_ROLES.includes(role)) throw new Error(`Unsupported git grant for role ${role}; only ${GIT_GRANT_ROLES.join(", ")} may commit or push. Omit git for read-only roles.`);
  if (input.push === true && input.commit === false) throw new Error("Unsupported git grant: push requires commit; omit commit or set it to true.");
  if (input.push !== true && (input.remote !== undefined || input.branch !== undefined)) throw new Error("Unsupported git grant: remote and branch apply only with push true.");
  if (input.remote !== undefined && !REMOTE_NAME.test(input.remote)) throw new Error(`Unsupported git grant remote ${JSON.stringify(input.remote)}; use a remote name such as origin.`);
  if (input.branch !== undefined && (!BRANCH_NAME.test(input.branch) || input.branch.includes("..") || input.branch.endsWith("/") || input.branch.endsWith(".lock"))) {
    throw new Error(`Unsupported git grant branch ${JSON.stringify(input.branch)}; use a plain branch name such as main.`);
  }
  const push = input.push === true;
  if (!push && input.commit !== true) return undefined;
  const remote = input.remote ?? (input.branch !== undefined ? "origin" : undefined);
  return { commit: true, push, ...(remote ? { remote } : {}), ...(input.branch !== undefined ? { branch: input.branch } : {}) };
}

const pushTarget = (grant: GitGrant) => grant.remote && grant.branch ? `${grant.remote}/${grant.branch}` : grant.remote ? `${grant.remote} (current branch)` : "the current branch's upstream";
/** The line that ends every assignment prompt: an explicit authorization, or an explicit refusal. Reused workers keep
 * their system instruction, so each assignment states its own grant and a later one without it says so. */
export function gitAssignmentLine(grant: GitGrant | undefined): string {
  if (!grant) return "Git commit/push is NOT authorized for this assignment; do not commit.";
  return `This assignment authorizes git commit${grant.push ? ` and push to ${pushTarget(grant)}` : ""}. Commit only the changes this assignment describes (stage paths explicitly; never \`git add -A\` of unrelated files); do not force-push, rewrite history, or change git config.${grant.push ? " Push only to that target." : " Do not push."} This authorization applies to this assignment only.`;
}

/** Read-only, bounded and fail-soft: undefined when git fails; an abort still propagates. */
async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, signal, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return stdout.trim();
  } catch {
    signal?.throwIfAborted(); // cancellation must not look like "git failed"
    return undefined;
  }
}
const rev = async (cwd: string, ref: string, signal?: AbortSignal) => (await git(cwd, ["rev-parse", "--verify", "-q", ref], signal)) || undefined;
const short = (sha: string | undefined) => sha ? sha.slice(0, 7) : "none";
const remoteRef = (ref: string) => ref.replace(/^refs\/remotes\//, "");

/** Remote-tracking refs whose movement means a push: the upstream, and the granted target when it names one. */
async function trackedRefs(cwd: string, grant: GitGrant, signal?: AbortSignal): Promise<string[]> {
  const names = new Set<string>();
  const upstream = await git(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"], signal);
  if (upstream?.startsWith("refs/")) names.add(upstream);
  if (grant.push && (grant.remote || grant.branch)) {
    const branch = grant.branch ?? await git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], signal);
    if (branch) names.add(`refs/remotes/${grant.remote ?? "origin"}/${branch}`);
  }
  return [...names];
}

/** HEAD and the tracked remote refs before the worker starts (`available: false` when git cannot say). */
async function captureGitBaseline(cwd: string, grant: GitGrant, signal?: AbortSignal): Promise<GitBaseline> {
  if (await git(cwd, ["rev-parse", "--is-inside-work-tree"], signal) !== "true") return { available: false, refs: new Map() };
  const head = await rev(cwd, "HEAD", signal);
  const refs = new Map<string, string | undefined>();
  for (const name of await trackedRefs(cwd, grant, signal)) refs.set(name, await rev(cwd, name, signal));
  return { available: true, ...(head ? { head } : {}), refs };
}

/** Submodule entries (mode 160000) that differ between two commits; the diff output cap bounds the cost. */
async function changedGitlinks(cwd: string, from: string, to: string): Promise<string[]> {
  const raw = await git(cwd, ["-c", "core.quotepath=false", "diff-tree", "-r", "--raw", "--no-renames", "--no-commit-id", from, to]);
  const links: string[] = [];
  for (const line of raw?.split("\n") ?? []) {
    const [meta = "", path = ""] = line.split("\t");
    const [oldMode, newMode, oldSha, newSha] = meta.slice(1).split(" ");
    if (oldMode !== "160000" && newMode !== "160000") continue;
    const sha = (value: string | undefined) => value && /[^0]/.test(value) ? short(value) : "none";
    links.push(`${path} (${sha(oldSha)} → ${sha(newSha)})`);
  }
  return links;
}

/** Commits, gitlinks and push evidence since `baseline`. Never throws: unreadable parts are left out or "unknown". */
async function reportGit(cwd: string, grant: GitGrant, baseline: GitBaseline): Promise<GitReport> {
  const empty: GitReport = { grant, available: false, commitCount: 0, commits: [], gitlinks: [], push: "unknown", refs: [] };
  if (!baseline.available) return empty;
  try {
    const headAfter = await rev(cwd, "HEAD");
    const branch = await git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
    let commitCount = 0;
    let commits: string[] = [];
    let gitlinks: string[] = [];
    if (headAfter && headAfter !== baseline.head) {
      const range = baseline.head ? `${baseline.head}..${headAfter}` : headAfter;
      const log = await git(cwd, ["log", "--no-color", "--no-decorate", "--no-show-signature", "--oneline", `--max-count=${MAX_COMMITS}`, range]);
      commits = log ? log.split("\n") : [];
      const count = Number.parseInt(await git(cwd, ["rev-list", "--count", range]) ?? "", 10);
      commitCount = Number.isFinite(count) ? Math.max(count, commits.length) : commits.length;
      if (baseline.head) gitlinks = (await changedGitlinks(cwd, baseline.head, headAfter)).slice(0, MAX_GITLINKS);
    }
    const names = new Set(baseline.refs.keys());
    const upstream = await git(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
    if (upstream?.startsWith("refs/")) names.add(upstream);
    const refs: GitReport["refs"] = [];
    for (const ref of names) {
      const before = baseline.refs.get(ref);
      const after = await rev(cwd, ref);
      // Moved: a push puts HEAD (or one of its ancestors) there; a fetch of someone else's commits does not.
      const pushed = !!after && after !== before && !!headAfter && (after === headAfter || await git(cwd, ["merge-base", "--is-ancestor", after, headAfter]) !== undefined);
      refs.push({ ref, ...(before ? { before } : {}), ...(after ? { after } : {}), pushed });
    }
    return {
      grant, available: true,
      ...(baseline.head ? { headBefore: baseline.head } : {}), ...(headAfter ? { headAfter } : {}), ...(branch ? { branch } : {}),
      commitCount, commits, gitlinks, push: refs.length ? refs.some(item => item.pushed) ? "detected" : "not-detected" : "unknown", refs,
    };
  } catch {
    return empty;
  }
}

/** Result lines for a report. Bounded: at most 20 commits, 10 gitlinks and one line per compared ref. */
export function formatGitReport(report: GitReport): string[] {
  if (!report.available) return ["Git: commit/push report unavailable (not a git work tree, or git failed)"];
  const lines: string[] = [];
  const { headBefore, headAfter } = report;
  if (report.commitCount > 0) {
    lines.push(`Git: ${report.commitCount} commit${report.commitCount === 1 ? "" : "s"} created on ${report.branch ?? "a detached HEAD"} (${headBefore ? short(headBefore) : "unborn"} → ${short(headAfter)}):`);
    lines.push(...report.commits.map(commit => `  ${commit}`));
    if (report.commitCount > report.commits.length) lines.push(`  … ${report.commitCount - report.commits.length} more`);
  } else if (headAfter !== headBefore) {
    lines.push(`Git: HEAD moved ${short(headBefore)} → ${short(headAfter)} without new commits (reset or checkout?)`);
  } else {
    lines.push(`Git: no commits created (HEAD ${headAfter ? `still ${short(headAfter)}` : "unborn"})`);
  }
  if (report.gitlinks.length) lines.push(`Submodule gitlinks changed: ${report.gitlinks.join(", ")}`);
  if (report.push === "detected") {
    lines.push(`Push: detected (${report.refs.filter(item => item.pushed).map(item => `${remoteRef(item.ref)} ${short(item.before)} → ${short(item.after)}`).join(", ")})${report.grant.push ? "" : "; the grant did not authorize push"}`);
  } else if (report.grant.push) {
    lines.push(report.push === "unknown"
      ? "Push: cannot be detected (no upstream or remote-tracking ref); check the remote"
      : `Push: not detected (${report.refs.map(item => item.after && item.after !== item.before ? `${remoteRef(item.ref)} moved ${short(item.before)} → ${short(item.after)}, not to a commit of this HEAD` : `${remoteRef(item.ref)} still at ${short(item.after)}`).join(", ")})`);
  }
  return lines;
}


function assignmentPrompt(args: TaskParameters, commands: readonly string[], imagesAvailable = false, grant?: GitGrant): string {
  const task = args.context?.trim() ? `${args.request}\n\n## Context from the requesting session\n${args.context.trim()}` : args.request;
  const scope = args.files === undefined ? "anywhere inside the workspace" : JSON.stringify(args.files);
  const instructions: Record<TaskRole, string> = {
    explore: 'Investigate independently, read source and reproduce. DO NOT EDIT. Report findings with concrete evidence and optionally data.cause. report_result {kind:"explore",summary,data:{cause,evidence}}.',
    answer: 'Strictly read-only. Inspect relevant files and provide an evidence-backed answer, concrete code references and explanations. Never change files. report_result {kind:"answer",summary:FULL_EVIDENCED_ANSWER,data:{evidence}}.',
    implement: `Implement completely, preserving unrelated changes. Write scope: ${scope}. Run local checks on touched files. report_result {kind:"implement",summary,data:{status:"done" or "blocked",reason,evidence:[checks]}}.`,
    "game-asset": `Game asset production. Create or modify game assets (sprites, sprite sheets/atlases, tilesets, textures, icons/UI art, 3D models, animations, VFX, SFX/music, fonts, and their engine import/metadata files) inside the write scope ${scope}. First detect the engine and the project's conventions (Unity .meta, Godot .import/.tres, Unreal, Phaser/Pixi atlas JSON; existing naming, folder layout, resolution/pixels-per-unit, palette, pivot/origin, power-of-two, compression). Produce assets with locally available tools via bash (check command -v first: ImageMagick, Inkscape, Blender --background with Python, Aseprite --batch, ffmpeg, sox, Python Pillow/numpy, or hand-written SVG/procedural scripts); keep reusable generator scripts with the assets when the project has a place for them, and leave no temp files in the workspace. Never hand-fabricate binary bytes. Verify every output is valid (identify/file/ffprobe/blender), and view raster outputs or rendered previews with the read tool. Do not download third-party assets unless the request allows it; record source and license when you do. report_result {kind:"game-asset",summary,data:{status:"done" or "blocked",reason,outputs:[{path,type,spec}],evidence:[checks]}}. spec is a descriptive string.`,
    video: `Video production. Plan and produce video deliverables inside the write scope ${scope}: script/storyboard/shot list, editing and compositing, motion graphics (code-based such as Remotion, Motion Canvas or manim when the project uses them), subtitles (SRT/VTT), audio mixing and loudness normalization, thumbnails and final encodes. Use locally available tools via bash (check command -v first: ffmpeg/ffprobe, the project's own video tooling, Python, ImageMagick, sox). Render a short draft before long renders; make final encode settings explicit (container, video codec, resolution, fps, CRF/bitrate, pixel format, audio codec/sample rate, loudness target). Verify every output with ffprobe (duration, streams, resolution, fps) and inspect extracted frames with the read tool. Leave no intermediate files in the workspace unless requested. report_result {kind:"video",summary,data:{status:"done" or "blocked",reason,outputs:[{path,type,spec}],evidence:[checks]}}. spec is a descriptive string.`,
    verify: `Independent read-only review. DO NOT EDIT. ${commands.length ? `Run configured checks via bash: ${commands.map(command => JSON.stringify(command)).join(", ")}` : "Discover and run the project's own checks via bash (package.json, Makefile, pyproject.toml, Cargo.toml, go.mod or CI config)"}, plus focused checks; inspect source and git diff. report_result {kind:"verify",summary,data:{passed:boolean,evidence:[commands and outcomes],issues:[{file,description}]}}. passed:true requires actual passing checks; unexecuted checks never count as passed.`,
  };
  const rasterInstructions = imagesAvailable ? '\nUse generate_image for raster art (sprites, textures, icons, concept art, thumbnails). Request background "transparent" for sprites/icons. Always pass width/height for the exact target size: the gateway ignores size and returns roughly 1254x1254. Use kernel "nearest" for pixel art. Inspect results with read. Keep procedural/SVG generation for vector or pixel-exact assets. Record the generation prompt in outputs[].spec.' : "";
  return `Assignment: ${args.role}. You work alone; there are no peers or backlog.\n${task}\n\n${instructions[args.role]}${rasterInstructions}\n\n${gitAssignmentLine(grant)}`;
}

export class WorkerPool {
  private manager?: AgentManager;
  private readonly workers = new Map<string, Worker>();
  private readonly providers = new Map<string, ProviderExtensionHost>();
  private nextId = 1;
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(private readonly options: WorkerPoolOptions) {
    if (!Number.isFinite(options.idleTtlMs ?? 1) || (options.idleTtlMs ?? 1) < 0) throw new Error("idleTtlMs must be finite and nonnegative");
  }
  list(): AgentSnapshot[] {
    return [...this.workers.values()].map(worker => ({ ...this.manager!.get(worker.id), role: worker.role }));
  }
  session(id: string) { return this.manager!.session(id); }
  roster(): string {
    return this.list().map(worker => `${worker.id} ${worker.status} (${worker.role}: ${this.workers.get(worker.id)!.summary.slice(0, 80) || "no result yet"})`).join(", ") || "no workers";
  }
  formatWorkers(): string {
    return this.list().map(worker => {
      const meta = this.workers.get(worker.id)!;
      return `${worker.id} ${worker.status} · ${meta.role} · ${worker.completedAssignments} assignments · last: ${meta.summary.slice(0, 80) || "no result yet"} · idle ${Math.floor((Date.now() - meta.lastUsed) / 60_000)}m`;
    }).join("\n") || "no workers";
  }
  private async retire(id: string): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker) return;
    clearTimeout(worker.timer);
    this.workers.delete(id);
    await this.manager?.dispose(id);
  }
  private idle(worker: Worker): void {
    clearTimeout(worker.timer);
    worker.lastUsed = Date.now();
    if (this.disposed || !this.workers.has(worker.id)) return;
    worker.timer = setTimeout(() => {
      if (this.manager?.get(worker.id).status === "idle") void this.retire(worker.id).catch(() => undefined);
    }, this.options.idleTtlMs ?? 30 * 60_000);
    worker.timer.unref();
  }
  async stop(id: string): Promise<string> {
    const ids = id === "all" ? [...this.workers.keys()] : this.workers.has(id) ? [id] : [];
    if (!ids.length) return id === "all" ? "no workers" : `unknown worker ${id}`;
    await Promise.all(ids.map(worker => this.retire(worker)));
    return `Disposed workers: ${ids.join(", ")}`;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const worker of this.workers.values()) clearTimeout(worker.timer);
    this.manager?.close();
    this.disposal = (async () => {
      await this.manager?.dispose();
      this.workers.clear();
      for (const host of this.providers.values()) host.dispose();
      this.providers.clear();
    })();
    return this.disposal;
  }
  private async guard(worker: Worker, toolName: string, input: Record<string, unknown>): Promise<string | undefined> {
    if (!WRITE_TOOLS.has(toolName)) return undefined;
    let files = worker.files;
    // With no explicit scope, use the concrete requested target as ownership. checkWrite
    // still enforces assignment kind, an explicit path, and workspace containment.
    if (files === undefined && typeof input.path === "string") {
      const path = relative(worker.cwd, resolve(worker.cwd, input.path));
      files = path && !isAbsolute(path) && path.split(sep)[0] !== ".." ? [normalizeOwnedPath(path) + "/", normalizeOwnedPath(path)] : [];
    }
    const tasks: TaskItem[] = [{ id: worker.id, owner: worker.id, description: "Single-worker assignment", files: files ?? [], status: "running" }];
    return (await checkWriteRealPath({ toolName, input, cwd: worker.cwd, agentId: worker.id, assignmentKind: worker.role, tasks }))?.reason;
  }
  execute(args: OrcheRunArgs & TaskParameters): Promise<{ text: string; details: TaskDetails }> {
    return this.options.controller.task(args.signal, async signal => {
      const reused = args.worker ? this.workers.get(args.worker) : undefined;
      if (reused) clearTimeout(reused.timer);
      try { return await this.executeAssignment(args, signal); }
      finally { if (reused && this.workers.has(reused.id) && this.manager?.get(reused.id).status === "idle") this.idle(reused); }
    });
  }
  private async executeAssignment(args: OrcheRunArgs & TaskParameters, signal: AbortSignal): Promise<{ text: string; details: TaskDetails }> {
    if (this.disposed) throw new Error("Worker pool is disposed");
    const grant = resolveGitGrant(args.role, args.git); // before any worker is touched: a bad grant spawns and changes nothing
    const started = Date.now();
    const retired: string[] = [];
    const retirementLines: string[] = [];
    const files = WRITING_KINDS.has(args.role) && args.files !== undefined ? scopePaths(args.files) : undefined;
    let worker = args.worker ? this.workers.get(args.worker) : undefined;
    if (args.worker && !worker) {
      const live = this.list().map(item => `${item.id} (${item.status}, ${item.role})`).join(", ") || "none";
      throw new Error(`Unknown worker ${args.worker}; live workers: ${live}. Omit worker to start a new one.`);
    }
    if (worker && this.manager!.get(worker.id).status !== "idle") throw new Error(`Worker ${worker.id} is running; wait for its assignment to finish.`);
    const sessionModel = args.model ? `${args.model.provider}/${args.model.id}` : undefined;
    const config = await discoverOrcheConfig({ cwd: args.cwd, agentDir: this.options.agentDir ?? getAgentDir(), projectTrusted: args.projectTrusted, session: { model: sessionModel, thinking: args.thinking } });
    signal.throwIfAborted();
    // Once, at the start. A task has no ownership audit that could classify the other session's writes, so the warning is
    // all it can do: it goes first in the result, in the progress lines and in a note beside the changed files.
    const concurrent = await this.options.controller.detectConcurrent(args, config.concurrentSessions, signal);
    const warning = concurrent?.warning;
    const limits = resolveRunLimits(config.routes.limits);
    const runtime = await this.options.controller.modelRuntime();
    if (this.disposed) throw new Error("Worker pool is disposed");
    signal.throwIfAborted();
    if (config.source.kind === "session" && args.model && !runtime.getModel(args.model.provider, args.model.id)) throw new NoRouteError(
      `The session model ${sessionModel} cannot be resolved by orche's own model runtime (it does not see providers that other Pi extensions register, nor in-memory credentials). Route orche explicitly in ${args.cwd}/.pi/orche.config.json, and list the provider's Pi package in "providerExtensions" if the provider comes from an extension (see docs/pi-package.md).`,
    );
    if (config.routes.providerExtensions?.length) {
      const key = JSON.stringify(config.routes.providerExtensions);
      if (!this.providers.has(key)) {
        const host = await loadProviderExtensions(runtime, config.routes.providerExtensions, { cwd: args.cwd, agentDir: this.options.agentDir, signal });
        if (this.disposed) { host.dispose(); throw new Error("Worker pool is disposed"); }
        this.providers.set(key, host);
      }
    }
    const images = args.role === "game-asset" || args.role === "video" ? config.routes.images : undefined;
    const imageConfig = images ? JSON.stringify(images) : undefined;
    // The bundled cliproxyapi-images provider is registered lazily: only for game-asset/video with images configured,
    // after providerExtensions (which may already provide it); otherwise no provider config or credential file is read.
    ensureBundledImageProvider({ runtime, images, agentDir: this.options.agentDir ?? getAgentDir() });
    // Tools cannot be unregistered from a session. Recreate only when this optional
    // capability changes, so neither tool registration nor old instructions leak roles.
    if (worker && worker.imageConfig !== imageConfig) {
      await this.retire(worker.id);
      retired.push(worker.id);
      retirementLines.push(`${worker.id} retired: image tool configuration changed; starting a fresh worker.`);
      worker = undefined;
    }
    const reusedContext = !!worker;
    this.manager ??= new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas, requestBudget: limits.assignmentRequests });
    if (!worker) {
      if (this.workers.size >= 3) {
        const oldest = [...this.workers.values()].filter(item => this.manager!.get(item.id).status === "idle").sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!oldest) throw new Error("All three workers are busy; wait for an idle worker.");
        await this.retire(oldest.id);
        retired.push(oldest.id);
        retirementLines.push(`${oldest.id} retired: least-recently-used idle worker (pool cap 3).`);
      }
      const id = `W${this.nextId++}`;
      worker = { id, role: args.role, cwd: args.cwd, files, summary: "", lastUsed: Date.now(), latestInput: 0, imageConfig };
      const meta = worker;
      const routeRole = args.role === "answer" ? "analyst" : args.role === "explore" ? config.routes.workers?.explorerRoles?.[0] ?? "explorer-path" : args.role === "implement" ? "implementer" : args.role === "verify" ? "verifier" : args.role;
      const route = args.role === "game-asset" || args.role === "video"
        ? resolveSpecialistRoute(config.routes, routeRole, (provider, id) => !!runtime.getModel(provider, id))
        : resolveRoute(config.routes, routeRole);
      const customTools = images ? [createGenerateImageTool({ cwd: args.cwd, runtime, images })] : [];
      await this.manager.spawn({ id, role: routeRole, route, cwd: args.cwd, tools: [...WORKER_TOOL_NAMES, ...customTools.map(tool => tool.name)], customTools, peerMessaging: false,
        instructions: `${taskWorkerInstructions}\nYou work alone: there are no peer workers. Reply in the language of the request.`,
        onContextWindow: info => { meta.contextWindow = info.contextWindow; },
        toolGuard: (name, input) => this.guard(meta, name, input),
      });
      if (this.disposed) { await this.manager.dispose(id); throw new Error("Worker pool is disposed"); }
      this.workers.set(id, worker);
    }
    const meta = worker;
    clearTimeout(meta.timer);
    meta.role = args.role;
    meta.files = files;
    meta.latestInput = 0;
    let requests = 0;
    let audit: WorkspaceAudit | undefined;
    let before: string | undefined;
    let changes: WorkspaceChange[] = [];
    let assigned = false;
    let stopPromise: Promise<void> | undefined;
    const abort = () => { if (assigned) stopPromise ??= this.manager!.stop(meta.id); };
    const progress = () => {
      const snapshot = this.manager!.get(meta.id);
      args.onProgress?.([...(warning ? [warning] : []), `${meta.id} ${args.role} · ${requests} requests${snapshot.lastToolName ? ` · last tool: ${snapshot.lastToolName}` : ""}`]);
    };
    const unsubscribe = this.manager.subscribe(event => {
      if (!("agentId" in event) || event.agentId !== meta.id) return;
      if (event.type === "usage") { requests++; meta.latestInput = event.input + event.cacheRead; }
      progress();
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      // Use an uncancelled audit so cancellation still records changes made before stop.
      audit = await WorkspaceAudit.open(args.cwd);
      before = await audit?.snapshot();
      const stale = audit && before && meta.tree ? await audit.diff(meta.tree, before) : [];
      const prefix = reusedContext ? `## Stale context: workspace changes since your previous assignment\n${stale.length ? stale.map(change => `${change.path} (${change.status})`).join("\n") : audit ? "No files changed." : "Workspace audit unavailable (not a git work tree)."}\nRe-read changed evidence before relying on retained context.\n\n` : "";
      const gitBaseline = grant ? await captureGitBaseline(args.cwd, grant, signal) : undefined;
      signal.throwIfAborted();
      this.manager.assign(meta.id, args.role, prefix + assignmentPrompt({ ...args, ...(files ? { files: [...files] } : {}) }, config.routes.verifyCommands ?? [], !!images, grant));
      assigned = true;
      if (signal.aborted) abort();
      progress();
      const waited = await this.manager.wait(meta.id, limits.assignmentMs);
      if (signal.aborted) { await stopPromise; throw new Error("cancelled"); }
      if (waited.type === "timeout") { await this.manager.stop(meta.id); await this.manager.wait(meta.id, 0); throw new Error(`Worker ${meta.id} timed out after ${limits.assignmentMs}ms`); }
      if (waited.type !== "outcome") throw new Error(`Worker ${meta.id} returned no result`);
      const outcome = waited.outcome;
      if (outcome.status !== "completed" || !outcome.result) throw new Error(outcome.error ?? outcome.lastText ?? `Worker ${meta.id}: ${outcome.status}`);
      meta.summary = outcome.result.summary;
      if (audit && before) {
        const after = await audit.snapshot();
        changes = await audit.diff(before, after);
        meta.tree = after;
      }
      const gitReport = grant && gitBaseline ? await reportGit(args.cwd, grant, gitBaseline) : undefined;
      meta.lastUsed = Date.now();
      if (meta.contextWindow && meta.latestInput >= meta.contextWindow * 0.7) {
        await this.retire(meta.id); retired.push(meta.id);
        retirementLines.push(`${meta.id} retired: context nearly full; start a new worker with the contract and evidence`);
      }
      const durationMs = Date.now() - started;
      const data = outcome.result.data && typeof outcome.result.data === "object" ? outcome.result.data as Record<string, unknown> : {};
      const roleData = ["status", "reason", "passed", "issues", "cause"].filter(key => data[key] !== undefined).map(key => `${key}: ${typeof data[key] === "string" ? data[key] : JSON.stringify(data[key])}`);
      if (Array.isArray(data.outputs)) roleData.push(`outputs: ${data.outputs.length}`);
      const note = data.status === "blocked" ? "the worker reported blocked" : args.role === "verify" && data.passed === false ? "verification failed" : args.role === "implement" && changes.length >= 4 ? "the implementation changed four or more files" : undefined;
      const roster = this.roster();
      const gitLines = gitReport ? formatGitReport(gitReport) : [];
      const changed = changes.length ? `Changed files: ${changes.map(change => change.path).join(", ")}${warning ? " (may include changes made by the other pi session(s); check before attributing them to this task)" : ""}` : "No files changed";
      const text = [...(warning ? [warning, ""] : []), `orche task ${meta.id} (${args.role}, ${Math.round(durationMs / 1000)}s, ${requests} requests; ${describeSource(config.source)})`, "", meta.summary, ...roleData, "", audit ? changed : "Workspace audit unavailable (not a git work tree)", ...gitLines, `Workers: ${roster}`, ...retirementLines,
        ...(!WRITING_KINDS.has(args.role) && args.files !== undefined ? ["Note: files ignored for read-only role."] : []), ...(note ? [`Note: consider orche_run (multi) — ${note}`] : [])].join("\n");
      return { text, details: { worker: meta.id, role: args.role, status: typeof data.status === "string" ? data.status : outcome.status, durationMs, requests, changes, roster, ...(retired.length ? { retired } : {}), ...(concurrent ? { concurrentSessions: concurrent.activity } : {}), ...(gitReport ? { git: gitReport } : {}) } };
    } catch (error) {
      throw warning ? withConcurrentWarning(error, warning) : error;
    } finally {
      signal.removeEventListener("abort", abort);
      await stopPromise;
      unsubscribe();
      if (audit && before) meta.tree = await audit.snapshot().catch(() => meta.tree);
      await audit?.close();
      if (this.workers.has(meta.id)) this.idle(meta);
      args.onProgress?.([]);
    }
  }
}
