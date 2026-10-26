// Ledger-bound delivery (results/delivery-validation/protocol.md, arm B): deterministic rendering of a frozen decision ledger plus a
// model-chosen arrangement, and the mechanical checks of the delivered text. Plain JavaScript with node builtins only: the measured
// sandbox runs this very file as /tmp/pi-orche/input/render.mjs (preview), and the harness imports it for the delivered rendering.
//   node render.mjs <ledger.json> <arrangement.json> <out.md>   → writes the rendering, prints the check as JSON
// What the checks guarantee is limited to fixed data and rendering: every approved ledger entry's exact block (statement, generated
// status/scope tag, every condition, the note, citations) appears once, visibly; no excluded/duplicate statement appears; no text other
// than ledger fields, fixed templates and the allowed heading forms. They do NOT establish that a statement, label or decision is true,
// in scope, well arranged or non-misleading in context.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CLASSES = ["include", "uncertain", "correct", "duplicate", "exclude"];
export const APPROVED = ["include", "uncertain", "correct"];
/** Closed heading labels (organizational only). */
export const LABELS = ["Findings", "Supporting details", "Requested context", "Checks and limitations", "Open questions", "Corrections", "Conditions and boundaries", "Evidence and provenance", "Reproduction", "Background", "Other details"];
export const MAIN_MAX = 20;
export const SPAN_MAX_WORDS = 8;
export const TITLE = "# Answer";
export const HEAD = { main: "## Main points", appendix: "## Additional approved details", unplaced: "## Approved entries not placed by the arrangement (generated)", accounting: "## Delivery accounting (generated)" };

const KIND = { insufficient: "unverified", conflicting: "disputed", refuted: "refuted", supported: "scope or applicability open" };
/** How an uncertain entry must be presented: from its frozen support value. */
export const uncertainKind = (/** @type {any} */ e) => KIND[/** @type {keyof typeof KIND} */ (e.support)] ?? "uncertain";
/** Required delivery of one entry (identical text for composers, renderer, auditors and judges). */
export function requiredOf(/** @type {any} */ e) {
  switch (e.decision) {
    case "include": return "Accepted statement: deliver its meaning as worded with every condition/limit.";
    case "uncertain": return `Not established (${uncertainKind(e)}): deliver it explicitly as ${uncertainKind(e)}, with every condition/limit and the open question in the note; never as established.`;
    case "correct": return "Correction: say that the statement is not accurate as worded and give the correction basis (note) with every condition/limit; never restate it as accurate. The ledger has no approved corrected wording beyond the note and conditions.";
    case "duplicate": return `Duplicate of ${e.duplicateOf}: covered by that entry; no separate delivery required.`;
    case "exclude": return "Excluded: not part of the answer; do not present it as answer content.";
    default: return `Unknown decision ${String(e.decision)}.`;
  }
}
/** Generated status/scope tag (from frozen fields only). */
export function tagOf(/** @type {any} */ e) {
  const parts = [];
  if (e.decision === "correct") parts.push("Corrected");
  else if (e.decision === "uncertain") parts.push(`Uncertain: ${uncertainKind(e)}`);
  else if (e.decision === "include" && e.support !== "supported") parts.push(`Accepted with support: ${KIND[/** @type {keyof typeof KIND} */ (e.support)] ?? String(e.support)}`);
  if (e.relevance === "requested_context") parts.push("Requested context");
  if (e.relevance === "ambiguous") parts.push("Scope ambiguous");
  return parts.length ? `**[${parts.join(" · ")}]** ` : "";
}
/** The exact rendered block of one approved entry (no ids; every line from ledger fields or fixed templates). */
export function blockOf(/** @type {any} */ e) {
  const lines = [e.decision === "correct" ? `- ${tagOf(e)}The following earlier statement is not accurate as worded: “${e.statement}”` : `- ${tagOf(e)}${e.statement}`];
  if (e.decision === "correct") lines.push(`  - Correction basis (decision record; the ledger has no approved corrected wording): ${e.note || "(no correction basis recorded)"}`);
  for (const c of e.conditions ?? []) lines.push(`  - Condition/limit: ${c}`);
  if (e.decision === "uncertain") lines.push(`  - Open question (decision record): ${e.note || "(no open question recorded)"}`);
  if ((e.locations ?? []).length) lines.push(`  - Cited: ${e.locations.join("; ")}`);
  return lines.join("\n");
}
const wordChar = /[A-Za-z0-9_]/;
/** The heading of one section, or why it is not allowed (closed label and/or an exact word span of an entry of that section). */
export function headingOf(/** @type {any} */ section, /** @type {Map<string, any>} */ byId) {
  const label = section?.label ?? null, span = section?.span ?? null;
  if (label === null && span === null) return { error: "needs a label or a span" };
  if (label !== null && !LABELS.includes(label)) return { error: `label ${JSON.stringify(label)} is not one of the closed labels` };
  if (span === null) return { text: label };
  if (typeof span !== "string" || !span.trim() || span !== span.trim() || /[\n\r]/.test(span)) return { error: "span must be a non-empty single-line string without surrounding spaces" };
  const words = span.split(/\s+/).length;
  if (words > SPAN_MAX_WORDS) return { error: `span has ${words} words; at most ${SPAN_MAX_WORDS}` };
  const items = Array.isArray(section.items) ? section.items : [];
  if (typeof section.from !== "string" || !items.includes(section.from) || !byId.has(section.from)) return { error: "from must name an entry placed in this section" };
  const e = byId.get(section.from);
  const sources = [e.statement, ...(e.conditions ?? [])];
  const found = sources.some(source => { for (let at = source.indexOf(span); at >= 0; at = source.indexOf(span, at + 1)) { const before = source[at - 1] ?? " ", after = source[at + span.length] ?? " "; if (!(wordChar.test(before) && wordChar.test(span[0])) && !(wordChar.test(after) && wordChar.test(span.at(-1) ?? " "))) return true; } return false; });
  if (!found) return { error: `span ${JSON.stringify(span)} is not an exact word-bounded excerpt of ${section.from}'s statement or conditions` };
  return { text: label ? `${label}: ${span}` : span };
}
const isObject = (/** @type {any} */ v) => !!v && typeof v === "object" && !Array.isArray(v);
/** Arrangement contract errors (the fixable ones a composer is told about), placements and headings. */
export function validateArrangement(/** @type {any} */ ledger, /** @type {any} */ arrangement) {
  const byId = new Map(ledger.entries.map((/** @type {any} */ e) => [e.id, e]));
  const errors = [];
  if (!isObject(arrangement)) return { errors: ["arrangement.json must be a JSON object"], headings: [] };
  const seen = new Map();
  const place = (/** @type {any} */ id, /** @type {string} */ where) => {
    if (typeof id !== "string" || !byId.has(id)) { errors.push(`${where}: unknown id ${JSON.stringify(id)}`); return; }
    const e = byId.get(id);
    if (!APPROVED.includes(e.decision)) { errors.push(`${where}: ${id} is a ${e.decision} entry and must not be placed`); return; }
    if (seen.has(id)) { errors.push(`${id} placed more than once (${seen.get(id)} and ${where})`); return; }
    seen.set(id, where);
  };
  if (!Array.isArray(arrangement.main) || arrangement.main.length < 1 || arrangement.main.length > MAIN_MAX) errors.push(`main must be an array of 1 to ${MAIN_MAX} ids`);
  for (const id of Array.isArray(arrangement.main) ? arrangement.main : []) place(id, "main");
  const headings = [];
  if (!Array.isArray(arrangement.sections) || !arrangement.sections.length) errors.push("sections must be a non-empty array");
  (Array.isArray(arrangement.sections) ? arrangement.sections : []).forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    if (!isObject(s) || !Array.isArray(s.items) || !s.items.length) errors.push(`section ${i + 1}: needs a non-empty items array`);
    const h = headingOf(s, byId);
    if (h.error) errors.push(`section ${i + 1}: heading ${h.error}`);
    headings.push(h);
    for (const id of isObject(s) && Array.isArray(s.items) ? s.items : []) place(id, `section ${i + 1}`);
  });
  if (arrangement.appendix !== undefined && !Array.isArray(arrangement.appendix)) errors.push("appendix must be an array when present");
  for (const id of Array.isArray(arrangement.appendix) ? arrangement.appendix : []) place(id, "appendix");
  const unplaced = ledger.entries.filter((/** @type {any} */ e) => APPROVED.includes(e.decision) && !seen.has(e.id)).map((/** @type {any} */ e) => e.id);
  if (unplaced.length) errors.push(`${unplaced.length} approved entries not placed: ${unplaced.slice(0, 60).join(", ")}${unplaced.length > 60 ? ", …" : ""}`);
  if (arrangement.proposals !== undefined && !Array.isArray(arrangement.proposals)) errors.push("proposals must be an array when present");
  return { errors, headings };
}
/** Valid proposals are recorded as unapproved; they are never rendered. */
export function proposalsOf(/** @type {any} */ arrangement) {
  const list = isObject(arrangement) && Array.isArray(arrangement.proposals) ? arrangement.proposals : [];
  return { recorded: list.length, unapproved: list, rendered: 0 };
}
const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;
/**
 * Deterministic rendering with recorded fallbacks: unknown, non-placeable and repeated placements are ignored, invalid headings become
 * "Section n", sections without placeable entries are dropped, unplaced approved entries are appended under a generated heading.
 */
export function render(/** @type {any} */ ledger, /** @type {any} */ arrangement) {
  const entries = ledger.entries, byId = new Map(entries.map((/** @type {any} */ e) => [e.id, e]));
  const arr = isObject(arrangement) ? arrangement : {};
  const fallbacks = [], placed = new Map();
  const take = (/** @type {any} */ list, /** @type {string} */ where) => {
    const out = [];
    for (const id of Array.isArray(list) ? list : []) {
      const e = typeof id === "string" ? byId.get(id) : undefined;
      if (!e) { fallbacks.push(`${where}: ignored unknown id ${JSON.stringify(id)}`); continue; }
      if (!APPROVED.includes(e.decision)) { fallbacks.push(`${where}: ignored ${e.decision} entry ${id}`); continue; }
      if (placed.has(id)) { fallbacks.push(`${where}: ignored repeated ${id} (first placed in ${placed.get(id)})`); continue; }
      placed.set(id, where); out.push(e);
    }
    return out;
  };
  const regions = [];
  const main = take(arr.main, "main");
  if (main.length) regions.push({ region: "main", heading: HEAD.main, headingSource: "fixed", items: main });
  (Array.isArray(arr.sections) ? arr.sections : []).forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    const items = take(isObject(s) ? s.items : [], `section ${i + 1}`);
    if (!items.length) { fallbacks.push(`section ${i + 1}: dropped (no placeable entries)`); return; }
    const h = headingOf(s, byId);
    if (h.error) fallbacks.push(`section ${i + 1}: heading replaced by "Section ${i + 1}" (${h.error})`);
    regions.push({ region: "section", index: i + 1, heading: `## ${h.error ? `Section ${i + 1}` : h.text}`, headingSource: h.error ? "fallback" : s.span != null ? (s.label != null ? "label+span" : "span") : "label", items });
  });
  const appendix = take(arr.appendix, "appendix");
  if (appendix.length) regions.push({ region: "appendix", heading: HEAD.appendix, headingSource: "fixed", items: appendix });
  const unplaced = entries.filter((/** @type {any} */ e) => APPROVED.includes(e.decision) && !placed.has(e.id));
  for (const e of unplaced) placed.set(e.id, "unplaced");
  if (unplaced.length) { fallbacks.push(`${unplaced.length} approved entries appended under the generated unplaced heading`); regions.push({ region: "unplaced", heading: HEAD.unplaced, headingSource: "fixed", items: unplaced }); }
  const count = (/** @type {string} */ d) => entries.filter((/** @type {any} */ e) => e.decision === d).length;
  const approved = entries.filter((/** @type {any} */ e) => APPROVED.includes(e.decision)).length;
  const inRegion = (/** @type {string} */ r) => regions.filter(x => x.region === r).reduce((n, x) => n + x.items.length, 0);
  const note = `> Generated delivery note: the statements below are reproduced verbatim from a frozen decision ledger. Status, scope and condition labels, the allowed heading forms and these notes are generated by code from the ledger's fields; a model chose only the arrangement (main points, sections, order). The ledger's decisions were not re-verified at delivery: a statement shown here is what the ledger accepted, not independently proven. All ${plural(approved, "approved statement is", "approved statements are")} shown: ${inRegion("main")} in Main points, ${inRegion("section")} in the topical sections, ${inRegion("appendix")} under Additional approved details${inRegion("unplaced") ? `, ${inRegion("unplaced")} appended because the arrangement did not place them` : ""}. ${plural(count("duplicate"), "statement recorded as a duplicate is", "statements recorded as duplicates are")} represented by ${count("duplicate") === 1 ? "its equivalent statement" : "their equivalent statements"}, and ${plural(count("exclude"), "candidate excluded by the ledger is", "candidates excluded by the ledger are")} not shown.`;
  const lines = [TITLE, "", note, ""];
  /** @type {Record<string, any>} */
  const map = {};
  for (const r of regions) {
    lines.push(r.heading, "");
    for (const e of r.items) {
      const block = blockOf(e), start = lines.length + 1;
      lines.push(...block.split("\n"));
      map[e.id] = { region: r.region, section: r.index ?? null, heading: r.heading.replace(/^## /, ""), startLine: start, endLine: lines.length };
    }
    lines.push("");
  }
  lines.push(HEAD.accounting, "",
    `- Registered candidates: ${entries.length}. Approved for delivery: ${approved} (accepted ${count("include")}, uncertain ${count("uncertain")}, corrected ${count("correct")}).`,
    `- Duplicates represented by an equivalent statement: ${count("duplicate")}. Excluded from the answer: ${count("exclude")} (reasons recorded in the ledger, not shown).`,
    `- Placement: Main points ${inRegion("main")}, topical sections ${inRegion("section")}, additional details ${inRegion("appendix")}, not placed by the arrangement ${inRegion("unplaced")}.`, "");
  return { text: lines.join("\n"), map, fallbacks, headings: regions.map(r => ({ region: r.region, index: r.index ?? null, heading: r.heading.replace(/^## /, ""), source: r.headingSource })), proposals: proposalsOf(arrangement) };
}
const occurrences = (/** @type {string} */ text, /** @type {string} */ needle) => { const at = []; if (!needle) return at; for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) at.push(i); return at; };
/** Character ranges of HTML comments, <details> blocks and fenced code blocks (where text would be hidden or not plain prose). */
export function hiddenRanges(/** @type {string} */ text) {
  const ranges = [];
  for (const re of [/<!--[\s\S]*?(-->|$)/g, /<details[\s\S]*?(<\/details>|$)/gi, /^```[\s\S]*?(^```|$(?![\s\S]))/gm]) for (let m = re.exec(text); m; m = re.exec(text)) { ranges.push([m.index, m.index + m[0].length]); if (!m[0].length) re.lastIndex++; }
  return ranges;
}
/** Mechanical checks of a delivered B text against the ledger and its arrangement (data and rendering properties only). */
export function check(/** @type {any} */ ledger, /** @type {any} */ arrangement, /** @type {string} */ text) {
  const errors = [], notes = [];
  const entries = ledger.entries;
  const ids = new Set();
  for (const e of entries) {
    if (ids.has(e.id)) errors.push(`ledger: duplicate id ${e.id}`); ids.add(e.id);
    if (!CLASSES.includes(e.decision)) errors.push(`ledger: ${e.id} has no single known decision class (${String(e.decision)})`);
    if (e.decision === "duplicate") { const t = entries.find((/** @type {any} */ x) => x.id === e.duplicateOf); if (!t) errors.push(`ledger: ${e.id} duplicate of unknown ${String(e.duplicateOf)}`); else if (!APPROVED.includes(t.decision)) notes.push(`ledger: ${e.id} is a duplicate of ${t.id}, which is ${t.decision} (its meaning is not delivered by that pointer)`); }
  }
  const once = render(ledger, arrangement), twice = render(ledger, arrangement);
  if (once.text !== twice.text) errors.push("rendering is not deterministic");
  if (once.text !== text) errors.push("delivered text differs from the deterministic rendering of this ledger and arrangement");
  const hidden = hiddenRanges(text), inHidden = (/** @type {number} */ a, /** @type {number} */ b) => hidden.some(([s, t]) => a < t && s < b);
  const approved = entries.filter((/** @type {any} */ e) => APPROVED.includes(e.decision));
  let blocksOnce = 0, conditionsRendered = 0, notesRendered = 0, tags = 0;
  for (const e of approved) {
    const block = blockOf(e), at = occurrences(text, `${block}\n`);
    if (at.length !== 1) { errors.push(`${e.id}: exact rendered block occurs ${at.length} times (expected once)`); continue; }
    if (inHidden(at[0], at[0] + block.length)) { errors.push(`${e.id}: block lies inside a comment, <details> or code fence`); continue; }
    blocksOnce++;
    if (!once.map[e.id]) errors.push(`${e.id}: missing from the render map`);
    conditionsRendered += (e.conditions ?? []).length;
    if (e.decision !== "include") notesRendered++;
    const tag = tagOf(e);
    if (e.decision !== "include" && !tag) errors.push(`${e.id}: ${e.decision} entry without a status tag`);
    if (tag) tags++;
    if (e.decision === "correct" && !block.includes("is not accurate as worded")) errors.push(`${e.id}: correction marker missing`);
  }
  const shown = new Set(approved.map((/** @type {any} */ e) => e.id));
  const approvedText = approved.map((/** @type {any} */ e) => blockOf(e)).join("\n");
  let collisions = 0;
  for (const e of entries.filter((/** @type {any} */ e) => !shown.has(e.id))) {
    const at = occurrences(text, e.statement);
    if (!at.length) continue;
    if (approvedText.includes(e.statement)) { collisions++; notes.push(`${e.id} (${e.decision}): its statement text also occurs inside approved text (collision, not a separate delivery)`); }
    else errors.push(`${e.id} (${e.decision}): statement appears in the delivered text`);
  }
  for (const e of approved) if (e.decision === "correct") { const bare = occurrences(text, `- ${e.statement}`); if (bare.length) errors.push(`${e.id}: corrected statement also appears as an untagged list statement`); }
  const v = validateArrangement(ledger, arrangement);
  const regionCounts = Object.values(once.map).reduce((/** @type {Record<string, number>} */ acc, /** @type {any} */ m) => { acc[m.region] = (acc[m.region] ?? 0) + 1; return acc; }, {});
  return {
    errors, notes,
    arrangementErrors: v.errors, fallbacks: once.fallbacks, headings: once.headings, proposals: { recorded: once.proposals.recorded, rendered: 0 },
    stats: { entries: entries.length, approved: approved.length, blocksOnce, conditionsRendered, notesRendered, tags, excludedOrDuplicate: entries.length - approved.length, collisions, placement: regionCounts, hiddenRanges: hidden.length, chars: text.length, lines: text.split("\n").length },
  };
}
const words = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Lexical facts about any delivered text (C or B); never a semantic score. */
export function scanText(/** @type {any} */ ledger, /** @type {string} */ text) {
  const approved = ledger.entries.filter((/** @type {any} */ e) => APPROVED.includes(e.decision)), others = ledger.entries.filter((/** @type {any} */ e) => !APPROVED.includes(e.decision));
  const tokens = words(text).split(" ").filter(Boolean), shingles = new Map();
  for (let i = 0; i + 8 <= tokens.length; i++) { const s = tokens.slice(i, i + 8).join(" "); shingles.set(s, (shingles.get(s) ?? 0) + 1); }
  const repeated = [...shingles.values()].filter(n => n > 1).reduce((a, n) => a + n, 0);
  return {
    chars: text.length, words: tokens.length, lines: text.split("\n").length,
    headings: text.split("\n").filter(l => /^#{1,6}\s/.test(l)).length, listItems: text.split("\n").filter(l => /^\s*[-*+]\s|^\s*\d+\.\s/.test(l)).length,
    idMentions: (text.match(/\bk\d{1,3}\b/g) ?? []).length,
    hidden: { comments: (text.match(/<!--/g) ?? []).length, details: (text.match(/<details/gi) ?? []).length, fences: (text.match(/^```/gm) ?? []).length },
    approvedVerbatim: approved.filter((/** @type {any} */ e) => text.includes(e.statement)).length, approved: approved.length,
    otherVerbatim: others.filter((/** @type {any} */ e) => text.includes(e.statement)).map((/** @type {any} */ e) => e.id),
    repeated8gramShare: shingles.size ? Math.round(repeated / Math.max(1, tokens.length - 7) * 1e4) / 1e4 : 0,
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [ledgerFile, arrangementFile, outFile] = process.argv.slice(2);
  if (!ledgerFile || !arrangementFile || !outFile) { console.error("usage: node render.mjs <ledger.json> <arrangement.json> <out.md>"); process.exit(2); }
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  let arrangement, parseError = "";
  try { arrangement = JSON.parse(readFileSync(arrangementFile, "utf8")); } catch (e) { parseError = `arrangement.json is not valid JSON: ${String(e).slice(0, 200)}`; arrangement = {}; }
  const r = render(ledger, arrangement);
  writeFileSync(outFile, r.text);
  const v = validateArrangement(ledger, arrangement), c = check(ledger, arrangement, r.text);
  const errors = [...(parseError ? [parseError] : []), ...v.errors];
  console.log(JSON.stringify({ arrangementErrors: errors, fallbacks: r.fallbacks, headings: r.headings, proposals: r.proposals.recorded, renderChecks: c.errors, placement: c.stats.placement, chars: r.text.length }, null, 1));
  console.log(errors.length ? `CHECK: ${errors.length} arrangement error(s); fix them` : "CHECK: 0 arrangement errors");
}
