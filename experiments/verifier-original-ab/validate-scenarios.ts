/**
 * Validate a scenario module of study 2 (PREREGISTRATION-2.md) without a model:
 *
 *   npx tsx experiments/verifier-original-ab/validate-scenarios.ts experiments/verifier-original-ab/cases-2a.ts
 *
 * Checks every case: the visible suite passes, the hidden check agrees with the label, the Original request is extractable as the
 * runtime extracts it, the verify request does not already carry it verbatim, the truncated stratum puts its rule where its
 * evidenceGain says (before or after the 8,000-character cut), retracted scenarios carry the user's later message, and nothing in the
 * workspace names the case or its label. Prints one line per case and a stratum tally; exits 1 on any failure.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { casesOf, type Case, type Scenario } from "./cases.js";
import { checkTruth, materialize } from "./fixture.js";
import { originalRequestOf } from "../../src/single/ledger.js";
import { userTextCarry, VERIFIER_ORIGINAL_LIMIT } from "../../src/orchestration/handoff-evidence.js";
import { promptFor } from "./protocol.js";

const filesBelow = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return name === ".git" ? [] : statSync(path).isDirectory() ? filesBelow(path) : [path]; });

export function validateCase(item: Case, scenario: Scenario, root: string): string[] {
  const problems: string[] = [];
  const truth = checkTruth(item, join(root, "truth", item.id.replaceAll("/", "_")));
  if (!truth.visible) problems.push("visible suite fails");
  if (!truth.agrees) problems.push(`hidden check ${truth.hidden ? "passes" : "fails"} but the label is ${item.truth}`);
  const original = originalRequestOf(item.assignment);
  if (!original) problems.push("no Original request section");
  else {
    if (userTextCarry(item.request, original).carry === "verbatim") problems.push("the verify request already carries the original verbatim");
    if (!promptFor(item, "on").includes("## The user's original request")) problems.push("ON prompt has no supplement");
    if (item.stratum === "truncated" && original.length <= VERIFIER_ORIGINAL_LIMIT) problems.push("truncated case: original is not longer than 8,000 characters");
  }
  if (item.stratum === "retracted" && !scenario.later) problems.push("retracted scenario without `later`");
  if ((item.stratum === "retracted" || item.stratum === "scope") && item.truth !== "pass") problems.push(`${item.stratum} cases are compliant only`);
  const workspace = join(root, "ws", item.id.replaceAll("/", "_"));
  materialize(item, workspace);
  const text = filesBelow(workspace).map(file => readFileSync(file, "utf8")).join("\n").toLowerCase();
  for (const word of [item.id, "violat", "compliant", "ground truth", "hidden check", "retracted", "truncated", "stratum"]) if (text.includes(word.toLowerCase())) problems.push(`workspace mentions "${word}"`);
  return problems;
}

if (process.argv[1]?.endsWith("validate-scenarios.ts")) {
  const module = await import(pathToFileURL(resolve(process.argv[2]!)).href);
  const scenarios = Object.values(module).find(value => Array.isArray(value)) as Scenario[];
  const root = mkdtempSync(join(tmpdir(), "voab-validate-"));
  const tally: Record<string, number> = {};
  let failed = 0;
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) { console.log(`BAD  ${scenario.id}: duplicate scenario id`); failed++; }
    ids.add(scenario.id);
    for (const item of casesOf(scenario)) {
      const problems = validateCase(item, scenario, root);
      tally[`${item.stratum}/${item.truth}`] = (tally[`${item.stratum}/${item.truth}`] ?? 0) + 1;
      if (problems.length) failed++;
      console.log(`${problems.length ? "BAD " : "ok  "} ${item.id} (${item.stratum}, ${item.truth}, evidenceGain ${item.evidenceGain})${problems.length ? `: ${problems.join("; ")}` : ""}`);
    }
  }
  console.log(JSON.stringify(tally));
  process.exitCode = failed ? 1 : 0;
}
