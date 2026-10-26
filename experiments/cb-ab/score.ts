/**
 * Blind scoring support of the cb-ab study (results/cb-ab/PROTOCOL.md "Scoring", "Decision rules").
 *   node --import tsx experiments/cb-ab/score.ts packets <study> <casesDir>   blinded report packets per case + the sealed key
 *   node --import tsx experiments/cb-ab/score.ts analyze <study> <casesDir>   unblind the scorers' scores.json and apply the rules
 * Packets: each run's frozen final report (the worker report and main's final text) under a random label; words that name the
 * arm's required explorer or the spawn mechanics are redacted (blinding is partial: a report may still describe its own process).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, stopAfterTwo, summarizeCase, verdict, type Arm, type KScore, type RunScore } from "./protocol.js";

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

/** Arm-revealing wording removed from a packet: "Split:" lines, then explorer / spawn vocabulary. */
export function redact(text: string): string {
  return text.split("\n").filter(line => !/^\W*(split|orchestration)\b/i.test(line.trim())).join("\n")
    .replace(/\bindependent[- ]explorer\b|\bcontract[- ]backward\b|\bINVERT\b|\bVALIDATE\b|\borche_spawn\b|\bsub-?workers?\b|\bexplorers?\b|\bW\d+\.\d+\b|\bbrief\b/gi, "[redacted]")
    .replace(/\/tmp\/pi-orche\/[^\s`'")]*/g, "<scratch>");
}

export function packetText(final: any): string {
  const report = final?.report?.arguments ?? {};
  const { summary, kind: _kind, ...data } = report as Record<string, unknown>;
  const parts = [
    "## Final answer to the user",
    String(final?.text ?? "").trim() || "(none)",
    "",
    "## Task report: summary",
    typeof summary === "string" && summary.trim() ? summary.trim() : "(none)",
    "",
    "## Task report: data",
    Object.keys(data).length ? JSON.stringify(data, null, 2) : "(none)",
  ];
  return redact(parts.join("\n"));
}

function caseDirs(casesDir: string): { id: string; dir: string; task: string }[] {
  return readdirSync(casesDir).filter(name => /^c\d+-/.test(name) && existsSync(join(casesDir, name, "case.json"))).sort()
    .map(name => { const c = json(join(casesDir, name, "case.json")); return { id: c.id, dir: join(casesDir, name), task: c.task }; });
}

/**
 * Blinded packets of every case and the sealed key; `arms` (default every arm, as in round 1) limits the units, e.g. ["A"] for calibration.
 * `append` (round 2's staged validation, PROTOCOL-R2 R2-A1 item 5): add packets for cases not yet in the key, leaving every existing label
 * and packet unchanged; without it an existing key is refused, as in round 1.
 */
export function packets(study: string, casesDir: string, arms: readonly Arm[] = ARMS, append = false): void {
  const out = join(study, "scoring");
  const existing = existsSync(join(out, "key.json"));
  if (existing && !append) throw new Error(`${out}/key.json exists: packets are made once`);
  const previous = existing ? json(join(out, "packets.json")) : undefined;
  const key: Record<string, { unit: string; arm: Arm; repeat: number; finalSha256: string }> = existing ? json(join(out, "key.json")) : {};
  const index: Record<string, { label: string; packetSha256: string }[]> = existing ? { ...previous.index } : {};
  const added: string[] = [];
  for (const item of caseDirs(casesDir)) {
    if (index[item.id]) continue;
    added.push(item.id);
    const units = arms.flatMap(arm => [1, 2].map(repeat => ({ arm, repeat, dir: join(study, "runs", item.id, arm, `r${repeat}`) })));
    for (const unit of units) if (json(join(unit.dir, "meta.json")).status !== "completed") throw new Error(`${unit.dir} not completed`);
    const labels = units.map(() => randomBytes(3).toString("hex"));
    const order = units.map((unit, i) => ({ unit, label: labels[i]! })).sort((a, b) => a.label.localeCompare(b.label));
    mkdirSync(join(out, item.id, "packets"), { recursive: true });
    index[item.id] = [];
    for (const { unit, label } of order) {
      const raw = readFileSync(join(unit.dir, "final.json"));
      const text = packetText(JSON.parse(raw.toString("utf8")));
      writeFileSync(join(out, item.id, "packets", `${label}.md`), `# Report ${label}\n\n${text}\n`);
      key[label] = { unit: `${item.id}/${unit.arm}/r${unit.repeat}`, arm: unit.arm, repeat: unit.repeat, finalSha256: sha(raw) };
      index[item.id]!.push({ label, packetSha256: sha(readFileSync(join(out, item.id, "packets", `${label}.md`))) });
    }
  }
  writeFileSync(join(out, "key.json"), `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  const appended = [...(previous?.appended ?? []), ...(existing ? [{ at: new Date().toISOString(), cases: added }] : [])];
  writeFileSync(join(out, "packets.json"), `${JSON.stringify({ createdAt: previous?.createdAt ?? new Date().toISOString(), keySha256: sha(readFileSync(join(out, "key.json"))), index, ...(appended.length ? { appended } : {}) }, null, 2)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(index).map(([id, list]) => [id, list.map(item => item.label)]))));
}

/** Unblind the scorers' outputs (<study>/scoring/<case>/scores.json) and apply the predeclared rules. */
export function analyze(study: string, casesDir: string): Record<string, unknown> {
  const key = json(join(study, "scoring/key.json"));
  const runs: RunScore[] = [];
  const kItems: Record<string, string[]> = {};
  for (const item of caseDirs(casesDir)) {
    const rubric = json(join(item.dir, "rubric.json"));
    kItems[item.id] = rubric.knownDefects.map((k: any) => k.id);
    const scores = json(join(study, "scoring", item.id, "scores.json"));
    for (const [label, entry] of Object.entries<any>(scores.packets)) {
      const meta = key[label];
      if (!meta) throw new Error(`unknown label ${label}`);
      const k: KScore[] = kItems[item.id]!.map(id => { const s = (entry.k ?? []).find((x: any) => x.k === id) ?? { m: 0, l: 0, s: 0 }; return { k: id, m: s.m ? 1 : 0, l: s.l ? 1 : 0, s: s.s ? 1 : 0 }; });
      const count = (cls: string) => (entry.findings ?? []).filter((f: any) => f.class === cls).length;
      runs.push({ unit: meta.unit, caseId: item.id, arm: meta.arm, repeat: meta.repeat, k, v: count("V"), f: count("F"), u: count("U") });
    }
  }
  const cases = Object.keys(kItems).sort().map(id => summarizeCase(id, kItems[id]!, runs));
  const gate = cases.length >= 2 ? stopAfterTwo(cases[0]!, cases[1]!) : undefined;
  const result = gate ? { verdict: "not-supported" as const, stoppedByRule: true, details: verdict(cases.slice(0, 2), runs.filter(run => run.caseId === cases[0]!.caseId || run.caseId === cases[1]!.caseId)).details, descriptive: verdict(cases, runs) } : { ...verdict(cases, runs), stoppedByRule: false };
  const reproducibility = Object.fromEntries(cases.map(c => [c.caseId, Object.fromEntries(ARMS.map(arm => [arm, c.kItems.filter(k => runs.filter(run => run.caseId === c.caseId && run.arm === arm).every(run => run.k.some(item => item.k === k && item.m === 1 && item.l === 1)))]))]));
  return { runs, cases, gate, result, reproducibility };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, study, casesDir] = process.argv.slice(2);
  const armsAt = process.argv.indexOf("--arms");
  const arms = armsAt >= 0 ? String(process.argv[armsAt + 1] ?? "").split(",").filter(Boolean) : undefined;
  if (arms && (!arms.length || arms.some(arm => !(ARMS as readonly string[]).includes(arm)))) { console.error(`--arms must list arms of ${ARMS.join(", ")}`); process.exit(2); }
  if (command === "packets") packets(study!, casesDir!, (arms as Arm[] | undefined) ?? ARMS, process.argv.includes("--append"));
  else if (command === "analyze") { const out = analyze(study!, casesDir!); writeFileSync(join(study!, "scoring/analysis.json"), `${JSON.stringify(out, null, 2)}\n`); console.log(JSON.stringify(out.result, null, 2)); }
  else { console.error("usage: score.ts packets <study> <casesDir> [--arms A[,B,C]] [--append] | analyze <study> <casesDir>"); process.exit(2); }
}
