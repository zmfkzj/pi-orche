/**
 * Split-judgment evaluation (docs/orchestrator.md §5): the evaluation set, the one-turn prompt and the scoring.
 * run.ts calls a model once per (item, variant, repetition); score.ts turns the raw answers into the metrics and the selection.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const CRITERIA = ["parallelism", "isolation", "verification"] as const;
export type Criterion = (typeof CRITERIA)[number];

export interface ItemSpec {
  id: string; fixture?: string; role: "implement" | "answer"; labels: Criterion[]; alsoAccept?: Criterion[][];
  units?: string[][]; title?: string; instruction?: string; files?: string[]; rationale: string;
}
export interface Item extends ItemSpec { title: string; instruction: string; files: string[] }

export const sha256 = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Files of a fixture repository with line counts, sorted (no .git, no node_modules). */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        const binary = /\.(png|jpg|jpeg|gif|webp|mp4|wav|ogg|ico)$/i.test(entry.name);
        out.push(binary ? `${rel} (binary)` : `${rel} (${fs.readFileSync(full, "utf8").split("\n").length} lines)`);
      }
    }
  };
  walk(dir);
  return out;
}

export function loadItems(file = path.join(HERE, "tasks.json")): Item[] {
  const spec = JSON.parse(fs.readFileSync(file, "utf8")) as { items: ItemSpec[] };
  return spec.items.map(item => {
    if (!item.fixture) return item as Item;
    const dir = path.join(ROOT, "fixtures", item.fixture);
    const task = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    return { ...item, title: task.title ?? item.id, instruction: task.instruction, files: listing(path.join(dir, "repo")) };
  });
}

/** The hand-off as main would write it in the single workflow, plus the repository listing the judgment may use. */
export function userMessage(item: Item): string {
  return [
    `Assignment: ${item.role}.`,
    `Intent/Purpose: ${item.title}.`,
    item.role === "answer" ? "Requirements: answer everything the Original request asks, with evidence; do not change files." : "Requirements: complete everything the Original request asks, with tests and passing project checks.",
    "Original request:",
    item.instruction,
    "",
    "Repository files:",
    ...item.files.map(file => `- ${file}`),
  ].join("\n");
}

export interface Parsed { split?: unknown; criteria?: Record<string, unknown>; units?: { name?: unknown; files?: unknown }[]; reason?: unknown }
export function parseAnswer(text: string): Parsed | undefined {
  const match = /\{[\s\S]*\}/.exec(text);
  try { return match ? JSON.parse(match[0]) as Parsed : undefined; } catch { return undefined; }
}

/** The predicted criteria set: [] when split is false; "?" marks a split that names no criterion. */
export function predictedSet(parsed: Parsed | undefined): string[] | undefined {
  if (!parsed || typeof parsed.split !== "boolean") return undefined;
  if (!parsed.split) return [];
  const set = CRITERIA.filter(name => parsed.criteria?.[name] === true);
  return set.length ? [...set] : ["?"];
}

const key = (set: readonly string[]) => [...set].sort().join("+") || "none";
export const acceptable = (item: Item): string[][] => [item.labels, ...(item.alsoAccept ?? [])];
export const isCorrect = (item: Item, set: readonly string[]) => acceptable(item).some(ok => key(ok) === key(set));

/** Unit agreement of a predicted parallel split: compatible = every expected unit lies in exactly one predicted unit and every predicted unit covers an expected one; exact = also one-to-one. */
export function unitAgreement(item: Item, parsed: Parsed | undefined): { compatible: boolean; exact: boolean } | undefined {
  if (!item.units?.length) return undefined;
  const predicted = Array.isArray(parsed?.units) ? parsed!.units : [];
  const haystacks = predicted.map(unit => [typeof unit?.name === "string" ? unit.name : "", ...(Array.isArray(unit?.files) ? unit.files.filter((file): file is string => typeof file === "string") : [])].join(" ").toLowerCase());
  const covers = haystacks.map(text => item.units!.flatMap((tokens, index) => tokens.some(token => text.includes(token.toLowerCase())) ? [index] : []));
  const owners = item.units.map((_tokens, index) => covers.filter(list => list.includes(index)).length);
  const compatible = predicted.length > 0 && owners.every(count => count === 1) && covers.every(list => list.length > 0);
  return { compatible, exact: compatible && covers.every(list => list.length === 1) && predicted.length === item.units.length };
}

export interface RawCall {
  item: string; variant: string; rep: number; model: string; thinking: string; ms: number; text?: string; error?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } };
}

export interface Metrics {
  model: string; variant: string; calls: number; reps: number; parseFailures: number; accuracy: number;
  falseSplit: number; unnecessaryParallel: number; missedParallel: number;
  falseIsolation: number; missedIsolation: number; falseVerification: number; missedVerification: number;
  unitCompatible: number | null; unitExact: number | null; unitCases: number; consistency: number | null;
  costUSD: number; outputTokens: number; promptChars: number; errors: string[];
}

const rate = (hits: number, total: number) => total ? hits / total : 0;

export function metrics(items: readonly Item[], calls: readonly RawCall[], model: string, variant: string, promptChars: number): Metrics {
  const byItem = new Map(items.map(item => [item.id, item]));
  const mine = calls.filter(call => call.model === model && call.variant === variant && byItem.has(call.item));
  const reps = new Set(mine.map(call => call.rep)).size;
  const rows = mine.map(call => { const parsed = call.text ? parseAnswer(call.text) : undefined; return { call, item: byItem.get(call.item)!, parsed, set: predictedSet(parsed) }; });
  const has = (set: readonly string[] | undefined, name: string) => !!set?.includes(name);
  const everyOk = (item: Item, test: (set: readonly string[]) => boolean) => acceptable(item).every(test);
  const counted = (pool: typeof rows, hit: (row: typeof rows[number]) => boolean) => rate(pool.filter(hit).length, pool.length);
  const none = rows.filter(row => row.item.labels.length === 0);
  const noP = rows.filter(row => everyOk(row.item, set => !set.includes("parallelism")));
  const needP = rows.filter(row => everyOk(row.item, set => set.includes("parallelism")));
  const noI = rows.filter(row => everyOk(row.item, set => !set.includes("isolation")));
  const needI = rows.filter(row => everyOk(row.item, set => set.includes("isolation")));
  const noV = rows.filter(row => everyOk(row.item, set => !set.includes("verification")));
  const needV = rows.filter(row => everyOk(row.item, set => set.includes("verification")));
  const unitRows = rows.filter(row => row.item.labels.includes("parallelism") && row.item.units?.length && has(row.set, "parallelism"));
  const units = unitRows.map(row => unitAgreement(row.item, row.parsed)!);
  const consistent = reps > 1 ? items.filter(item => { const sets = rows.filter(row => row.item.id === item.id).map(row => row.set ? key(row.set) : "parse-failure"); return sets.length > 1 && sets.every(set => set === sets[0]); }).length : null;
  return {
    model, variant, calls: rows.length, reps, parseFailures: rows.filter(row => !row.set).length,
    accuracy: counted(rows, row => !!row.set && isCorrect(row.item, row.set)),
    falseSplit: counted(none, row => !!row.set && row.set.length > 0),
    unnecessaryParallel: counted(noP, row => has(row.set, "parallelism")),
    missedParallel: counted(needP, row => !has(row.set, "parallelism")),
    falseIsolation: counted(noI, row => has(row.set, "isolation")),
    missedIsolation: counted(needI, row => !has(row.set, "isolation")),
    falseVerification: counted(noV, row => has(row.set, "verification")),
    missedVerification: counted(needV, row => !has(row.set, "verification")),
    unitCompatible: units.length ? rate(units.filter(unit => unit.compatible).length, units.length) : null,
    unitExact: units.length ? rate(units.filter(unit => unit.exact).length, units.length) : null,
    unitCases: units.length,
    consistency: consistent === null ? null : rate(consistent, items.length),
    costUSD: mine.reduce((sum, call) => sum + (call.usage?.cost?.total ?? 0), 0),
    outputTokens: mine.reduce((sum, call) => sum + (call.usage?.output ?? 0), 0),
    promptChars,
    errors: rows.filter(row => !row.set || !isCorrect(row.item, row.set)).map(row => `${row.item.id}#${row.call.rep}:${key(row.item.labels)}->${row.set ? key(row.set) : "parse-failure"}`),
  };
}

/**
 * The pre-registered selection rule (docs/orchestrator.md §5.4), applied to the main model's metrics:
 * eligible = false split ≤ 10% and missed parallelism ≤ 1/3; the most accurate eligible variant wins; accuracies within one
 * item (1/items) are a tie, broken by lower false split, lower missed parallelism, higher unit compatibility, higher consistency,
 * shorter text. Without an eligible variant: the lowest false split + missed parallelism, then the higher accuracy.
 */
export function select(all: readonly Metrics[], items: number): { winner: string; eligible: string[]; reason: string } {
  const eligible = all.filter(m => m.falseSplit <= 0.10 + 1e-9 && m.missedParallel <= 1 / 3 + 1e-9);
  const tieBreak = (a: Metrics, b: Metrics) => a.falseSplit - b.falseSplit || a.missedParallel - b.missedParallel || (b.unitCompatible ?? 0) - (a.unitCompatible ?? 0) || (b.consistency ?? 0) - (a.consistency ?? 0) || a.promptChars - b.promptChars;
  if (eligible.length) {
    const best = Math.max(...eligible.map(m => m.accuracy));
    const tied = eligible.filter(m => best - m.accuracy <= 1 / items + 1e-9).sort(tieBreak);
    return { winner: tied[0]!.variant, eligible: eligible.map(m => m.variant), reason: tied.length > 1 ? `best accuracy ${best.toFixed(3)}; tie among ${tied.map(m => m.variant).join(", ")} broken by false split / missed parallel / units / consistency / length` : `highest accuracy ${best.toFixed(3)} among eligible` };
  }
  const sorted = [...all].sort((a, b) => (a.falseSplit + a.missedParallel) - (b.falseSplit + b.missedParallel) || b.accuracy - a.accuracy);
  return { winner: sorted[0]!.variant, eligible: [], reason: "no variant met the eligibility bounds; lowest false split + missed parallelism" };
}
