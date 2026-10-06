/**
 * Marginal yield of each workflow capability (docs/workflow-policy.md 4), computed offline from orche task records: every record
 * directory below the given roots that holds `workflow.json` (investigation/creation policies) or `frame.json` (execution v2).
 *
 *   npx tsx experiments/workflow/yield.ts <records-dir> [more dirs] [--json out.json]
 *
 * critic_yield      = critic calls with ≥1 material finding the Primary accepted (fully or partly) / critic calls
 * divergence_yield  = deliverables refined from a candidate other than A (the conventional direction) / critic selections
 * framer_proxy      = implied + edge requirements per frame (an upper bound: whether the Primary would have missed them needs the
 *                     blind judgement of the pre-registration; this script never claims it)
 * Costs are the specialists' own (the Primary's rounds are in run.json). No LLM calls, no network.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The workflow policies were removed from the product (docs/orchestrator.md 4); the record shapes and the two yield predicates are
// kept here so this script still reads the records written while they existed.
interface CritiqueFinding { id: string; severity: "material" | "minor"; kind: string; issue: string }
interface CritiqueOutcome {
  trigger: { run: boolean; reason: string };
  critique?: { verdict: string; findings: CritiqueFinding[] };
  responses?: { id: string; response: "accepted" | "rebutted" | "partly"; reason?: string }[];
  conclusionChanged?: boolean;
  synthesisRounds: number;
}
interface DivergenceOutcome {
  candidates: number; scratch: string; order?: string[];
  generated?: { id: string; direction: string; summary: string; outputs: string[] }[];
  selection?: { selected: number; acceptable: boolean; rationale: string; candidates: { label: number; compliance: number; quality: number; fit: number }[] };
  selected?: string; refineRounds: number;
}
interface WorkflowDetails {
  type: "investigation" | "execution" | "creation"; policy: string; critique?: CritiqueOutcome; divergence?: DivergenceOutcome; next?: "execution";
  specialists: { actor: string; requests: number; usage: { cost: number } }[]; notes?: string[];
}
/** critic_yield numerator: a material finding the Primary accepted (fully or partly). */
const critiqueYielded = (outcome: CritiqueOutcome): boolean => !!outcome.responses?.some(item => item.response !== "rebutted");
/** divergence_yield numerator: the refined deliverable came from a candidate other than A (the conventional direction). */
const divergenceYielded = (outcome: DivergenceOutcome): boolean => !!outcome.selected && outcome.selected !== "A" && outcome.selected !== "self";

export interface Found { dir: string; workflow?: WorkflowDetails & { status?: string }; frame?: { requirements: { kind: string }[] } }

/** Every record directory with `workflow.json` or `frame.json` below the roots. */
export async function findRecords(roots: readonly string[]): Promise<Found[]> {
  const found: Found[] = [];
  for (const root of roots) await walk(root, found);
  return found;
}

async function walk(dir: string, out: Found[], depth = 0): Promise<void> {
  if (depth > 6) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
  if (names.has("workflow.json") || names.has("frame.json")) {
    const read = async (name: string) => names.has(name) ? JSON.parse(await readFile(join(dir, name), "utf8")) : undefined;
    out.push({ dir, workflow: await read("workflow.json"), frame: await read("frame.json") });
  }
  for (const entry of entries) if (entry.isDirectory() && entry.name !== "sessions" && entry.name !== "workers") await walk(join(dir, entry.name), out, depth + 1);
}

const ratio = (num: number, den: number) => den ? { num, den, value: Math.round((num / den) * 1000) / 1000 } : { num, den, value: null };
const costOf = (details: WorkflowDetails) => details.specialists.reduce((sum, stats) => ({ requests: sum.requests + stats.requests, cost: sum.cost + stats.usage.cost }), { requests: 0, cost: 0 });

export function summarize(found: readonly Found[]) {
  const investigation = found.flatMap(item => item.workflow?.type === "investigation" && item.workflow.critique ? [item.workflow] : []);
  const triggered = investigation.filter(item => item.critique!.trigger.run);
  const critiqued = triggered.filter(item => item.critique!.critique);
  const withMaterial = critiqued.filter(item => item.critique!.critique!.findings.some(finding => finding.severity === "material"));
  const findings = critiqued.flatMap(item => item.critique!.critique!.findings);
  const responses = triggered.flatMap(item => item.critique!.responses ?? []);
  const triggers: Record<string, number> = {};
  for (const item of triggered) triggers[item.critique!.trigger.reason] = (triggers[item.critique!.trigger.reason] ?? 0) + 1;

  const creation = found.flatMap(item => item.workflow?.type === "creation" && item.workflow.divergence ? [item.workflow] : []);
  const selected = creation.filter(item => item.divergence!.selection);
  const positions: Record<string, number> = {};
  for (const item of selected) {
    const label = item.divergence!.selection!.selected;
    positions[`label ${label}`] = (positions[`label ${label}`] ?? 0) + 1;
  }
  const frames = found.flatMap(item => item.frame ? [item.frame] : []);
  const added = frames.map(frame => frame.requirements.filter(requirement => requirement.kind === "implied" || requirement.kind === "edge").length);
  const sum = (values: readonly { requests: number; cost: number }[]) => values.reduce((total, value) => ({ requests: total.requests + value.requests, cost: Math.round((total.cost + value.cost) * 10_000) / 10_000 }), { requests: 0, cost: 0 });
  return {
    investigation: {
      answers: investigation.length,
      criticRate: ratio(triggered.length, investigation.length),
      triggers,
      critiques: critiqued.length,
      materialRate: ratio(withMaterial.length, critiqued.length),
      findings: { material: findings.filter(item => item.severity === "material").length, minor: findings.filter(item => item.severity === "minor").length },
      responses: { accepted: responses.filter(item => item.response === "accepted").length, partly: responses.filter(item => item.response === "partly").length, rebutted: responses.filter(item => item.response === "rebutted").length },
      criticYield: ratio(triggered.filter(item => critiqueYielded(item.critique!)).length, triggered.length),
      conclusionChanged: ratio(triggered.filter(item => item.critique!.conclusionChanged).length, triggered.length),
      specialistCost: sum(triggered.map(costOf)),
    },
    creation: {
      divergentRuns: creation.length,
      selections: selected.length,
      divergenceYield: ratio(selected.filter(item => divergenceYielded(item.divergence!)).length, selected.length),
      // Position bias check: with a shuffled order, labels should be picked about equally often.
      selectedLabel: positions,
      noAcceptableCandidate: selected.filter(item => !item.divergence!.selection!.acceptable).length,
      specialistCost: sum(creation.map(costOf)),
    },
    execution: {
      frames: frames.length,
      framerProxy: frames.length ? { meanImpliedOrEdge: Math.round((added.reduce((a, b) => a + b, 0) / frames.length) * 100) / 100, note: "upper bound; needs blind judgement" } : null,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf("--json");
  const out = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
  const roots = args.filter((arg, index) => arg !== "--json" && (jsonAt < 0 || index !== jsonAt + 1));
  if (!roots.length) { console.error("usage: npx tsx experiments/workflow/yield.ts <records-dir> [...] [--json out.json]"); process.exit(2); }
  const found = await findRecords(roots);
  const summary = summarize(found);
  if (out) await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}
