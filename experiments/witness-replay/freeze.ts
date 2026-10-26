/**
 * Freeze the pilot before any revision outcome (results/witness-replay/PREREGISTRATION.md): seeds (the archived artifacts' final
 * workspaces, verified against their archived final.diff applied to the original snapshot), witnesses and held-out checks with
 * sha256, the one prompt per seed (both arms), the gate-message template, staged venv digests, the provider, the Pi bundle, Node,
 * bubblewrap, the catalog prices, the harness file hashes, the budget and the schedule. Nothing frozen is ever overwritten.
 * A hidden-overlap guard refuses to freeze when a prompt or witness shares a line with the task's hidden tests or reference fix
 * that is not already in the public issue text or the original snapshot.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { freezeProvider } from "../ultra-ho/env.js";
import { AGENT, HERE, NODE, PI_CLI, PI_MODULES, REPO, UPSTREAM, dirDigest, pythonPathOf, sourceOf, stageVenv, taskManifest, writeJson } from "./env.js";
import { BUDGET, EFFORT, MAX_RERUNS, MODEL, SEEDS, digestOf, gateMessage, revisionPrompt, schedule, type Seed, r1Gate } from "./protocol.js";
import type { FrozenPlan, FrozenSeed } from "./unit.js";
import { WITNESS_MOUNT, copyCandidate, fileSha256, sha256, treeDigest, treeEntries } from "./witness-run.js";

/** Lines of `text` (trimmed, ≥ 16 chars, not comment-only) that also occur in hidden/reference patch ADDED lines but in neither the issue nor the original snapshot. */
export function hiddenOverlap(text: string, hiddenAdded: readonly string[], publicText: string): string[] {
  const hidden = new Set(hiddenAdded.map(line => line.trim()).filter(line => line.length >= 16));
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < 16 || !hidden.has(line)) continue;
    if (publicText.includes(line)) continue;
    out.push(line);
  }
  return out;
}

/** Added lines (without the leading "+") of a unified diff. */
export const addedLines = (patch: string): string[] => patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1));

function sourceText(root: string, limitBytes = 64 * 1024 * 1024): string {
  const parts: string[] = [];
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!/^(\.git|node_modules|__pycache__)$/.test(entry.name)) walk(path); continue; }
      if (!entry.isFile() || !/\.(py|md|rst|txt|toml|ini|cfg|json|yaml|yml)$/.test(entry.name)) continue;
      const size = statSync(path).size;
      if (size > 2 * 1024 * 1024 || total + size > limitBytes) continue;
      total += size; parts.push(readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return parts.join("\n");
}

const version = (command: string, args: string[]): string => { try { return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString().trim(); } catch (error) { return `unknown (${String(error).slice(0, 120)})`; } };

export async function freeze(out: string, scratch: string, seeds: readonly Seed[] = SEEDS, options: { harnessValidation?: boolean } = {}): Promise<FrozenPlan> {
  // R1 stop rule (AUDIT.md): the pilot is never frozen with fewer than two qualified failure families or an unqualified failure
  // seed. Only the synthetic harness validation (smoke-seed.ts, never a pilot seed) bypasses it.
  const gate = r1Gate(seeds);
  if (!gate.ok && !options.harnessValidation) throw new Error(`R1 stop: qualified failure families [${gate.families.join(", ")}], unqualified failure seeds [${gate.excluded.join(", ")}]; a pilot needs >= 2 qualified families (results/witness-replay/AUDIT.md)`);
  const frozen = join(out, "frozen");
  if (existsSync(join(frozen, "plan.json"))) throw new Error(`${frozen}/plan.json exists: a frozen pilot is never overwritten`);
  await mkdir(frozen, { recursive: true });
  const provider = await freezeProvider(frozen);
  const catalogRaw = readFileSync(join(AGENT, "cliproxyapi-models.json"));
  const catalogParsed = JSON.parse(catalogRaw.toString());
  const entries: any[] = Array.isArray(catalogParsed) ? catalogParsed : Array.isArray(catalogParsed?.models) ? catalogParsed.models : Object.values(catalogParsed ?? {});
  const entry = entries.find(item => item?.id === MODEL.id);
  if (!entry?.cost) throw new Error(`no catalog price for ${MODEL.id}`);
  const frozenSeeds: FrozenSeed[] = [];
  const provenance: Record<string, unknown> = {};
  for (const seed of seeds) {
    const manifest = taskManifest(seed.fixtures, seed.task);
    const source = sourceOf(seed.cache, seed.task);
    const seedDir = join(frozen, "seeds", seed.id, "tree");
    // The seed IS the archived candidate patch: the original snapshot with the archived final.diff applied. The archived
    // workspace-final copy must agree file for file (its symlinks may have been absolutized by the archiving copy).
    await copyCandidate(source, seedDir);
    execFileSync("git", ["apply", "--whitespace=nowarn", "--binary", resolve(REPO, seed.artifact, "final.diff")], { cwd: seedDir, stdio: ["ignore", "pipe", "pipe"] });
    const seedDigest = treeDigest(seedDir);
    const applied = new Set(treeEntries(seedDir)), archived = new Set(treeEntries(resolve(REPO, seed.artifact, "workspace-final")));
    const onlyApplied = [...applied].filter(item => !archived.has(item)), onlyArchived = [...archived].filter(item => !applied.has(item));
    const fileDifferences = [...onlyApplied, ...onlyArchived].filter(item => item.startsWith("f\0"));
    provenance[seed.id] = {
      artifact: seed.artifact, finalDiffSha256: fileSha256(resolve(REPO, seed.artifact, "final.diff")), seedDigest, originalDigest: treeDigest(source),
      archivedWorkspaceDigest: treeDigest(resolve(REPO, seed.artifact, "workspace-final")), fileDifferences: fileDifferences.map(item => item.split("\0").slice(0, 2).join(" ")),
      symlinkDifferences: [...onlyApplied, ...onlyArchived].filter(item => item.startsWith("l\0")).map(item => item.split("\0").join(" ")),
    };
    if (fileDifferences.length) throw new Error(`${seed.id}: archived final.diff on the original snapshot disagrees with workspace-final: ${fileDifferences.slice(0, 5).join(", ")}`);
    await mkdir(join(frozen, "witnesses"), { recursive: true });
    const witnessPath = `witnesses/${seed.id}.py`;
    await copyFile(resolve(REPO, seed.witness), join(frozen, witnessPath));
    let heldout: FrozenSeed["heldout"];
    if (seed.heldout) { await mkdir(join(frozen, "heldout"), { recursive: true }); await copyFile(resolve(REPO, seed.heldout), join(frozen, `heldout/${seed.id}.py`)); heldout = { path: `heldout/${seed.id}.py`, sha256: fileSha256(join(frozen, `heldout/${seed.id}.py`)) }; }
    const prompt = revisionPrompt(seed, manifest, WITNESS_MOUNT);
    await mkdir(join(frozen, "prompts"), { recursive: true });
    await writeFile(join(frozen, `prompts/${seed.id}.txt`), prompt);
    // Hidden-overlap guard over everything model-facing (prompt + reproducer).
    const hiddenAdded = [...addedLines(readFileSync(resolve(REPO, seed.fixtures, seed.task, "hidden/test.patch"), "utf8")), ...addedLines(readFileSync(resolve(REPO, seed.fixtures, seed.task, "reference/fix.patch"), "utf8"))];
    const publicText = `${manifest.problemStatement}\n${manifest.interface ?? ""}\n${sourceText(source)}`;
    const overlap = [...hiddenOverlap(prompt, hiddenAdded, publicText), ...hiddenOverlap(readFileSync(join(frozen, witnessPath), "utf8"), hiddenAdded, publicText)];
    const testIds = [...manifest.failToPass, ...(Array.isArray(manifest.passToPass) ? manifest.passToPass as string[] : [])].map(id => id.split("::").at(-1)!.replace(/\[.*$/, ""));
    const idHits = testIds.filter(id => prompt.includes(id) || readFileSync(join(frozen, witnessPath), "utf8").includes(id));
    provenance[seed.id] = { ...(provenance[seed.id] as object), hiddenOverlap: overlap, hiddenTestIdHits: idHits };
    if (overlap.length || idHits.length) throw new Error(`${seed.id}: model-facing text overlaps hidden tests/reference: ${JSON.stringify({ overlap, idHits }).slice(0, 600)}`);
    const { digest: venvDigest } = await stageVenv(seed.cache, seed.task, join(scratch, "envs"));
    frozenSeeds.push({
      id: seed.id, role: seed.role, family: seed.family, task: seed.task, fixtures: seed.fixtures, cache: seed.cache, artifact: seed.artifact, pythonPath: pythonPathOf(manifest),
      seedTree: relative(frozen, seedDir), seedDigest, witness: { path: witnessPath, sha256: fileSha256(join(frozen, witnessPath)) }, ...(heldout ? { heldout } : {}),
      prompt: { path: `prompts/${seed.id}.txt`, sha256: sha256(prompt) }, venvDigest,
    });
  }
  const gateTemplate = gateMessage(WITNESS_MOUNT, { exit: 1, status: "fail", output: "<the reproducer's output, last 6000 characters>" });
  await writeFile(join(frozen, "gate-template.txt"), gateTemplate);
  const harness: Record<string, string> = {};
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile()) harness[relative(REPO, path)] = fileSha256(path); } };
  walk(HERE);
  const plan: FrozenPlan = {
    createdAt: new Date().toISOString(), route: { model: MODEL.id, effort: EFFORT }, budget: { ...BUDGET }, maxReruns: MAX_RERUNS, upstream: UPSTREAM,
    piCli: { path: PI_CLI, sha256: fileSha256(PI_CLI), version: version(NODE, [PI_CLI, "--version"]) }, node: { path: NODE, version: process.version, sha256: fileSha256(NODE) }, piModules: { path: PI_MODULES, digest: dirDigest(PI_MODULES) }, bwrap: version("/usr/bin/bwrap", ["--version"]),
    provider: { dir: "provider", digest: provider.digest, ...(provider.version ? { version: provider.version } : {}) }, catalog: { sha256: sha256(catalogRaw), prices: { [MODEL.id]: entry.cost } },
    harness, seeds: frozenSeeds, schedule: schedule(seeds),
  };
  plan.planDigest = digestOf({ ...plan, createdAt: undefined });
  await writeJson(join(frozen, "provenance.json"), { gateTemplateSha256: sha256(gateTemplate), seeds: provenance, pythonVersions: Object.fromEntries(frozenSeeds.map(seed => [seed.task, version(join(scratch, "envs", seed.task, "venv/bin/python"), ["--version"])])), providerDirDigest: dirDigest(join(frozen, "provider")) });
  await writeJson(join(frozen, "plan.json"), plan);
  return plan;
}
