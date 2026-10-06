// Summarize the end-to-end orchestrator smoke (docs/orchestrator.md 6): one row per session of experiments/workflow/driver.ts.
//
// Usage: npx --no-install tsx experiments/orchestrator-smoke/summarize.ts <driver out dir (plan.out)> [--prices <provider models json>] [--out file.md]
//
// Per session: the hidden-test grade, the solver wall time of the task, requests and tokens of the main session and of every orche
// transcript (orchestrator, sub-workers; from the session files via the driver's `meta.usage`), the provider-reported cost and a
// catalog-price estimate, what main delegated (orche_task roles), and the orchestrator's split decision and sub-workers (from the
// orche_task results in the main session).
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string) => { const index = argv.indexOf(name); if (index < 0) return undefined; const found = argv[index + 1]; argv.splice(index, 2); return found; };
const pricesFile = flag("--prices") ?? path.join(process.env.HOME ?? "", ".pi/agent/cliproxyapi-models.json");
const outFile = flag("--out");
const root = argv[0];
if (!root) throw new Error("usage: summarize.ts <driver out dir> [--prices file] [--out file.md]");

interface Usage { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; unknownUsage: number; models: Record<string, number>; maxInput: number }
interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Catalog prices per million tokens by model id (`provider/id` keys use the id). */
function loadPrices(file: string): Map<string, Price> {
  const prices = new Map<string, Price>();
  if (!fs.existsSync(file)) return prices;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && record.cost && typeof record.cost === "object") prices.set(record.id, record.cost as Price);
    Object.values(record).forEach(visit);
  };
  visit(JSON.parse(fs.readFileSync(file, "utf8")));
  return prices;
}
const prices = loadPrices(pricesFile);
/** Catalog estimate: valid only when every request used one model (the driver's parity check), else undefined. */
function catalog(usage: Usage): number | undefined {
  const models = Object.keys(usage.models);
  if (models.length !== 1) return models.length ? undefined : 0;
  const price = prices.get(models[0]!.split("/").slice(1).join("/"));
  if (!price) return undefined;
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1e6;
}

const jsonl = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? jsonl(path.join(dir, entry.name)) : entry.name.endsWith(".jsonl") ? [path.join(dir, entry.name)] : []);
/** The orche_task results of the main session: their split decision, sub-workers and the orchestrator's own requests. */
function taskResults(sessionDir: string) {
  const results: { role?: string; split?: { decision: string; criteria?: string[]; reason: string }; spawned?: { name: string; role: string; reason: string; status: string; requests: number; durationMs: number; costUSD: number }[]; requests?: number; durationMs?: number }[] = [];
  for (const file of jsonl(sessionDir)) for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || message.toolName !== "orche_task") continue;
    const details = message.details ?? {};
    results.push({ role: details.role, split: details.split, spawned: details.spawned, requests: details.requests, durationMs: details.durationMs });
  }
  return results;
}

const sessions = fs.readdirSync(path.join(root, "sessions")).sort();
const rows: string[] = [];
const records: unknown[] = [];
for (const id of sessions) {
  const dir = path.join(root, "sessions", id);
  if (!fs.existsSync(path.join(dir, "meta.json"))) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const turn = meta.turns?.[0] ?? {};
  const main: Usage = meta.usage?.main; const orche: Usage = meta.usage?.orche;
  const tasks = taskResults(path.join(dir, "sessions"));
  const splits = tasks.filter(task => task.split || task.spawned).map(task => {
    const split = task.split ? (task.split.decision === "none" ? "none" : (task.split.criteria ?? []).join("+")) : "none (not reported)";
    const subs = (task.spawned ?? []).map(sub => `${sub.name}:${sub.role}/${sub.status} ${sub.requests}req ${Math.round(sub.durationMs / 1000)}s`).join(", ");
    return `${split}${subs ? ` [${subs}]` : ""}`;
  });
  const split = splits.join("; ") || (meta.arm.startsWith("baseline") ? "n/a" : "none (not reported)");
  const delegated = (meta.front ?? []).map((call: { role?: string }) => call.role).join(", ");
  const total = main && orche ? { requests: main.requests + orche.requests, input: main.input + orche.input, output: main.output + orche.output, cacheRead: main.cacheRead + orche.cacheRead, cacheWrite: main.cacheWrite + orche.cacheWrite } : undefined;
  const providerCost = main && orche ? main.cost + orche.cost : undefined;
  const catalogCost = main && orche ? [catalog(main), catalog(orche)].every(value => value !== undefined) ? catalog(main)! + catalog(orche)! : undefined : undefined;
  const unknown = (main?.unknownUsage ?? 0) + (orche?.unknownUsage ?? 0);
  records.push({ id, arm: meta.arm, task: turn.taskId, status: meta.status, passed: turn.grade?.passed ?? null, wallClockMs: turn.wallClockMs ?? null, delegated, split, tasks, usage: meta.usage, total, providerCost, catalogCost, unknownUsage: unknown, parity: meta.parity?.passed ?? null });
  rows.push(`| ${meta.arm} | ${turn.taskId ?? "?"} | ${turn.grade ? (turn.grade.passed ? "pass" : "FAIL") : meta.status} | ${turn.wallClockMs ? Math.round(turn.wallClockMs / 1000) : "–"} | ${delegated || "–"} | ${split} | ${main?.requests ?? "–"} / ${orche?.requests ?? "–"} | ${total ? `${Math.round(total.input / 1000)}k / ${Math.round(total.output / 1000)}k / ${Math.round(total.cacheRead / 1000)}k / ${Math.round(total.cacheWrite / 1000)}k` : "–"} | ${main ? Math.round(main.maxInput / 1000) : "–"}k | ${providerCost !== undefined ? `$${providerCost.toFixed(2)}` : "–"} | ${catalogCost !== undefined ? `$${catalogCost.toFixed(2)}` : "–"} | ${meta.parity?.passed ? "ok" : "MISMATCH"}${unknown ? `, ${unknown} unknown usage` : ""} |`);
}
const lines = [
  "| Arm | Task | Hidden-test grade | Wall s | Main delegated | Orchestrator split [sub-workers] | Requests main / orche | Tokens in / out / cache read / cache write | Main context max | Provider cost | Catalog cost | Parity |",
  "|---|---|---|---:|---|---|---|---|---:|---:|---:|---|",
  ...rows,
];
const text = `${lines.join("\n")}\n`;
if (outFile) { fs.writeFileSync(outFile, text); fs.writeFileSync(outFile.replace(/\.md$/, ".json"), `${JSON.stringify(records, null, 1)}\n`); }
process.stdout.write(text);
