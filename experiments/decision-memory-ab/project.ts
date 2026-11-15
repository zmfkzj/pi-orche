/**
 * The two task families of the decision-memory A/B (README.md): a generated, dependency-free JavaScript library ("ledgerlib") whose
 * size makes a real worker's context pass the compaction trigger, and deterministic graders with hidden acceptance tests that the
 * worker never sees (written after the worker finished).
 *
 * - bugfix: five spec violations in five modules; visible tests fail; hidden tests also check spec rules the visible tests leave out.
 * - feature: implement exportCsv() from SPEC §7 (hidden tests check every rule) and fix four pre-existing lint violations.
 *
 * `generate(task, { solved: true })` writes the reference solution, which the self-test grades as fully correct (and the unsolved
 * workspace as failing), so every hidden expectation is checked against an implementation of the spec before any model run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type TaskId = "bugfix" | "feature";
export const TASKS: readonly TaskId[] = ["bugfix", "feature"];

// ---------------------------------------------------------------------------------------------------------------------------------
// Deterministic filler code (realistic bulk: every function is documented, validated and tested).

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const VERBS = ["normalize", "compute", "resolve", "derive", "collect", "format", "measure", "select", "merge", "split", "scale", "bound", "count", "shift"];
const NOUNS = ["Batch", "Window", "Offset", "Margin", "Bucket", "Ratio", "Range", "Label", "Token", "Segment", "Score", "Weight", "Ledger", "Cycle"];
const PURPOSES = [
  "Used by the reconciliation job when it prepares a statement page.",
  "Kept for the import pipeline, which calls it once per parsed row.",
  "Shared by the report builders; keep it pure and allocation-light.",
  "Called from the settlement batch before amounts are posted.",
  "Part of the public helper surface documented in docs/SPEC.md §1.",
  "The audit exporter relies on this exact behaviour; do not change it casually.",
];

interface Filler { name: string; source: string; inputs: unknown[] }

function filler(name: string, kind: number, k: number, purpose: string): Filler {
  const doc = (what: string) => `/**\n * ${what}\n * ${purpose}\n */\n`;
  const ch = "aeiourst"[k % 8]!;
  switch (kind) {
    case 0: return { name, inputs: [k + 5, -k - 3, 1], source: `${doc(`Clamp a number to the symmetric range [-${k}, ${k}].`)}export function ${name}(value) {\n  if (typeof value !== "number" || Number.isNaN(value)) throw new TypeError("${name}: expected a number");\n  const limit = ${k};\n  if (value > limit) return limit;\n  if (value < -limit) return -limit;\n  return value;\n}\n` };
    case 1: { const f = [10, 100, 1000][k % 3]!; return { name, inputs: [1.23456, -2.5], source: `${doc(`Round a number to ${String(f).length - 1} decimal place(s).`)}export function ${name}(value) {\n  if (typeof value !== "number") throw new TypeError("${name}: expected a number");\n  const factor = ${f};\n  return Math.round(value * factor) / factor;\n}\n` }; }
    case 2: { const t = (k % 4) + 1; return { name, inputs: ["ab", "x"], source: `${doc(`Repeat a label ${t} time(s), joined with dashes.`)}export function ${name}(text) {\n  if (typeof text !== "string") throw new TypeError("${name}: expected a string");\n  const times = ${t};\n  return Array.from({ length: times }, () => text).join("-");\n}\n` }; }
    case 3: return { name, inputs: [[1, k, k - 1, k + 2], []], source: `${doc(`Sum the values strictly below ${k}.`)}export function ${name}(values) {\n  if (!Array.isArray(values)) throw new TypeError("${name}: expected an array");\n  const ceiling = ${k};\n  let total = 0;\n  for (const value of values) if (value < ceiling) total += value;\n  return total;\n}\n` };
    case 4: return { name, inputs: ["the quick brown fox jumps over the lazy dog", `${ch} ${ch}`], source: `${doc(`Count the occurrences of "${ch}".`)}export function ${name}(text) {\n  if (typeof text !== "string") throw new TypeError("${name}: expected a string");\n  const target = "${ch}";\n  let count = 0;\n  for (const char of text) if (char === target) count++;\n  return count;\n}\n` };
    case 5: { const size = (k % 3) + 2; return { name, inputs: [[1, 2, 3, 4, 5], []], source: `${doc(`Split a list into chunks of ${size}.`)}export function ${name}(items) {\n  if (!Array.isArray(items)) throw new TypeError("${name}: expected an array");\n  const size = ${size};\n  const out = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}\n` }; }
    case 6: return { name, inputs: [{ a: 1, b: 2 }, {}], source: `${doc(`Prefix every key of a record with "p${k}_".`)}export function ${name}(record) {\n  if (!record || typeof record !== "object") throw new TypeError("${name}: expected an object");\n  const prefix = "p${k}_";\n  return Object.fromEntries(Object.entries(record).map(([key, value]) => [prefix + key, value]));\n}\n` };
    default: return { name, inputs: [k + 3, -1], source: `${doc(`Non-negative remainder modulo ${k}.`)}export function ${name}(n) {\n  if (!Number.isInteger(n)) throw new TypeError("${name}: expected an integer");\n  const m = ${k};\n  return ((n % m) + m) % m;\n}\n` };
  }
}

function fillers(module: string, count: number): Filler[] {
  const random = rng([...module].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const used = new Set<string>();
  const out: Filler[] = [];
  while (out.length < count) {
    let name = `${VERBS[Math.floor(random() * VERBS.length)]}${NOUNS[Math.floor(random() * NOUNS.length)]}`;
    if (used.has(name)) name = `${name}${out.length}`;
    used.add(name);
    out.push(filler(name, Math.floor(random() * 8), 3 + Math.floor(random() * 40), PURPOSES[Math.floor(random() * PURPOSES.length)]!));
  }
  return out;
}

/** Evaluate a filler's source (ESM `export function`) to compute the expected values of its generated tests. */
function evaluate(f: Filler): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(`${f.source.replace(/^export /m, "")}\nreturn ${f.name};`)() as (x: unknown) => unknown;
  return f.inputs.map(input => fn(structuredClone(input)));
}
const lit = (value: unknown) => JSON.stringify(value);
function fillerTests(module: string, list: Filler[]): string {
  return list.map(f => {
    const expected = evaluate(f);
    return `test("${module}: ${f.name}", () => {\n${f.inputs.map((input, i) => `  assert.deepStrictEqual(m.${f.name}(${lit(input)}), ${lit(expected[i])});`).join("\n")}\n});\n`;
  }).join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The library's real modules (buggy and solved variants).

const FILLERS_PER_MODULE = 40;

function moneyModule(task: TaskId, solved: boolean) {
  const bug = task === "bugfix" && !solved;
  return `/**\n * Money helpers. All amounts are integer cents (docs/SPEC.md §2).\n */\n\nexport const FEE_RATES = { gold: 0.005, silver: ${bug ? "0.015" : "0.01"}, basic: 0.02 };\nexport const MIN_FEE = 25;\n\n/** Round half away from zero. */\nexport function roundHalfAway(x) {\n  return Math.sign(x) * Math.round(Math.abs(x));\n}\n\n/** Format integer cents as "-1,234.50". */\nexport function formatCents(cents) {\n  if (!Number.isInteger(cents)) throw new TypeError("cents must be an integer");\n  const sign = cents < 0 ? "-" : "";\n  const abs = Math.abs(cents);\n  const whole = Math.floor(abs / 100).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");\n  return \`\${sign}\${whole}.\${String(abs % 100)${bug ? "" : '.padStart(2, "0")'}}\`;\n}\n\n/** The fee for a transfer of amountCents at a customer tier (SPEC §2.3). */\nexport function applyFee(amountCents, tier) {\n${bug
    ? `  const rate = FEE_RATES[tier] ?? FEE_RATES.basic;\n  return roundHalfAway(amountCents * rate);\n`
    : `  if (!Object.hasOwn(FEE_RATES, tier)) throw new RangeError(\`unknown tier \${tier}\`);\n  if (amountCents <= 0) return 0;\n  const fee = roundHalfAway(amountCents * FEE_RATES[tier]);\n  return tier === "gold" ? fee : Math.max(fee, MIN_FEE);\n`}}\n`;
}

function datesModule(task: TaskId, solved: boolean) {
  const bug = task === "bugfix" && !solved;
  const trailing = task === "feature" && !solved ? " " : "";
  return `/**\n * Calendar helpers on ISO dates (YYYY-MM-DD, UTC; docs/SPEC.md §3).\n */\n\nexport const HOLIDAYS = new Set(["2026-01-01", "2026-05-01", "2026-12-25", "2026-12-31"]);${trailing}\n\nexport function parseISODate(text) {\n  if (typeof text !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(text)) throw new TypeError("invalid date");\n  const date = new Date(\`\${text}T00:00:00Z\`);\n  if (Number.isNaN(date.getTime())${bug ? "" : ' || date.toISOString().slice(0, 10) !== text'}) throw new TypeError("invalid date");\n  return date;\n}\n\nexport function toISODate(date) {\n  return date.toISOString().slice(0, 10);\n}\n\nexport function addDays(text, days) {\n  const date = parseISODate(text);\n  date.setUTCDate(date.getUTCDate() + days);\n  return toISODate(date);\n}\n\n/** Business days between two dates (SPEC §3.2). */\nexport function businessDaysBetween(start, end) {\n  parseISODate(start);\n  parseISODate(end);\n${bug
    ? `  if (end < start) return 0;\n  let count = 0;\n  for (let day = start; day <= end; day = addDays(day, 1)) {\n    const weekday = parseISODate(day).getUTCDay();\n    if (weekday !== 0 && weekday !== 6) count++;\n  }\n  return count;\n`
    : `  let count = 0;\n  for (let day = start; day < end; day = addDays(day, 1)) {\n    const weekday = parseISODate(day).getUTCDay();\n    if (weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(day)) count++;\n  }\n  return count;\n`}}\n`;
}

function accountsModule(task: TaskId, solved: boolean) {
  const bug = task === "bugfix" && !solved;
  return `/**\n * Account identifiers (IBAN-like; docs/SPEC.md §4).\n */\n\n/** The mod-97 remainder of an identifier (first four characters moved to the end, letters A=10 … Z=35). */\nexport function ibanRemainder(id) {\n  const moved = id.slice(4) + id.slice(0, 4);\n  let remainder = 0;\n  for (const char of moved) {\n    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;\n    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;\n  }\n  return remainder;\n}\n\n/** Normalize a user-entered account id (SPEC §4.1). */\nexport function normalizeAccountId(raw) {\n  if (typeof raw !== "string") throw new TypeError("invalid account id");\n  const id = raw.replace(${bug ? "/-/g" : "/[\\s-]+/g"}, "").toUpperCase();\n  if (!/^[A-Z]{2}\\d{2}[A-Z0-9]{8,20}$/.test(id) || ibanRemainder(id) !== 1) throw new TypeError("invalid account id");\n  return id;\n}\n`;
}

function ledgerModule(task: TaskId, solved: boolean) {
  const bug = task === "bugfix" && !solved;
  const debug = task === "feature" && !solved ? `  console.log("posting", entry.id);\n` : "";
  return `/**\n * The in-memory ledger (docs/SPEC.md §5). Entries: { id, date, account, amount, memo, status }.\n */\nimport { parseISODate } from "./dates.js";\n\nexport const STATUSES = ["posted", "void"];\n\n/** Append a validated entry; status defaults to "posted". */\nexport function postEntry(entries, entry) {\n  if (typeof entry.id !== "string" || !entry.id) throw new TypeError("entry id required");\n  parseISODate(entry.date);\n  if (!Number.isInteger(entry.amount)) throw new TypeError("amount must be integer cents");\n${debug}  const status = entry.status ?? "posted";\n  if (!STATUSES.includes(status)) throw new RangeError(\`unknown status \${status}\`);\n  return [...entries, { memo: "", ...entry, status }];\n}\n\n/** Mark an entry void (it stays in the list). */\nexport function voidEntry(entries, id) {\n${bug ? "" : `  if (!entries.some(entry => entry.id === id)) throw new RangeError(\`unknown entry \${id}\`);\n`}  return entries.map(entry => entry.id === id ? { ...entry, status: "void" } : entry);\n}\n\n/** The balance of one account (SPEC §5.2). */\nexport function balance(entries, account) {\n  return entries\n    .filter(entry => entry.account === account${bug ? "" : ` && entry.status !== "void"`})\n    .reduce((sum, entry) => sum + entry.amount, 0);\n}\n`;
}

function reportModule(task: TaskId, solved: boolean) {
  const bug = task === "bugfix" && !solved;
  return `/**\n * Statement summaries (docs/SPEC.md §6).\n */\nimport { balance } from "./ledger.js";\n\n/** Entries in statement order (SPEC §6.1). */\nexport function sortEntries(entries) {\n${bug
    ? `  return [...entries].sort((a, b) => b.date.localeCompare(a.date));\n`
    : `  return [...entries].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);\n`}}\n\n/** A statement summary (SPEC §6.2). */\nexport function summarize(entries) {\n  const accounts = [...new Set(entries.map(entry => entry.account))].sort();\n  return {\n    accounts: accounts.map(account => ({ account, balance: balance(entries, account), count: entries.filter(entry => entry.account === account && entry.status !== "void").length })),\n    total: accounts.reduce((sum, account) => sum + balance(entries, account), 0),\n    lines: sortEntries(entries).map(entry => entry.id),\n  };\n}\n`;
}

const CSV_SOLVED = `/**\n * CSV export (docs/SPEC.md §7).\n */\nimport { formatCents } from "./money.js";\nimport { sortEntries } from "./report.js";\n\nexport const DEFAULT_COLUMNS = ["date", "id", "account", "amount", "memo"];\n\nexport function exportCsv(entries, options = {}) {\n  const columns = options.columns ?? DEFAULT_COLUMNS;\n  for (const column of columns) if (!DEFAULT_COLUMNS.includes(column)) throw new RangeError(\`unknown column \${column}\`);\n  const delimiter = options.delimiter ?? ",";\n  if (delimiter !== "," && delimiter !== ";") throw new RangeError("delimiter must be , or ;");\n  const quote = value => {\n    const text = String(value ?? "");\n    return text.includes(delimiter) || /["\\r\\n]/.test(text) ? \`"\${text.replace(/"/g, '""')}"\` : text;\n  };\n  const rows = sortEntries(entries.filter(entry => options.includeVoid === true || entry.status !== "void"));\n  const lines = [columns.join(delimiter), ...rows.map(entry => columns.map(column => quote(column === "amount" ? formatCents(entry.amount) : entry[column])).join(delimiter))];\n  return lines.map(line => \`\${line}\\r\\n\`).join("");\n}\n`;
const CSV_STUB = `/**\n * CSV export (docs/SPEC.md §7).\n */\n\nexport const DEFAULT_COLUMNS = ["date", "id", "account", "amount", "memo"];\n\nexport function exportCsv(entries, options = {}) {\n  throw new Error("exportCsv: not implemented");\n}\n`;

function utilModule(name: string, task: TaskId, solved: boolean, list: Filler[]) {
  let header = `/**\n * ${name} helpers (docs/SPEC.md §1.3).\n */\n\n`;
  if (task === "feature" && !solved && name === "strings") header += `var SEPARATOR = "-";\nexport function separator() {\n  return SEPARATOR;\n}\n\n`;
  else if (name === "strings") header += `const SEPARATOR = "-";\nexport function separator() {\n  return SEPARATOR;\n}\n\n`;
  if (name === "collections") header += task === "feature" && !solved ? `// TODO: replace with structuredClone once the import pipeline allows it\n` : `// TODO(ledger-team): replace with structuredClone once the import pipeline allows it\n`;
  if (name === "collections") header += `export function copyList(items) {\n  return items.map(item => ({ ...item }));\n}\n\n`;
  return header + list.map(f => f.source).join("\n");
}

const LINT = `#!/usr/bin/env node
// Project lint (docs/SPEC.md §1.4). Checks every .js file under src/ and test/ and prints one line per rule and file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const RULES = {
  "no-var": (line) => /\\bvar\\s/.test(line),
  "no-trailing-space": (line) => /[ \\t]+$/.test(line),
  "no-tabs": (line) => /\\t/.test(line),
  "max-line-length": (line) => line.length > 240,
  "todo-owner": (line) => /\\bTODO\\b(?!\\([a-z0-9-]+\\):)/.test(line),
  "no-console": (line, file) => file.startsWith("src/") && /\\bconsole\\.(log|debug|info)\\(/.test(line),
};
const walk = (dir) => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : path.endsWith(".js") ? [path] : []; });
let violations = 0;
for (const path of [...walk("src"), ...walk("test")].sort()) {
  const file = relative(".", path);
  const lines = readFileSync(path, "utf8").split("\\n");
  console.log(file);
  for (const [rule, check] of Object.entries(RULES)) {
    const hits = lines.flatMap((line, index) => check(line, file) ? [index + 1] : []);
    violations += hits.length;
    console.log(hits.length ? \`  ✗ \${rule}: line(s) \${hits.join(", ")}\` : \`  ✓ \${rule}\`);
  }
}
console.log(violations ? \`\\n\${violations} lint violation(s)\` : "\\nlint clean");
process.exit(violations ? 1 : 0);
`;

// ---------------------------------------------------------------------------------------------------------------------------------
// SPEC.md (long on purpose: the relevant rules sit among sections the tasks do not need).

const PROSE = [
  "The ledger is an append-only record: corrections are new entries, never edits of posted ones.",
  "Statement pages are produced nightly and must be reproducible from the entries alone.",
  "Helpers are pure functions; they never read the clock, the network or the file system.",
  "Every public helper validates its input and throws a TypeError on a wrong type.",
  "Amounts are integer cents everywhere; floating point appears only inside a single computation and is rounded at once.",
  "Identifiers are compared after normalization, never as entered by the user.",
  "The import pipeline feeds rows in arbitrary order; ordering is the job of the report layer.",
  "Rounding rules are part of the contract with the settlement bank and are audited every quarter.",
];
function prose(seed: number, sentences: number): string {
  const random = rng(seed);
  return Array.from({ length: sentences }, () => PROSE[Math.floor(random() * PROSE.length)]).join(" ");
}

function spec(): string {
  const filler = (title: string, seed: number, paragraphs: number) => `${title}\n\n${Array.from({ length: paragraphs }, (_, i) => prose(seed + i, 7)).join("\n\n")}\n`;
  return [
    "# ledgerlib specification\n\nThis document is authoritative: where code or tests disagree with it, the specification wins.\n",
    filler("## 1. Overview", 11, 5),
    filler("### 1.1 Design principles", 21, 4),
    filler("### 1.2 Data model", 31, 4),
    "### 1.3 Helper modules\n\nThe modules under src/util/ hold small documented helpers. Their behaviour is fixed by their tests and must not change.\n",
    "### 1.4 Lint\n\n`npm run lint` (tools/lint.js) must report \"lint clean\". Rules: no `var`; no trailing whitespace; no tabs; lines of at most 240 characters; every TODO names an owner as `TODO(owner):`; no console.log/debug/info in src/.\n",
    "## 2. Money\n\n### 2.1 Amounts\n\nAll amounts are integer cents. `formatCents(cents)` renders an optional minus sign, the whole units with a comma every three digits, a dot and exactly two decimals: `-123456` → `-1,234.56`.\n\n### 2.2 Rounding\n\nRounding is half away from zero (`roundHalfAway`): 2.5 → 3, -2.5 → -3.\n\n### 2.3 Fees\n\n`applyFee(amountCents, tier)` returns the fee in cents for a transfer of `amountCents`:\n\n| tier | rate | minimum fee |\n|---|---|---|\n| gold | 0.5% | none |\n| silver | 1% | 25 cents |\n| basic | 2% | 25 cents |\n\nThe fee is the amount times the rate, rounded half away from zero, then raised to the tier's minimum. An amount of zero or less has a fee of 0 (no minimum applies). An unknown tier throws a RangeError.\n",
    filler("### 2.4 Settlement notes", 41, 3),
    "## 3. Dates\n\n### 3.1 Format\n\nDates are ISO strings `YYYY-MM-DD` in UTC; anything else (including impossible dates such as 2026-02-30) throws a TypeError.\n\n### 3.2 Business days\n\n`businessDaysBetween(start, end)` counts the days d with start ≤ d < end (the end date is excluded) that are Monday to Friday and are not listed in `HOLIDAYS`. When end ≤ start the result is 0.\n",
    filler("### 3.3 Calendar background", 51, 3),
    "## 4. Accounts\n\n### 4.1 Normalization\n\n`normalizeAccountId(raw)` removes every whitespace character (spaces, tabs, newlines) and every dash, converts to upper case, and then validates: two letters, two digits, then 8 to 20 letters or digits, and the mod-97 check (`ibanRemainder(id) === 1`). An invalid id throws a TypeError with the message `invalid account id`.\n",
    filler("### 4.2 Account lifecycle", 61, 3),
    "## 5. Ledger\n\n### 5.1 Entries\n\nAn entry is `{ id, date, account, amount, memo, status }`; status is `posted` (default) or `void`. Voiding keeps the entry in the list; voiding an id that is not in the list throws a RangeError.\n\n### 5.2 Balance\n\n`balance(entries, account)` is the sum of `amount` over the entries of that account whose status is not `void`.\n",
    filler("### 5.3 Posting rules", 71, 3),
    "## 6. Reports\n\n### 6.1 Statement order\n\nStatement order is by date ascending, then by id ascending (plain string comparison).\n\n### 6.2 Summary\n\n`summarize(entries)` returns `{ accounts, total, lines }`: accounts sorted by account id with their balance (§5.2) and the count of non-void entries, the total of those balances, and the ids of all entries in statement order (§6.1).\n",
    filler("### 6.3 Statement layout", 81, 3),
    "## 7. CSV export\n\n`exportCsv(entries, options = {})` in src/csv.js returns a CSV string:\n\n1. Columns: `options.columns` (an array, in that order) or by default `date,id,account,amount,memo`. A column name outside those five throws a RangeError.\n2. The first line is the header: the column names joined by the delimiter.\n3. Rows: one per entry, in statement order (§6.1). Entries with status `void` are left out unless `options.includeVoid === true`.\n4. The amount column is rendered with `formatCents` (§2.1); other columns as their string value (`memo` may be missing: empty field).\n5. Delimiter: `options.delimiter`, `,` (default) or `;`; any other value throws a RangeError.\n6. Quoting: a field that contains the delimiter, a double quote, CR or LF is wrapped in double quotes, and every double quote inside it is doubled. Other fields are not quoted.\n7. Every line, including the last one and the header, ends with CRLF (`\\r\\n`). No entries: the header line only.\n",
    filler("### 7.1 Consumers of the export", 91, 3),
    filler("## 8. Glossary", 101, 4),
    filler("## 9. History", 111, 4),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Visible tests.

const ENTRY_FIXTURE = `const entries = [\n  { id: "e3", date: "2026-03-05", account: "GB82WEST12345698765432", amount: 1500, memo: "rent", status: "posted" },\n  { id: "e1", date: "2026-03-01", account: "GB82WEST12345698765432", amount: -200, memo: "fee", status: "posted" },\n  { id: "e2", date: "2026-03-03", account: "DE89370400440532013000", amount: 999, memo: "refund", status: "void" },\n];\n`;

function visibleTests(task: TaskId, util: Record<string, Filler[]>): Record<string, string> {
  const head = (module: string) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport * as m from "../src/${module}.js";\n\n`;
  const files: Record<string, string> = {};
  files["test/money.test.js"] = head("money") + `test("money: formatCents", () => {\n  assert.equal(m.formatCents(-123456), "-1,234.56");\n  assert.equal(m.formatCents(5), "0.05");\n});\ntest("money: silver fee is 1%", () => {\n  assert.equal(m.applyFee(10000, "silver"), 100);\n});\ntest("money: gold fee", () => {\n  assert.equal(m.applyFee(20000, "gold"), 100);\n});\n\n` + fillerTests("money", util.money!);
  files["test/dates.test.js"] = head("dates") + `test("dates: business days exclude the end date", () => {\n  assert.equal(m.businessDaysBetween("2026-03-02", "2026-03-09"), 5);\n});\ntest("dates: addDays", () => {\n  assert.equal(m.addDays("2026-02-28", 1), "2026-03-01");\n});\n\n` + fillerTests("dates", util.dates!);
  files["test/accounts.test.js"] = head("accounts") + `test("accounts: spaces are removed", () => {\n  assert.equal(m.normalizeAccountId("gb82 west 1234 5698 7654 32"), "GB82WEST12345698765432");\n});\ntest("accounts: dashes are removed", () => {\n  assert.equal(m.normalizeAccountId("DE89-3704-0044-0532-0130-00"), "DE89370400440532013000");\n});\n\n` + fillerTests("accounts", util.accounts!);
  files["test/ledger.test.js"] = head("ledger") + ENTRY_FIXTURE + `test("ledger: void entries do not count", () => {\n  assert.equal(m.balance(entries, "DE89370400440532013000"), 0);\n  assert.equal(m.balance(entries, "GB82WEST12345698765432"), 1300);\n});\n\n` + fillerTests("ledger", util.ledger!);
  files["test/report.test.js"] = head("report") + ENTRY_FIXTURE + `test("report: statement order is by date ascending", () => {\n  assert.deepEqual(m.summarize(entries).lines, ["e1", "e2", "e3"]);\n});\n\n` + fillerTests("report", util.report!);
  for (const name of ["strings", "collections", "numbers", "validate"]) files[`test/util-${name}.test.js`] = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport * as m from "../src/util/${name}.js";\n\n` + fillerTests(name, util[name]!);
  if (task === "feature") files["test/csv.test.js"] = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { exportCsv } from "../src/csv.js";\n\ntest("csv: header only for no entries", () => {\n  assert.equal(exportCsv([]), "date,id,account,amount,memo\\r\\n");\n});\ntest("csv: a simple row", () => {\n  assert.equal(exportCsv([{ id: "a", date: "2026-01-02", account: "X1", amount: 500, memo: "ok", status: "posted" }]), "date,id,account,amount,memo\\r\\n2026-01-02,a,X1,5.00,ok\\r\\n");\n});\n`;
  return files;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Workspace generation.

export function generate(task: TaskId, options: { solved?: boolean } = {}): Record<string, string> {
  const solved = options.solved === true;
  const util: Record<string, Filler[]> = Object.fromEntries(["money", "dates", "accounts", "ledger", "report", "strings", "collections", "numbers", "validate"].map(name => [name, fillers(name, FILLERS_PER_MODULE)]));
  const withFillers = (source: string, name: string) => `${source}\n${util[name]!.map(f => f.source).join("\n")}`;
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "ledgerlib", version: "1.4.0", private: true, type: "module", scripts: { test: "node --test", lint: "node tools/lint.js" } }, null, 2)}\n`,
    "README.md": "# ledgerlib\n\nA small ledger library. The specification is docs/SPEC.md.\n\n- `npm test`: the test suite (node:test)\n- `npm run lint`: the project lint\n",
    "docs/SPEC.md": spec(),
    "tools/lint.js": LINT,
    "src/money.js": withFillers(moneyModule(task, solved), "money"),
    "src/dates.js": withFillers(datesModule(task, solved), "dates"),
    "src/accounts.js": withFillers(accountsModule(task, solved), "accounts"),
    "src/ledger.js": withFillers(ledgerModule(task, solved), "ledger"),
    "src/report.js": withFillers(reportModule(task, solved), "report"),
    ...Object.fromEntries(["strings", "collections", "numbers", "validate"].map(name => [`src/util/${name}.js`, utilModule(name, task, solved, util[name]!)])),
    ...visibleTests(task, util),
  };
  if (task === "feature") files["src/csv.js"] = solved ? CSV_SOLVED : CSV_STUB;
  return files;
}

export function writeFiles(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** Requests given to the worker (identical in both arms). */
export const REQUESTS: Record<TaskId, string> = {
  bugfix: "The ledgerlib project in the current directory has a failing test suite. Make `npm test` pass by fixing the library code in src/. docs/SPEC.md is the authoritative specification: where the code disagrees with it, follow the specification, including behaviour the visible tests do not cover (hidden acceptance tests check the specification). Do not modify anything under test/ or tools/. Report what you changed and the checks you ran.",
  feature: "In the ledgerlib project in the current directory, implement `exportCsv(entries, options)` in src/csv.js exactly as docs/SPEC.md §7 (CSV export) specifies; hidden acceptance tests check every rule of that section. Also make `npm run lint` pass: it currently reports pre-existing violations in src/ that must be fixed without changing behaviour. `npm test` must pass. Do not modify anything under test/ or tools/. Report what you changed and the checks you ran.",
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Hidden acceptance tests and grading.

const HIDDEN: Record<TaskId, Array<[string, string]>> = {
  bugfix: [
    ["format small amounts", `assert.equal(money.formatCents(5), "0.05"); assert.equal(money.formatCents(-5), "-0.05"); assert.equal(money.formatCents(100000000), "1,000,000.00");`],
    ["impossible date", `assert.throws(() => dates.parseISODate("2026-02-30"), TypeError); assert.throws(() => dates.addDays("2026-13-01", 1), TypeError);`],
    ["void unknown entry", `assert.throws(() => ledger.voidEntry(ENTRIES, "nope"), RangeError); assert.equal(ledger.voidEntry(ENTRIES, "e1").find(entry => entry.id === "e1").status, "void");`],
    ["fee silver 1%", `assert.equal(money.applyFee(12345, "silver"), 123);`],
    ["fee basic minimum", `assert.equal(money.applyFee(1000, "basic"), 25);`],
    ["fee silver minimum", `assert.equal(money.applyFee(100, "silver"), 25);`],
    ["fee gold has no minimum", `assert.equal(money.applyFee(1000, "gold"), 5);`],
    ["fee zero or negative amount", `assert.equal(money.applyFee(0, "basic"), 0); assert.equal(money.applyFee(-500, "silver"), 0);`],
    ["fee unknown tier", `assert.throws(() => money.applyFee(1000, "platinum"), RangeError);`],
    ["business days exclude end", `assert.equal(dates.businessDaysBetween("2026-03-02", "2026-03-09"), 5);`],
    ["business days skip holidays", `assert.equal(dates.businessDaysBetween("2026-12-21", "2026-12-28"), 4);`],
    ["business days same day", `assert.equal(dates.businessDaysBetween("2026-03-04", "2026-03-04"), 0);`],
    ["business days reversed", `assert.equal(dates.businessDaysBetween("2026-03-09", "2026-03-02"), 0);`],
    ["account spaces", `assert.equal(accounts.normalizeAccountId("gb82 west 1234 5698 7654 32"), "GB82WEST12345698765432");`],
    ["account tabs and newlines", `assert.equal(accounts.normalizeAccountId("DE89\\t3704 0044\\n0532 0130 00"), "DE89370400440532013000");`],
    ["account bad checksum", `assert.throws(() => accounts.normalizeAccountId("GB82WEST12345698765433"), { name: "TypeError", message: "invalid account id" });`],
    ["balance excludes void", `assert.equal(ledger.balance(ENTRIES, "DE89370400440532013000"), 0);`],
    ["balance per account", `assert.equal(ledger.balance(ENTRIES, "GB82WEST12345698765432"), 1300);`],
    ["summary order and ties", `assert.deepEqual(report.summarize(TIES).lines, ["a1", "a2", "b1", "c0"]);`],
    ["summary totals", `assert.deepEqual(report.summarize(ENTRIES), { accounts: [{ account: "DE89370400440532013000", balance: 0, count: 0 }, { account: "GB82WEST12345698765432", balance: 1300, count: 2 }], total: 1300, lines: ["e1", "e2", "e3"] });`],
  ],
  feature: [
    ["header only", `assert.equal(csv.exportCsv([]), "date,id,account,amount,memo\\r\\n");`],
    ["statement order and default columns", `assert.equal(csv.exportCsv(ROWS.slice(0, 2)), "date,id,account,amount,memo\\r\\n2026-01-01,a,X1,5.00,first\\r\\n2026-01-02,b,X1,7.25,plain\\r\\n");`],
    ["ties by id", `assert.equal(csv.exportCsv([{ ...ROWS[0], id: "z" }, { ...ROWS[0], id: "c" }]).split("\\r\\n").slice(1, 3).map(line => line.split(",")[1]).join(), "c,z");`],
    ["amount with thousands is quoted", `assert.ok(csv.exportCsv([ROWS[2]]).includes('"-1,234.56"'));`],
    ["quotes doubled", `assert.ok(csv.exportCsv([ROWS[3]]).includes('"say ""hi"""'));`],
    ["newline in memo quoted", `assert.ok(csv.exportCsv([ROWS[4]]).includes('"two\\nlines"'));`],
    ["void excluded by default", `assert.equal(csv.exportCsv([ROWS[5]]), "date,id,account,amount,memo\\r\\n");`],
    ["void included on request", `assert.equal(csv.exportCsv([ROWS[5]], { includeVoid: true }).split("\\r\\n").length, 3);`],
    ["custom columns", `assert.equal(csv.exportCsv([ROWS[1]], { columns: ["amount", "id"] }), "amount,id\\r\\n7.25,b\\r\\n");`],
    ["unknown column", `assert.throws(() => csv.exportCsv([], { columns: ["date", "owner"] }), RangeError);`],
    ["semicolon delimiter", `assert.equal(csv.exportCsv([ROWS[2]], { delimiter: ";", columns: ["id", "amount"] }), "id;amount\\r\\nd;-1,234.56\\r\\n");`],
    ["semicolon quoting", `assert.equal(csv.exportCsv([ROWS[6]], { delimiter: ";", columns: ["memo"] }), 'memo\\r\\n"a;b"\\r\\n');`],
    ["bad delimiter", `assert.throws(() => csv.exportCsv([], { delimiter: "|" }), RangeError);`],
    ["missing memo is empty", `assert.equal(csv.exportCsv([{ id: "m", date: "2026-02-01", account: "X2", amount: 1, status: "posted" }], { columns: ["id", "memo"] }), "id,memo\\r\\nm,\\r\\n");`],
  ],
};

export function hiddenTestSource(task: TaskId, workspace: string): string {
  const url = (path: string) => pathToFileURL(join(workspace, path)).href;
  const imports = task === "bugfix"
    ? `import * as money from ${lit(url("src/money.js"))};\nimport * as dates from ${lit(url("src/dates.js"))};\nimport * as accounts from ${lit(url("src/accounts.js"))};\nimport * as ledger from ${lit(url("src/ledger.js"))};\nimport * as report from ${lit(url("src/report.js"))};\n`
    : `import * as csv from ${lit(url("src/csv.js"))};\n`;
  const fixtures = task === "bugfix"
    ? `const ENTRIES = [\n  { id: "e3", date: "2026-03-05", account: "GB82WEST12345698765432", amount: 1500, memo: "rent", status: "posted" },\n  { id: "e1", date: "2026-03-01", account: "GB82WEST12345698765432", amount: -200, memo: "fee", status: "posted" },\n  { id: "e2", date: "2026-03-03", account: "DE89370400440532013000", amount: 999, memo: "refund", status: "void" },\n];\nconst TIES = [\n  { id: "c0", date: "2026-04-02", account: "A", amount: 1, status: "posted" },\n  { id: "b1", date: "2026-04-01", account: "A", amount: 1, status: "posted" },\n  { id: "a2", date: "2026-04-01", account: "A", amount: 1, status: "posted" },\n  { id: "a1", date: "2026-03-31", account: "A", amount: 1, status: "posted" },\n];\n`
    : `const ROWS = [\n  { id: "a", date: "2026-01-01", account: "X1", amount: 500, memo: "first", status: "posted" },\n  { id: "b", date: "2026-01-02", account: "X1", amount: 725, memo: "plain", status: "posted" },\n  { id: "d", date: "2026-01-03", account: "X1", amount: -123456, memo: "big", status: "posted" },\n  { id: "e", date: "2026-01-04", account: "X1", amount: 1, memo: 'say "hi"', status: "posted" },\n  { id: "f", date: "2026-01-05", account: "X1", amount: 1, memo: "two\\nlines", status: "posted" },\n  { id: "g", date: "2026-01-06", account: "X1", amount: 1, memo: "gone", status: "void" },\n  { id: "h", date: "2026-01-07", account: "X1", amount: 1, memo: "a;b", status: "posted" },\n];\n`;
  return `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${imports}${fixtures}\n${HIDDEN[task].map(([name, body]) => `test(${lit(name)}, () => {\n  ${body}\n});`).join("\n")}\n`;
}

export const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export interface Grade {
  task: TaskId;
  hiddenPassed: number;
  hiddenTotal: number;
  hiddenFailed: string[];
  visiblePassed: number;
  visibleFailed: number;
  visibleOk: boolean;
  lintOk: boolean | null;
  protectedUnchanged: boolean;
  changedProtected: string[];
  /** All acceptance criteria: every hidden test, the visible suite, lint (feature) and untouched test/ and tools/. */
  success: boolean;
  score: number;
}

/** TAP summary of `node --test --test-reporter=tap`. */
function tap(output: string) {
  const count = (key: string) => Number(output.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] ?? NaN);
  const failed = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]!.trim());
  return { pass: count("pass"), fail: count("fail"), failed };
}

/** Grade a workspace; `hiddenDir` receives the hidden test file (outside the workspace). Never throws for a broken workspace. */
export function grade(task: TaskId, workspace: string, hiddenDir: string, original: Record<string, string> = generate(task)): Grade {
  mkdirSync(hiddenDir, { recursive: true });
  const hiddenFile = join(hiddenDir, `hidden-${task}.test.mjs`);
  writeFileSync(hiddenFile, hiddenTestSource(task, workspace));
  const run = (args: string[], cwd: string) => spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 120_000, env: { ...process.env, NODE_OPTIONS: "" } });
  const hidden = tap(`${run(["--test", "--test-reporter=tap", hiddenFile], hiddenDir).stdout}`);
  const visible = tap(`${run(["--test", "--test-reporter=tap"], workspace).stdout}`);
  const lint = task === "feature" ? run(["tools/lint.js"], workspace).status === 0 : null;
  const changedProtected = Object.entries(original).filter(([path]) => path.startsWith("test/") || path.startsWith("tools/")).filter(([path, text]) => {
    try { return sha(readFileSync(join(workspace, path))) !== sha(text); } catch { return true; }
  }).map(([path]) => path);
  const hiddenTotal = HIDDEN[task].length;
  const hiddenPassed = Number.isFinite(hidden.pass) ? hidden.pass : 0;
  const visibleOk = Number.isFinite(visible.fail) && visible.fail === 0 && visible.pass > 0;
  const success = hiddenPassed === hiddenTotal && visibleOk && lint !== false && changedProtected.length === 0;
  return {
    task, hiddenPassed, hiddenTotal, hiddenFailed: hidden.failed, visiblePassed: Number.isFinite(visible.pass) ? visible.pass : 0, visibleFailed: Number.isFinite(visible.fail) ? visible.fail : -1,
    visibleOk, lintOk: lint, protectedUnchanged: changedProtected.length === 0, changedProtected, success, score: hiddenPassed / hiddenTotal,
  };
}

/** Approximate size of the generated workspace in tokens (chars / 4), for the README. */
export function workspaceStats(task: TaskId) {
  const files = generate(task);
  const chars = Object.values(files).reduce((total, text) => total + text.length, 0);
  return { files: Object.keys(files).length, chars, approxTokens: Math.round(chars / 4), specChars: files["docs/SPEC.md"]!.length };
}

export const nodeVersion = () => execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
