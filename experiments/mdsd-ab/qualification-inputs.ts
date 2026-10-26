/**
 * Frozen inputs and references for the qualification study, technical retry 1 (results/qualification-validation-retry1).
 * The first attempt (results/qualification-validation) is read, never written; its code is preserved byte-for-byte in
 * results/qualification-validation/code-snapshot-first-attempt.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, sha, write, readJsonl } from "./run.js";
import { QV, UNITS, unitInput, treeHashes } from "./synthesis.js";
export const FIRST = join(REPO, "results/qualification-validation");
export const ROOT = join(REPO, "results/qualification-validation-retry1");
export const json = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
export const text = (file: string) => readFileSync(file, "utf8");
export const CASE = (unit: string) => unit.startsWith("dev") ? "dev" : "isort";
export interface Claim { ref: string; claim: string; quote: string; stance: string; locations: string[]; source: string }
export interface Key { base: string; byK: Record<string, { ref: string; origin: string }>; byRef: Record<string, string> }
export const listFiles = (root: string): string[] => existsSync(root) ? readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? listFiles(join(root, entry.name)) : [join(root, entry.name)]) : [];
/** Source aliases. The first attempt used D1/D2, which collide with the dev guide's section labels D1-D5 and defect numbering. */
export const DOCS = ["doc-A", "doc-B"] as const;
export interface Sub { at: number; from: string; to: string; kind: string }
/**
 * Replaces only author/answer identity tokens, each with a kind-specific rule, and returns every substitution so the original is
 * exactly recoverable (restore). Never touched: shell variables ($S, ${S}), assignments (S=...), other words, code, commands or
 * citations. `origin` maps the stage letters (S/E) and packet labels (P1/P2) to doc aliases; run directories get run-<alias>.
 * Lookbehinds treat a JSON escape such as \n before a token as a separator, so serialized records are handled like prose.
 */
export function neutralizeText(source: string, origin: Record<string, string>): { text: string; subs: Sub[] } {
  const letters = Object.keys(origin).filter(k => /^[SE]$/.test(k)).join("");
  const packets = Object.keys(origin).filter(k => /^P[12]$/.test(k)).map(k => k.slice(1)).join("");
  const notAfter = String.raw`(?<![$.{}\-\\])(?<!(?<!\\)\w)`;
  const rules: { kind: string; re: RegExp; to: (m: RegExpExecArray) => string }[] = [
    { kind: "run-dir", re: /qv-(?:dev|isort)-r\d-([SE])\b/g, to: m => `run-${origin[m[1]!]}` },
    ...(letters ? [{ kind: "stage-ref", re: new RegExp(`${notAfter}([${letters}])(?=:c\\d)`, "g"), to: (m: RegExpExecArray) => origin[m[1]!]! }] : []),
    ...(letters ? [{ kind: "stage-path", re: new RegExp(`${notAfter}([${letters}])(?=/[\\w.\\-])`, "g"), to: (m: RegExpExecArray) => origin[m[1]!]! }] : []),
    ...(packets ? [{ kind: "packet-label", re: new RegExp(`(?<![\\w$])P([${packets}])(?=:c\\d|\\.md\\b)`, "g"), to: (m: RegExpExecArray) => origin[`P${m[1]}`]! }] : []),
  ];
  const hits: { start: number; end: number; to: string; kind: string }[] = [];
  for (const rule of rules) {
    for (let m = rule.re.exec(source); m; m = rule.re.exec(source)) {
      const start = m.index, end = m.index + m[0].length;
      if (!hits.some(h => start < h.end && h.start < end)) hits.push({ start, end, to: rule.to(m), kind: rule.kind });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  let out = "", last = 0;
  const subs: Sub[] = [];
  for (const h of hits) { out += source.slice(last, h.start); subs.push({ at: out.length, from: source.slice(h.start, h.end), to: h.to, kind: h.kind }); out += h.to; last = h.end; }
  return { text: out + source.slice(last), subs };
}
export function restore(neutralized: string, subs: Sub[]): string {
  let out = neutralized;
  for (const s of [...subs].sort((a, b) => b.at - a.at)) {
    if (out.slice(s.at, s.at + s.to.length) !== s.to) throw new Error(`restore: alias mismatch at ${s.at}`);
    out = out.slice(0, s.at) + s.from + out.slice(s.at + s.to.length);
  }
  return out;
}
/** Alias tokens must not already occur in the raw material, otherwise a reader could not tell an alias from source text. */
export function aliasCollisions(raw: string): string[] { return [...DOCS, ...DOCS.map(d => `run-${d}`)].filter(alias => raw.includes(alias)); }
interface Raw { files: Record<string, string>; claims: any[]; origin: Record<string, string>; base: string; hashes: Record<string, string>; caseId: string; provenance: any[] }
/** The unmodified source material of one unit: task, both answers, registered claims and the recorded tool evidence of both runs. */
export function rawUnit(unit: string): Raw {
  const input = unitInput(unit), seed = json(join(QV, unit, "seed.json"));
  const origin: Record<string, string> = { P1: DOCS[0], P2: DOCS[1], [seed.key.P1]: DOCS[0], [seed.key.P2]: DOCS[1] };
  const files: Record<string, string> = { "task.md": input.task, [`${DOCS[0]}.md`]: input.P1, [`${DOCS[1]}.md`]: input.P2 };
  const provenance: any[] = [];
  for (const p of ["P1", "P2"] as const) {
    const stageName = seed.key[p], source = origin[p]!, stage = join(QV, unit, stageName);
    // Tool records only; no parent/user prompts, assistant commentary, routing labels, prior evaluator material or credentials.
    const logs = [...listFiles(join(stage, "sessions")), ...listFiles(join(stage, "records"))].filter(f => f.endsWith(".jsonl") && !f.includes("advisor") && !f.endsWith("events.jsonl") && !f.endsWith("split-log.jsonl"));
    const records: string[] = [];
    for (const file of logs) {
      const calls = new Map<string, any>();
      for (const event of readJsonl(file)) {
        const m = event.message ?? event;
        if (m.role === "assistant" && Array.isArray(m.content)) for (const part of m.content) if (part.type === "toolCall") calls.set(part.id, part);
        if (m.role !== "toolResult" || !/^(read|bash|grep|find|ls|ast_search|diagnostics)$/.test(m.toolName ?? "")) continue;
        const call = calls.get(m.toolCallId);
        records.push(JSON.stringify({ id: `ev-${records.length + 1}`, type: "recorded tool result", at: event.timestamp ?? m.timestamp, tool: m.toolName, arguments: call?.arguments, result: m.content, isError: m.isError ?? false }));
      }
    }
    files[`${source}-evidence.jsonl`] = records.join("\n") + "\n";
    const meta = json(join(stage, "meta.json"));
    provenance.push({ source, snapshot: meta.target?.head, originalStartedAt: meta.startedAt, endedAt: meta.endedAt, toolRecords: records.length, limitations: "These are frozen recorded tool outputs of the original analysis run, not new executions. Some referenced files were temporary and are not available. A missing record is not proof of fabrication. Search this JSONL by path or command rather than reading all of it. Run and source labels are replaced by the aliases doc-A/doc-B (run-doc-A/run-doc-B); commands, shell variables and citations are otherwise verbatim." });
  }
  return { files, claims: input.claims, origin, base: input.baseLabel === "P1" ? DOCS[0] : DOCS[1], hashes: input.hashes, caseId: input.caseId, provenance };
}
/** One unit's neutral packet (no key, no labels) and its private key; throws on alias collisions or on any non-exact round trip. */
export function neutral(unit: string): { files: Record<string, string>; key: Key & { substitutions: Record<string, Record<string, number>>; exact: any }; sourceHashes: Record<string, string> } {
  const raw = rawUnit(unit), counts: Record<string, Record<string, number>> = {};
  // Collisions are checked on the original payloads (documents, claims, recorded tool arguments/results), before any alias exists.
  const all = Object.values(raw.files).join("\n") + JSON.stringify(raw.claims);
  const collisions = aliasCollisions(all);
  if (collisions.length) throw new Error(`${unit}: alias tokens already in raw material: ${collisions.join(", ")}`);
  const exact: { files: Record<string, Sub[]>; claims: { ref: string; field: string; subs: Sub[] }[] } = { files: {}, claims: [] };
  const apply = (name: string, body: string, keep?: (subs: Sub[]) => void) => {
    const { text: out, subs } = neutralizeText(body, raw.origin);
    if (restore(out, subs) !== body) throw new Error(`${unit}/${name}: neutralization is not exactly reversible`);
    for (const s of subs) { counts[name] ??= {}; counts[name]![s.kind] = (counts[name]![s.kind] ?? 0) + 1; }
    keep?.(subs);
    return out;
  };
  const byK: Key["byK"] = {}, byRef: Key["byRef"] = {}, seed = json(join(QV, unit, "seed.json"));
  const claims: Claim[] = [...raw.claims].sort((a, b) => sha(`qualification:${unit}:${a.ref}`).localeCompare(sha(`qualification:${unit}:${b.ref}`))).map((c, i) => {
    const ref = `k${i + 1}`;
    byK[ref] = { ref: c.ref, origin: seed.map[c.ref] };
    byRef[c.ref] = ref;
    const field = (name: string) => (subs: Sub[]) => { if (subs.length) exact.claims.push({ ref, field: name, subs }); };
    return { ref, claim: apply("claims", c.claim, field("claim")), quote: apply("claims", c.quote ?? "", field("quote")), stance: c.stance ?? "asserted", locations: (c.locations ?? []).map((p: string, i: number) => apply("claims", p, field(`locations.${i}`))), source: c.ref.startsWith("P1:") ? DOCS[0] : DOCS[1] };
  });
  const files: Record<string, string> = {
    "guide.md": text(join(FIRST, "guides", `${raw.caseId}.md`)),
    "claims.json": JSON.stringify({ claims }, null, 1) + "\n",
    "claims.md": claims.map(c => `- ${c.ref} (${c.source}, ${c.stance}): ${c.claim}\n  Quote: ${c.quote}\n  Locations: ${c.locations.join("; ")}`).join("\n"),
    "evidence-index.json": JSON.stringify({ sources: raw.provenance }, null, 1),
  };
  // Only identity tokens are aliased (exactly reversible, every substitution kept in the private key); recorded commands, shell
  // variables, arguments, results and citations are otherwise byte-identical. task.md has no identity tokens and is copied as is.
  for (const [name, body] of Object.entries(raw.files)) files[name] = name === "task.md" ? body : apply(name, body, subs => { exact.files[name] = subs; });
  for (const name of DOCS.map(d => `${d}-evidence.jsonl`)) for (const line of files[name]!.split("\n").filter(Boolean)) JSON.parse(line); // still valid JSON lines
  return { files, key: { base: raw.base, byK, byRef, substitutions: counts, exact }, sourceHashes: raw.hashes };
}
export function packet(unit: string): Record<string, string> {
  const dir = join(ROOT, "inputs", unit);
  return Object.fromEntries(readdirSync(dir).map(name => [name, text(join(dir, name))]));
}
export const claimsOf = (unit: string): Claim[] => json(join(ROOT, "inputs", unit, "claims.json")).claims;
export const keyOf = (unit: string): Key => json(join(ROOT, "keys", `${unit}.json`));
export const SUPPORT = ["supported", "refuted", "insufficient", "conflicting"] as const;
export const RELEVANCE = ["finding", "supporting", "requested_context", "out", "ambiguous"] as const;
export const SALIENCE = ["essential", "detail", "context"] as const;
export function validateReferences(ids: string[], data: any): string[] {
  const errors: string[] = [], seen = new Set<string>();
  if (!Array.isArray(data?.items)) return ["no items array"];
  for (const e of data.items) {
    if (!ids.includes(e.id)) errors.push(`unknown ${e.id}`);
    if (seen.has(e.id)) errors.push(`duplicate ${e.id}`);
    seen.add(e.id);
    if (!(SUPPORT as readonly string[]).includes(e.support)) errors.push(`${e.id}: support`);
    if (!(RELEVANCE as readonly string[]).includes(e.relevance)) errors.push(`${e.id}: relevance`);
    if (!(SALIENCE as readonly string[]).includes(e.salience)) errors.push(`${e.id}: salience`);
    for (const field of ["supportBasis", "scopeBasis"]) if (!String(e[field] ?? "").trim()) errors.push(`${e.id}: missing ${field}`);
    if (!Array.isArray(e.equivalentTo) || e.equivalentTo.some((id: string) => id === e.id || !ids.includes(id))) errors.push(`${e.id}: equivalentTo`);
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`missing ${id}`);
  return errors;
}
/**
 * Parent citation-range correction: a cited line range that ends past the end of the cited file at the snapshot is clamped to the
 * file's last line. The file is matched by its full path or by its bare basename (not a longer name such as strong-ultra.test.ts).
 * Labels are not changed; every correction is listed with the original and corrected text.
 */
export function clampCitations(basis: string, file: string, lines: number): { text: string; changes: { from: string; to: string }[] } {
  const changes: { from: string; to: string }[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const slash = file.lastIndexOf("/"), dir = file.slice(0, slash + 1), base = file.slice(slash + 1);
  const out = basis.replace(new RegExp(`(?<![\\w./-])((?:${esc(dir)})?${esc(base)}:)([0-9,\\-–]+)`, "g"), (whole, prefix: string, ranges: string) => {
    const fixed = ranges.replace(/(\d+)([-–])(\d+)/g, (r, a: string, dash: string, b: string) => Number(b) > lines && Number(a) <= lines ? `${a}${dash}${lines}` : r);
    if (fixed !== ranges) changes.push({ from: `${prefix}${ranges}`, to: `${prefix}${fixed}` });
    return `${prefix}${fixed}`;
  });
  return { text: out, changes };
}
export async function prepareInputs(): Promise<void> {
  if (existsSync(join(ROOT, "inputs-frozen.json"))) throw new Error("inputs already frozen; never overwrite");
  for (const file of ["protocol.md", "retry-protocol.md"]) if (!existsSync(join(ROOT, file))) throw new Error(`${file} must exist before inputs are frozen`);
  if (sha(text(join(ROOT, "protocol.md"))) !== json(join(FIRST, "manifest.json")).protocol) throw new Error("protocol.md is not the first attempt's frozen protocol");
  await mkdir(join(ROOT, "guides"), { recursive: true });
  for (const name of ["dev.md", "isort.md"]) { await copyFile(join(FIRST, "guides", name), join(ROOT, "guides", name)); if (text(join(ROOT, "guides", name)) !== text(join(FIRST, "guides", name))) throw new Error("guide copy differs"); }
  const prior: Record<string, unknown> = {};
  for (const name of ["quality-validation", "synthesis-validation", "qualification-validation"]) prior[name] = treeHashes(join(REPO, "results", name));
  await write(join(ROOT, "prior-hashes.json"), prior);
  const units: any = {}, firstFrozen = json(join(FIRST, "inputs-frozen.json"));
  for (const unit of UNITS) {
    const p = neutral(unit), firstKey = json(join(FIRST, "keys", `${unit}.json`));
    if (JSON.stringify(p.key.byRef) !== JSON.stringify(firstKey.byRef)) throw new Error(`${unit}: k-id assignment differs from the first attempt`);
    if (p.files["guide.md"] !== text(join(ROOT, "guides", `${CASE(unit)}.md`)) || sha(p.files["guide.md"]!) !== firstFrozen.units[unit].files["guide.md"]) throw new Error(`${unit}: guide differs from the first attempt`);
    await mkdir(join(ROOT, "inputs", unit), { recursive: true });
    await mkdir(join(ROOT, "keys"), { recursive: true });
    for (const [name, body] of Object.entries(p.files)) await writeFile(join(ROOT, "inputs", unit, name), body);
    await write(join(ROOT, "keys", `${unit}.json`), p.key);
    units[unit] = { sources: p.sourceHashes, files: Object.fromEntries(Object.entries(p.files).map(([name, body]) => [name, sha(body)])), claims: Object.keys(p.key.byK).length, substitutions: p.key.substitutions };
  }
  await write(join(ROOT, "inputs-frozen.json"), { frozenAt: new Date().toISOString(), firstAttempt: { root: "results/qualification-validation", manifestSha256: sha(text(join(FIRST, "manifest.json"))), inputsFrozenSha256: sha(text(join(FIRST, "inputs-frozen.json"))) }, units, protocol: sha(text(join(ROOT, "protocol.md"))), retryProtocol: sha(text(join(ROOT, "retry-protocol.md"))), builder: sha(text(fileURLToPath(import.meta.url))) });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(units).map(([unit, v]: [string, any]) => [unit, { claims: v.claims, substitutions: v.substitutions }]))));
}
/** Recovers what exists from the first attempt's reference round (no new labelling) and freezes this retry's reference set. */
export async function prepareReferences(recovery: any): Promise<void> {
  if (existsSync(join(ROOT, "references-frozen.json"))) throw new Error("reference freeze already exists");
  const firstFrozen = json(join(FIRST, "references-frozen.json"));
  await mkdir(join(ROOT, "references"), { recursive: true });
  const refs: any = {};
  for (const unit of UNITS) {
    const original = join(FIRST, "references", `${unit}-b.json`);
    if (sha(text(original)) !== firstFrozen.references[unit].b.sha256) throw new Error(`${unit}-b changed since the first freeze`);
    await copyFile(original, join(ROOT, "references", `${unit}-b.original.json`));
    const data = json(original), corrections: any[] = [];
    if (unit === "dev-r1") {
      const lines = Number(recovery.devCitation.lines);
      for (const item of data.items) { const r = clampCitations(item.supportBasis, recovery.devCitation.file, lines); if (r.changes.length) { item.supportBasis = r.text; item.provenance = "independent labeller b; citation range corrected by parent (labels unchanged)"; corrections.push({ id: item.id, changes: r.changes }); } }
      const changedRanges = corrections.flatMap(c => c.changes).reduce((n: number, ch: any) => { const to = ch.to.split(/[:,]/); return n + ch.from.split(/[:,]/).filter((r: string, i: number) => r !== to[i]).length; }, 0);
      if (changedRanges !== recovery.devCitation.overflowingRanges || corrections.length !== recovery.devCitation.rows) throw new Error(`dev citation corrections (${corrections.length} rows, ${changedRanges} ranges) differ from the recorded inspection`);
    }
    for (const item of data.items) item.provenance ??= "independent labeller b";
    const errors = validateReferences(claimsOf(unit).map(c => c.ref), data);
    if (errors.length) throw new Error(`${unit}: ${errors.slice(0, 5).join(", ")}`);
    await write(join(ROOT, "references", `${unit}-b.json`), { ...data, corrections, labels: "unchanged from labeller b" });
    // A replica counts as recovered only from label rows found in its hashed transcript; none may be invented.
    const seen = recovery.inspection?.[unit];
    if (!seen?.sha256) throw new Error(`${unit}: replica a needs a hashed transcript inspection before it can be declared missing`);
    if (seen.labelRows > 0) throw new Error(`${unit}: replica a has recoverable label rows; recover them instead of declaring it missing`);
    refs[unit] = { b: { sha256: sha(text(join(ROOT, "references", `${unit}-b.json`))), original: sha(text(original)), items: data.items.length, corrections: corrections.length, provenance: "independent labeller b (first-attempt round 1)" }, a: { missing: true, reason: recovery.a[unit], transcriptSha256: seen.sha256, labelRowsFound: seen.labelRows } };
  }
  await write(join(ROOT, "reference-recovery.json"), recovery);
  await write(join(ROOT, "references-frozen.json"), { at: new Date().toISOString(), references: refs, completeReplication: false, recoverySha256: sha(text(join(ROOT, "reference-recovery.json"))), policy: "One independent reference (labeller b) per unit, with listed parent citation-range corrections; replicas a are unrecoverable (their transcripts contain no labels). Scores against b are conditional; the two-reference stability condition of protocol.md cannot be met, so the study cannot be 'supported'. Round-2 disputes of a reference label are reported as a second reading (sensitivity), never as a rewrite." });
  console.log(JSON.stringify(refs));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "prepare") await prepareInputs();
  else if (process.argv[2] === "references") await prepareReferences(json(process.argv[3]!));
  else throw new Error("prepare | references <recovery.json>");
}
