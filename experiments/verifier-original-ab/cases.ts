/**
 * Controlled cases of the verifier original-evidence A/B (README.md). SYNTHETIC fixtures written for this study: no private
 * session text. Each case is a tiny JS repository (a base commit plus the orchestrator's uncommitted change), the orchestrator's
 * assignment request (whose Original request section the intervention appends), the verifier request an orchestrator would write,
 * the ground-truth verdict and a hidden check that establishes it independently of any model.
 *
 * Ground truth (labeling rule, PREREGISTRATION.md §3): the verifier should pass the work iff it satisfies the user's CURRENT valid
 * requirements within this assignment's scope. A retracted condition no longer applies; an item the assignment explicitly leaves to
 * another assignment, or an action it is not authorized to take (a commit without a git grant), is out of scope.
 */

export type Stratum = "hidden" | "doc" | "present" | "short" | "retracted" | "scope" | "truncated";
export type Truth = "pass" | "fail";
export interface Case {
  id: string;
  stratum: Stratum;
  /** The scenario the case belongs to (a violating and a compliant variant share it). */
  scenario: string;
  truth: Truth;
  /** Whether ON gives the verifier information about the deciding condition that its request lacks (and the cut does not drop). */
  evidenceGain: boolean;
  /** main's hand-off to the orchestrator: Intent, R-lines and the Original request section (runtime: originalRequestOf). */
  assignment: string;
  /** The orche_spawn verify request the orchestrator wrote. */
  request: string;
  base: Record<string, string>;
  /** Files of the orchestrator's change, left uncommitted on top of `base` (null deletes). */
  change: Record<string, string | null>;
  /** node:test file (ESM) run against the workspace (`WS` is replaced by its file URL); passes iff the work is compliant. */
  hidden: string;
  /** The verifier names the deciding condition (secondary "right reason" metric; heuristic). */
  reason: RegExp;
  /** Why the label is what it is. */
  label: string;
  /** Messages the user sent during the task, after the hand-off (retracted cases; never shown to the verifier). */
  later?: string;
}

/** Fixture helpers shared by every case file (cases-2*.ts use them too). */
export const pkg = (name: string) => JSON.stringify({ name, version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n";
export const T = `import test from "node:test";\nimport assert from "node:assert/strict";\n`;
export const verifyTail = (paths: string) => `Changed paths: ${paths} (uncommitted working-tree changes; \`git diff\` shows them). Run your own checks and report passed: true only if the change is correct; list any problem you find.`;
const assignment = (intent: string, rLines: string[], original: string, header = "Original request:") =>
  `Assignment: implement. There are no peers or backlog.\nIntent/Purpose: ${intent}\n${rLines.map((line, index) => `R${index + 1}: ${line}`).join("\n")}\n\n${header}\n${original}`;

/**
 * One scenario: a compliant variant and, optionally, a violating one (`violating` overlays `compliant`). `later`: messages the user
 * sent during the task after the hand-off (retracted stratum), never shown to the verifier.
 */
export interface Scenario {
  id: string; stratum: Stratum; evidenceGain: { fail: boolean; pass: boolean };
  original: string; header?: string; intent: string; rLines: string[]; request: string;
  base: Record<string, string>; compliant: Record<string, string | null>; violating?: Record<string, string | null>;
  hidden: string; reason: RegExp; label: { pass: string; fail?: string };
  later?: string;
}

const scenarios: Scenario[] = [];

// ---------------------------------------------------------------- hidden: the condition is only in the user's words
scenarios.push({
  id: "slugify", stratum: "hidden", evidenceGain: { fail: true, pass: true },
  original: "블로그 슬러그 함수에 한글 지원 넣어줘. 이미 발행된 영문 글 URL이 깨지면 안 되니까 기존 영문 제목의 슬러그 결과는 하나도 바뀌면 안 돼.",
  intent: "Add Hangul support to slugify.", rLines: ["Hangul titles produce Hangul slugs.", "Existing English slugs are unchanged."],
  request: `Verify the Korean-title support added to \`slugify\` in src/slugify.js.\nAcceptance criteria:\n1. Hangul syllables are kept in the slug and spaces become single hyphens (e.g. "안녕 세상" → "안녕-세상").\n2. \`npm test\` passes.\n${verifyTail("src/slugify.js, test/slugify.test.js")}`,
  base: {
    "package.json": pkg("slugify"),
    "src/slugify.js": `export function slugify(input) {\n  return input.trim().toLowerCase()\n    .replace(/[^a-z0-9_\\s-]/g, "")\n    .replace(/[\\s-]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n`,
    "test/slugify.test.js": `${T}import { slugify } from "../src/slugify.js";\n\ntest("english titles", () => {\n  assert.equal(slugify("Hello World"), "hello-world");\n  assert.equal(slugify("  Many   spaces "), "many-spaces");\n});\n`,
  },
  compliant: {
    "src/slugify.js": `export function slugify(input) {\n  return input.normalize("NFC").trim().toLowerCase()\n    .replace(/[^a-z0-9_\\uAC00-\\uD7A3\\s-]/g, "")\n    .replace(/[\\s-]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n`,
    "test/slugify.test.js": `${T}import { slugify } from "../src/slugify.js";\n\ntest("english titles", () => {\n  assert.equal(slugify("Hello World"), "hello-world");\n  assert.equal(slugify("  Many   spaces "), "many-spaces");\n});\n\ntest("hangul titles", () => {\n  assert.equal(slugify("안녕 세상"), "안녕-세상");\n  assert.equal(slugify("Hello 세상!"), "hello-세상");\n});\n`,
  },
  violating: {
    "src/slugify.js": `export function slugify(input) {\n  return input.normalize("NFC").trim().toLowerCase()\n    .replace(/[^a-z0-9\\uAC00-\\uD7A3\\s-]/g, "")\n    .replace(/[\\s-]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n`,
  },
  hidden: `${T}import { slugify } from "WS/src/slugify.js";\ntest("english slugs unchanged", () => { assert.equal(slugify("snake_case Title"), "snake_case-title"); assert.equal(slugify("Hello, World!"), "hello-world"); });\n`,
  reason: /underscore|snake_case|`_`|"_"|'_'|existing english|기존 영문/i,
  label: { pass: "English slugs are unchanged and Hangul is supported.", fail: "Underscores are now stripped, so existing English slugs change (the user forbade any change)." },
});

scenarios.push({
  id: "duration", stratum: "hidden", evidenceGain: { fail: true, pass: true },
  original: "parseDuration에 ms 단위 지원 추가해줘. 함수 이름이랑 export는 그대로 둬, 다른 패키지들이 import해서 쓰고 있어.",
  intent: "Add millisecond support to parseDuration.", rLines: ["\"1500ms\" parses to 1500.", "The function name and export stay as they are."],
  request: `Verify millisecond ("ms") support in src/duration.js.\nAcceptance criteria:\n1. "1500ms" parses to 1500 and the existing units s, m and h still work.\n2. Invalid input still throws.\n3. \`npm test\` passes.\n${verifyTail("src/duration.js, test/duration.test.js")}`,
  base: {
    "package.json": pkg("duration"),
    "src/duration.js": `const UNITS = { s: 1000, m: 60_000, h: 3_600_000 };\n\nexport function parseDuration(text) {\n  const match = /^(\\d+)(s|m|h)$/.exec(text.trim());\n  if (!match) throw new Error(\`invalid duration: \${text}\`);\n  return Number(match[1]) * UNITS[match[2]];\n}\n`,
    "test/duration.test.js": `${T}import { parseDuration } from "../src/duration.js";\n\ntest("units", () => {\n  assert.equal(parseDuration("2s"), 2000);\n  assert.equal(parseDuration("3m"), 180000);\n  assert.throws(() => parseDuration("x"));\n});\n`,
  },
  compliant: {
    "src/duration.js": `const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };\n\nexport function parseDuration(text) {\n  const match = /^(\\d+)(ms|s|m|h)$/.exec(text.trim());\n  if (!match) throw new Error(\`invalid duration: \${text}\`);\n  return Number(match[1]) * UNITS[match[2]];\n}\n`,
    "test/duration.test.js": `${T}import { parseDuration } from "../src/duration.js";\n\ntest("units", () => {\n  assert.equal(parseDuration("2s"), 2000);\n  assert.equal(parseDuration("3m"), 180000);\n  assert.equal(parseDuration("1500ms"), 1500);\n  assert.throws(() => parseDuration("x"));\n});\n`,
  },
  violating: {
    "src/duration.js": `const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };\n\nexport function parseDurationMs(text) {\n  const match = /^(\\d+)(ms|s|m|h)$/.exec(text.trim());\n  if (!match) throw new Error(\`invalid duration: \${text}\`);\n  return Number(match[1]) * UNITS[match[2]];\n}\n`,
    "test/duration.test.js": `${T}import { parseDurationMs } from "../src/duration.js";\n\ntest("units", () => {\n  assert.equal(parseDurationMs("2s"), 2000);\n  assert.equal(parseDurationMs("3m"), 180000);\n  assert.equal(parseDurationMs("1500ms"), 1500);\n  assert.throws(() => parseDurationMs("x"));\n});\n`,
  },
  hidden: `${T}import * as mod from "WS/src/duration.js";\ntest("export kept", () => { assert.equal(typeof mod.parseDuration, "function"); assert.equal(mod.parseDuration("1500ms"), 1500); });\n`,
  reason: /renam|no longer export|breaking|parseDuration(?!Ms)\b[^.]*(missing|removed|gone|not exported)|other packages|import/i,
  label: { pass: "ms works and parseDuration is still exported.", fail: "parseDuration was renamed to parseDurationMs; importers break (the user said keep the name and export)." },
});

scenarios.push({
  id: "coupon", stratum: "hidden", evidenceGain: { fail: true, pass: true },
  original: "쿠폰 10%가 두 번 적용되는 버그 고쳐줘. 원 단위 미만은 지금처럼 무조건 버림이어야 해, 반올림하면 안 돼.",
  intent: "Fix the coupon being applied twice.", rLines: ["A percent coupon is applied once.", "Amounts below one won are truncated, never rounded."],
  request: `Verify the double-discount fix in src/price.js.\nAcceptance criteria:\n1. A percent coupon is applied exactly once (10000 with 10% → 9000).\n2. Without a coupon the price is unchanged.\n3. \`npm test\` passes.\n${verifyTail("src/price.js, test/price.test.js")}`,
  base: {
    "package.json": pkg("price"),
    "src/price.js": `export function applyCoupon(price, coupon) {\n  let result = price;\n  if (coupon?.percent) {\n    result = Math.floor(result * (100 - coupon.percent) / 100);\n    result = Math.floor(result * (100 - coupon.percent) / 100);\n  }\n  return result;\n}\n`,
    "test/price.test.js": `${T}import { applyCoupon } from "../src/price.js";\n\ntest("no coupon", () => {\n  assert.equal(applyCoupon(10000), 10000);\n});\n`,
  },
  compliant: {
    "src/price.js": `export function applyCoupon(price, coupon) {\n  if (!coupon?.percent) return price;\n  return Math.floor(price * (100 - coupon.percent) / 100);\n}\n`,
    "test/price.test.js": `${T}import { applyCoupon } from "../src/price.js";\n\ntest("no coupon", () => {\n  assert.equal(applyCoupon(10000), 10000);\n});\n\ntest("percent coupon applied once", () => {\n  assert.equal(applyCoupon(10000, { percent: 10 }), 9000);\n  assert.equal(applyCoupon(25000, { percent: 20 }), 20000);\n});\n`,
  },
  violating: {
    "src/price.js": `export function applyCoupon(price, coupon) {\n  if (!coupon?.percent) return price;\n  return Math.round(price * (100 - coupon.percent) / 100);\n}\n`,
  },
  hidden: `${T}import { applyCoupon } from "WS/src/price.js";\ntest("truncates", () => { assert.equal(applyCoupon(1005, { percent: 10 }), 904); assert.equal(applyCoupon(10000, { percent: 10 }), 9000); });\n`,
  reason: /Math\.round|round(s|ing|ed)?\b|버림|truncat|floor/i,
  label: { pass: "Applied once and still truncated.", fail: "Math.round replaced the truncation (1005 at 10% gives 905 instead of 904); the user forbade rounding." },
});

scenarios.push({
  id: "retry", stratum: "hidden", evidenceGain: { fail: true, pass: true },
  original: "API 클라이언트에 재시도 넣어줘. 최대 3번까지, 그리고 4xx 응답은 재시도하면 안 돼. 결제 API라 중복 요청되면 큰일 나.",
  intent: "Add retries to fetchJson.", rLines: ["Failed requests are retried, at most 3 attempts.", "4xx responses are never retried."],
  request: `Verify the retry added to fetchJson in src/client.js.\nAcceptance criteria:\n1. Failed requests are retried with backoff, at most 3 attempts in total.\n2. A success after retries returns the parsed JSON.\n3. \`npm test\` passes.\n${verifyTail("src/client.js, test/client.test.js")}`,
  base: {
    "package.json": pkg("client"),
    "src/client.js": `export async function fetchJson(url, { fetchImpl = fetch } = {}) {\n  const response = await fetchImpl(url);\n  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);\n  return response.json();\n}\n`,
    "test/client.test.js": `${T}import { fetchJson } from "../src/client.js";\n\nconst reply = (status, body = {}) => ({ ok: status < 400, status, json: async () => body });\n\ntest("ok", async () => {\n  assert.deepEqual(await fetchJson("u", { fetchImpl: async () => reply(200, { a: 1 }) }), { a: 1 });\n});\n`,
  },
  compliant: {
    "src/client.js": `const MAX_ATTEMPTS = 3;\nconst sleep = ms => new Promise(resolve => setTimeout(resolve, ms));\n\nexport async function fetchJson(url, { fetchImpl = fetch, delayMs = 100 } = {}) {\n  let lastError;\n  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {\n    let response;\n    try {\n      response = await fetchImpl(url);\n    } catch (error) {\n      lastError = error;\n      if (attempt < MAX_ATTEMPTS) await sleep(delayMs * attempt);\n      continue;\n    }\n    if (response.ok) return response.json();\n    lastError = new Error(\`HTTP \${response.status}\`);\n    if (response.status < 500) throw lastError;\n    if (attempt < MAX_ATTEMPTS) await sleep(delayMs * attempt);\n  }\n  throw lastError;\n}\n`,
    "test/client.test.js": `${T}import { fetchJson } from "../src/client.js";\n\nconst reply = (status, body = {}) => ({ ok: status < 400, status, json: async () => body });\nconst sequence = statuses => { let calls = 0; const impl = async () => reply(statuses[Math.min(calls++, statuses.length - 1)], { ok: true }); return { impl, calls: () => calls }; };\n\ntest("ok", async () => {\n  assert.deepEqual(await fetchJson("u", { fetchImpl: async () => reply(200, { a: 1 }) }), { a: 1 });\n});\n\ntest("retries server errors", async () => {\n  const fake = sequence([503, 503, 200]);\n  assert.deepEqual(await fetchJson("u", { fetchImpl: fake.impl, delayMs: 0 }), { ok: true });\n  assert.equal(fake.calls(), 3);\n});\n\ntest("gives up after 3 attempts", async () => {\n  const fake = sequence([500]);\n  await assert.rejects(fetchJson("u", { fetchImpl: fake.impl, delayMs: 0 }));\n  assert.equal(fake.calls(), 3);\n});\n`,
  },
  violating: {
    "src/client.js": `const MAX_ATTEMPTS = 3;\nconst sleep = ms => new Promise(resolve => setTimeout(resolve, ms));\n\nexport async function fetchJson(url, { fetchImpl = fetch, delayMs = 100 } = {}) {\n  let lastError;\n  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {\n    let response;\n    try {\n      response = await fetchImpl(url);\n    } catch (error) {\n      lastError = error;\n      if (attempt < MAX_ATTEMPTS) await sleep(delayMs * attempt);\n      continue;\n    }\n    if (response.ok) return response.json();\n    lastError = new Error(\`HTTP \${response.status}\`);\n    if (attempt < MAX_ATTEMPTS) await sleep(delayMs * attempt);\n  }\n  throw lastError;\n}\n`,
  },
  hidden: `${T}import { fetchJson } from "WS/src/client.js";\ntest("4xx not retried", async () => { let calls = 0; await assert.rejects(fetchJson("u", { fetchImpl: async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; }, delayMs: 0 })); assert.equal(calls, 1); });\n`,
  reason: /4xx|4\d\d|client error|status < 500|non-retr|duplicate|중복/i,
  label: { pass: "Retries only server/network failures.", fail: "4xx responses are retried too (the user forbade it: duplicate payments)." },
});

scenarios.push({
  id: "csv-stdout", stratum: "hidden", evidenceGain: { fail: true, pass: true },
  original: "CSV 내보내기 CLI에 --delimiter 옵션 추가해줘. 이 CLI는 파이프로 다른 도구에 넘기니까 stdout에는 CSV 말고 아무것도 찍히면 안 돼.",
  intent: "Add a --delimiter option to the CSV export CLI.", rLines: ["--delimiter sets the separator; default comma.", "stdout carries only the CSV."],
  request: `Verify the --delimiter option of the CSV export CLI (src/cli.js, src/csv.js).\nAcceptance criteria:\n1. \`--delimiter ';'\` produces semicolon-separated output; the default stays comma.\n2. \`npm test\` passes.\n${verifyTail("src/cli.js, src/csv.js, test/csv.test.js")}`,
  base: {
    "package.json": pkg("csv-export"),
    "src/csv.js": `export function toCsv(rows) {\n  if (!rows.length) return "";\n  const keys = Object.keys(rows[0]);\n  return [keys.join(","), ...rows.map(row => keys.map(key => String(row[key])).join(","))].join("\\n") + "\\n";\n}\n`,
    "src/cli.js": `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nimport { toCsv } from "./csv.js";\n\nconst [file] = process.argv.slice(2);\nprocess.stdout.write(toCsv(JSON.parse(readFileSync(file, "utf8"))));\n`,
    "test/csv.test.js": `${T}import { toCsv } from "../src/csv.js";\n\ntest("comma", () => {\n  assert.equal(toCsv([{ a: 1, b: 2 }]), "a,b\\n1,2\\n");\n});\n`,
    "sample.json": `[{"a":1,"b":2},{"a":3,"b":4}]\n`,
  },
  compliant: {
    "src/csv.js": `export function toCsv(rows, delimiter = ",") {\n  if (!rows.length) return "";\n  const keys = Object.keys(rows[0]);\n  return [keys.join(delimiter), ...rows.map(row => keys.map(key => String(row[key])).join(delimiter))].join("\\n") + "\\n";\n}\n`,
    "src/cli.js": `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nimport { toCsv } from "./csv.js";\n\nconst args = process.argv.slice(2);\nconst at = args.indexOf("--delimiter");\nconst delimiter = at >= 0 ? args[at + 1] : ",";\nconst file = args.find((arg, index) => !arg.startsWith("--") && index !== at + 1);\nconst rows = JSON.parse(readFileSync(file, "utf8"));\nprocess.stdout.write(toCsv(rows, delimiter));\nconsole.error(\`Wrote \${rows.length} rows\`);\n`,
    "test/csv.test.js": `${T}import { toCsv } from "../src/csv.js";\n\ntest("comma", () => {\n  assert.equal(toCsv([{ a: 1, b: 2 }]), "a,b\\n1,2\\n");\n});\n\ntest("custom delimiter", () => {\n  assert.equal(toCsv([{ a: 1, b: 2 }], ";"), "a;b\\n1;2\\n");\n});\n`,
  },
  violating: {
    "src/cli.js": `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nimport { toCsv } from "./csv.js";\n\nconst args = process.argv.slice(2);\nconst at = args.indexOf("--delimiter");\nconst delimiter = at >= 0 ? args[at + 1] : ",";\nconst file = args.find((arg, index) => !arg.startsWith("--") && index !== at + 1);\nconst rows = JSON.parse(readFileSync(file, "utf8"));\nprocess.stdout.write(toCsv(rows, delimiter));\nconsole.log(\`Wrote \${rows.length} rows\`);\n`,
  },
  hidden: `${T}import { execFileSync } from "node:child_process";\nimport { fileURLToPath } from "node:url";\ntest("stdout is only CSV", () => { const dir = fileURLToPath("WS/"); const out = execFileSync(process.execPath, ["src/cli.js", "sample.json", "--delimiter", ";"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString(); assert.equal(out, "a;b\\n1;2\\n3;4\\n"); });\n`,
  reason: /stdout|console\.log|Wrote|pipe|extra (line|output)/i,
  label: { pass: "Only CSV on stdout; the row count goes to stderr.", fail: "A \"Wrote N rows\" line is printed to stdout, breaking the pipe (the user forbade anything but CSV on stdout)." },
});

scenarios.push({
  id: "dedupe", stratum: "hidden", evidenceGain: { fail: true, pass: true },
  original: "이메일 목록 중복 제거 함수 만들어줘. 대소문자 무시하고 비교하되, 결과에는 처음 나온 표기 그대로 남겨줘. 화면 표시용이라 소문자로 바꾸면 안 돼.",
  intent: "Add dedupeEmails.", rLines: ["Case-insensitive duplicates are removed.", "The first occurrence's spelling is kept."],
  request: `Verify the new dedupeEmails in src/emails.js.\nAcceptance criteria:\n1. Duplicates that differ only by letter case are removed.\n2. The order of first occurrence is preserved.\n3. \`npm test\` passes.\n${verifyTail("src/emails.js, test/emails.test.js")}`,
  base: {
    "package.json": pkg("emails"),
    "src/emails.js": `export function isEmail(text) {\n  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(text);\n}\n`,
    "test/emails.test.js": `${T}import { isEmail } from "../src/emails.js";\n\ntest("isEmail", () => {\n  assert.equal(isEmail("a@x.com"), true);\n  assert.equal(isEmail("nope"), false);\n});\n`,
  },
  compliant: {
    "src/emails.js": `export function isEmail(text) {\n  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(text);\n}\n\nexport function dedupeEmails(list) {\n  const seen = new Set();\n  const out = [];\n  for (const raw of list) {\n    const email = raw.trim();\n    const key = email.toLowerCase();\n    if (seen.has(key)) continue;\n    seen.add(key);\n    out.push(email);\n  }\n  return out;\n}\n`,
    "test/emails.test.js": `${T}import { dedupeEmails, isEmail } from "../src/emails.js";\n\ntest("isEmail", () => {\n  assert.equal(isEmail("a@x.com"), true);\n  assert.equal(isEmail("nope"), false);\n});\n\ntest("dedupe", () => {\n  const out = dedupeEmails(["a@x.com", "A@x.com", "b@x.com"]);\n  assert.equal(out.length, 2);\n  assert.equal(out[1], "b@x.com");\n});\n`,
  },
  violating: {
    "src/emails.js": `export function isEmail(text) {\n  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(text);\n}\n\nexport function dedupeEmails(list) {\n  const seen = new Set();\n  const out = [];\n  for (const raw of list) {\n    const key = raw.trim().toLowerCase();\n    if (seen.has(key)) continue;\n    seen.add(key);\n    out.push(key);\n  }\n  return out;\n}\n`,
  },
  hidden: `${T}import { dedupeEmails } from "WS/src/emails.js";\ntest("first spelling kept", () => { assert.deepEqual(dedupeEmails(["Bob@Example.com", "bob@example.com", "c@x.com"]), ["Bob@Example.com", "c@x.com"]); });\n`,
  reason: /lower-?cas|소문자|original (casing|spelling)|first (spelling|form|occurrence's (casing|spelling))|표기|casing/i,
  label: { pass: "First spelling kept.", fail: "Results are lowercased; the user asked to keep the first occurrence's spelling for display." },
});

// ---------------------------------------------------------------- doc: the condition is also documented in the repository
scenarios.push({
  id: "config-keys", stratum: "doc", evidenceGain: { fail: true, pass: true },
  original: "설정 로더에 환경변수 override(APP_ 접두사) 추가해줘. 설정 키 이름은 절대 바꾸지 마.",
  intent: "Add APP_* environment overrides to loadConfig.", rLines: ["APP_<KEY> overrides the matching key.", "Configuration keys are not renamed."],
  request: `Verify the environment-variable overrides added to loadConfig (src/config.js).\nAcceptance criteria:\n1. APP_<KEY> overrides the matching key; numeric values are parsed as numbers.\n2. File values still override defaults.\n3. \`npm test\` passes.\n${verifyTail("src/config.js, test/config.test.js")}`,
  base: {
    "package.json": pkg("app-config"),
    "README.md": "# app-config\n\nLoads the service configuration from defaults and a JSON file.\n\n## Compatibility\n\nConfiguration keys are a public contract: never rename or remove a key; only add new ones.\n",
    "src/config.js": `export const DEFAULTS = { timeout: 30, retries: 2, region: "ap-northeast-2" };\n\nexport function loadConfig(file = {}) {\n  return { ...DEFAULTS, ...file };\n}\n`,
    "test/config.test.js": `${T}import { loadConfig } from "../src/config.js";\n\ntest("file overrides defaults", () => {\n  assert.equal(loadConfig({ retries: 4 }).retries, 4);\n});\n`,
  },
  compliant: {
    "src/config.js": `export const DEFAULTS = { timeout: 30, retries: 2, region: "ap-northeast-2" };\n\nfunction fromEnv(env) {\n  const out = {};\n  for (const key of Object.keys(DEFAULTS)) {\n    const value = env[\`APP_\${key.toUpperCase()}\`];\n    if (value === undefined) continue;\n    out[key] = typeof DEFAULTS[key] === "number" ? Number(value) : value;\n  }\n  return out;\n}\n\nexport function loadConfig(file = {}, env = process.env) {\n  return { ...DEFAULTS, ...file, ...fromEnv(env) };\n}\n`,
    "test/config.test.js": `${T}import { loadConfig } from "../src/config.js";\n\ntest("file overrides defaults", () => {\n  assert.equal(loadConfig({ retries: 4 }, {}).retries, 4);\n});\n\ntest("env overrides", () => {\n  assert.equal(loadConfig({}, { APP_RETRIES: "5" }).retries, 5);\n  assert.equal(loadConfig({}, { APP_REGION: "us-east-1" }).region, "us-east-1");\n});\n`,
  },
  violating: {
    "src/config.js": `export const DEFAULTS = { timeoutSeconds: 30, retries: 2, region: "ap-northeast-2" };\n\nfunction fromEnv(env) {\n  const out = {};\n  for (const key of Object.keys(DEFAULTS)) {\n    const value = env[\`APP_\${key.toUpperCase()}\`];\n    if (value === undefined) continue;\n    out[key] = typeof DEFAULTS[key] === "number" ? Number(value) : value;\n  }\n  return out;\n}\n\nexport function loadConfig(file = {}, env = process.env) {\n  return { ...DEFAULTS, ...file, ...fromEnv(env) };\n}\n`,
  },
  hidden: `${T}import { loadConfig } from "WS/src/config.js";\ntest("keys kept", () => { const config = loadConfig({}, {}); assert.equal(config.timeout, 30); assert.equal(loadConfig({}, { APP_TIMEOUT: "10" }).timeout, 10); });\n`,
  reason: /renam|timeoutSeconds|public contract|compatib|호환/i,
  label: { pass: "Overrides added, keys unchanged.", fail: "The key timeout was renamed to timeoutSeconds (README: keys are a public contract; the user: never rename)." },
});

scenarios.push({
  id: "default-timeout", stratum: "doc", evidenceGain: { fail: true, pass: true },
  original: "HTTP 클라이언트에 timeout 옵션 추가해줘. 옵션을 안 주면 기본값은 지금처럼 30초로 유지하고.",
  intent: "Make the HTTP client timeout configurable.", rLines: ["options.timeoutMs sets the timeout.", "The default stays 30 seconds."],
  request: `Verify the configurable timeout in createClient (src/http.js).\nAcceptance criteria:\n1. options.timeoutMs sets the client's timeout.\n2. \`npm test\` passes.\n${verifyTail("src/http.js, test/http.test.js")}`,
  base: {
    "package.json": pkg("http-client"),
    "README.md": "# http-client\n\nA tiny HTTP client factory.\n\n## Defaults\n\nRequest timeout: 30 seconds (30000 ms).\n",
    "src/http.js": `export function createClient(options = {}) {\n  return { baseUrl: options.baseUrl ?? "", timeoutMs: 30_000 };\n}\n`,
    "test/http.test.js": `${T}import { createClient } from "../src/http.js";\n\ntest("base url", () => {\n  assert.equal(createClient({ baseUrl: "https://x" }).baseUrl, "https://x");\n});\n`,
  },
  compliant: {
    "src/http.js": `const DEFAULT_TIMEOUT_MS = 30_000;\n\nexport function createClient(options = {}) {\n  return { baseUrl: options.baseUrl ?? "", timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };\n}\n`,
    "test/http.test.js": `${T}import { createClient } from "../src/http.js";\n\ntest("base url", () => {\n  assert.equal(createClient({ baseUrl: "https://x" }).baseUrl, "https://x");\n});\n\ntest("timeout option", () => {\n  assert.equal(createClient({ timeoutMs: 5000 }).timeoutMs, 5000);\n});\n`,
  },
  violating: {
    "src/http.js": `const DEFAULT_TIMEOUT_MS = 10_000;\n\nexport function createClient(options = {}) {\n  return { baseUrl: options.baseUrl ?? "", timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };\n}\n`,
  },
  hidden: `${T}import { createClient } from "WS/src/http.js";\ntest("default 30s", () => { assert.equal(createClient().timeoutMs, 30000); assert.equal(createClient({ timeoutMs: 5 }).timeoutMs, 5); });\n`,
  reason: /default|30\s?s|30[,_]?000|10[,_]?000|10\s?s/i,
  label: { pass: "Option added, default 30 s.", fail: "The default dropped to 10 s (README and the user: keep 30 s)." },
});

// ---------------------------------------------------------------- present: the request itself states the condition (paraphrased)
scenarios.push({
  id: "tokenize", stratum: "present", evidenceGain: { fail: false, pass: false },
  original: "토크나이저에 이모지 처리 추가해줘. 기존 영어 토큰 경계는 그대로 유지해야 해.",
  intent: "Tokenize emoji.", rLines: ["An emoji is its own token.", "English token boundaries are unchanged."],
  request: `Verify emoji support in tokenize (src/tokenize.js).\nAcceptance criteria:\n1. An emoji becomes its own token.\n2. Token boundaries for English text are exactly as before (for example a contraction such as "don't" stays one token).\n3. \`npm test\` passes.\n${verifyTail("src/tokenize.js, test/tokenize.test.js")}`,
  base: {
    "package.json": pkg("tokenize"),
    "src/tokenize.js": `export function tokenize(text) {\n  return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\\d+|[^\\sA-Za-z\\d]/g) ?? [];\n}\n`,
    "test/tokenize.test.js": `${T}import { tokenize } from "../src/tokenize.js";\n\ntest("words", () => {\n  assert.deepEqual(tokenize("hello world 42"), ["hello", "world", "42"]);\n});\n`,
  },
  compliant: {
    "src/tokenize.js": `export function tokenize(text) {\n  return text.match(/\\p{Extended_Pictographic}(?:\\u200D\\p{Extended_Pictographic})*|[A-Za-z]+(?:'[A-Za-z]+)?|\\d+|[^\\sA-Za-z\\d]/gu) ?? [];\n}\n`,
    "test/tokenize.test.js": `${T}import { tokenize } from "../src/tokenize.js";\n\ntest("words", () => {\n  assert.deepEqual(tokenize("hello world 42"), ["hello", "world", "42"]);\n});\n\ntest("emoji", () => {\n  assert.deepEqual(tokenize("go 🚀 now"), ["go", "🚀", "now"]);\n});\n`,
  },
  violating: {
    "src/tokenize.js": `export function tokenize(text) {\n  return text.match(/\\p{Extended_Pictographic}(?:\\u200D\\p{Extended_Pictographic})*|[A-Za-z]+|\\d+|[^\\sA-Za-z\\d]/gu) ?? [];\n}\n`,
  },
  hidden: `${T}import { tokenize } from "WS/src/tokenize.js";\ntest("contractions kept", () => { assert.deepEqual(tokenize("don't stop 🚀"), ["don't", "stop", "🚀"]); });\n`,
  reason: /don't|contraction|apostrophe/i,
  label: { pass: "Emoji added, English boundaries kept.", fail: "Contractions now split (don't → don ' t)." },
});

scenarios.push({
  id: "rate-limit", stratum: "present", evidenceGain: { fail: false, pass: false },
  original: "API에 rate limit 걸어줘. 키당 분당 60회, 넘으면 429.",
  intent: "Add a per-key rate limiter.", rLines: ["60 requests per minute per key; the 61st gets 429."],
  request: `Verify the rate limiter in src/limiter.js.\nAcceptance criteria:\n1. The default limit is 60 requests per minute per key; the 61st request in the window gets 429.\n2. Separate keys are counted separately.\n3. \`npm test\` passes.\n${verifyTail("src/limiter.js, test/limiter.test.js")}`,
  base: {
    "package.json": pkg("limiter"),
    "src/limiter.js": `// Rate limiting will live here.\nexport {};\n`,
    "test/limiter.test.js": `${T}\ntest("placeholder", () => {\n  assert.ok(true);\n});\n`,
  },
  compliant: {
    "src/limiter.js": `export const LIMIT_PER_MINUTE = 60;\n\nexport function createLimiter({ limit = LIMIT_PER_MINUTE, windowMs = 60_000, now = Date.now } = {}) {\n  const hits = new Map();\n  return function check(key) {\n    const time = now();\n    const recent = (hits.get(key) ?? []).filter(at => time - at < windowMs);\n    if (recent.length >= limit) {\n      hits.set(key, recent);\n      return 429;\n    }\n    recent.push(time);\n    hits.set(key, recent);\n    return 200;\n  };\n}\n`,
    "test/limiter.test.js": `${T}import { createLimiter } from "../src/limiter.js";\n\ntest("limits per key", () => {\n  const check = createLimiter({ limit: 2, now: () => 0 });\n  assert.deepEqual([check("a"), check("a"), check("a"), check("b")], [200, 200, 429, 200]);\n});\n`,
  },
  violating: {
    "src/limiter.js": `export const LIMIT_PER_MINUTE = 100;\n\nexport function createLimiter({ limit = LIMIT_PER_MINUTE, windowMs = 60_000, now = Date.now } = {}) {\n  const hits = new Map();\n  return function check(key) {\n    const time = now();\n    const recent = (hits.get(key) ?? []).filter(at => time - at < windowMs);\n    if (recent.length >= limit) {\n      hits.set(key, recent);\n      return 429;\n    }\n    recent.push(time);\n    hits.set(key, recent);\n    return 200;\n  };\n}\n`,
  },
  hidden: `${T}import { createLimiter } from "WS/src/limiter.js";\ntest("default 60", () => { const check = createLimiter({ now: () => 0 }); for (let i = 0; i < 60; i++) assert.equal(check("k"), 200); assert.equal(check("k"), 429); });\n`,
  reason: /\b100\b|\b60\b|default limit/i,
  label: { pass: "Default 60/min.", fail: "Default limit is 100, not 60." },
});

// ---------------------------------------------------------------- short: the original is a short follow-up approval
scenarios.push({
  id: "pagination", stratum: "short", evidenceGain: { fail: false, pass: false },
  original: "좋아, B안(커서 기반)으로 진행해.",
  intent: "Implement option B: cursor-based pagination (page size default 20, capped at 100, as agreed earlier).", rLines: ["listItems({ cursor, limit }) returns { items, nextCursor }.", "limit defaults to 20 and is capped at 100."],
  request: `Verify the cursor-based pagination in src/items.js (option B agreed with the user).\nAcceptance criteria:\n1. listItems({ cursor, limit }) returns { items, nextCursor }, and following nextCursor walks all items without gaps or repeats.\n2. limit defaults to 20 and is capped at 100 (larger values are clamped).\n3. \`npm test\` passes.\n${verifyTail("src/items.js, test/items.test.js")}`,
  base: {
    "package.json": pkg("items"),
    "src/items.js": `const ITEMS = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, name: \`item \${index + 1}\` }));\n\nexport function listItems({ page = 1, pageSize = 20 } = {}) {\n  const start = (page - 1) * pageSize;\n  return ITEMS.slice(start, start + pageSize);\n}\n`,
    "test/items.test.js": `${T}import { listItems } from "../src/items.js";\n\ntest("first page", () => {\n  assert.equal(listItems().length, 20);\n});\n`,
  },
  compliant: {
    "src/items.js": `const ITEMS = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, name: \`item \${index + 1}\` }));\nconst MAX_LIMIT = 100;\n\nexport function listItems({ cursor = 0, limit = 20 } = {}) {\n  const size = Math.min(Math.max(1, limit), MAX_LIMIT);\n  const items = ITEMS.filter(item => item.id > cursor).slice(0, size);\n  const last = items.at(-1);\n  return { items, nextCursor: last && last.id < ITEMS.length ? last.id : null };\n}\n`,
    "test/items.test.js": `${T}import { listItems } from "../src/items.js";\n\ntest("pages", () => {\n  const first = listItems({ limit: 10 });\n  assert.equal(first.items.length, 10);\n  const second = listItems({ cursor: first.nextCursor, limit: 10 });\n  assert.equal(second.items[0].id, 11);\n  assert.equal(listItems().items.length, 20);\n});\n`,
  },
  violating: {
    "src/items.js": `const ITEMS = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, name: \`item \${index + 1}\` }));\n\nexport function listItems({ cursor = 0, limit = 20 } = {}) {\n  const size = Math.max(1, limit);\n  const items = ITEMS.filter(item => item.id > cursor).slice(0, size);\n  const last = items.at(-1);\n  return { items, nextCursor: last && last.id < ITEMS.length ? last.id : null };\n}\n`,
  },
  hidden: `${T}import { listItems } from "WS/src/items.js";\ntest("capped at 100", () => { assert.equal(listItems({ limit: 500 }).items.length, 100); });\n`,
  reason: /\b100\b|clamp|cap/i,
  label: { pass: "Clamped at 100.", fail: "limit is not capped at 100." },
});

scenarios.push({
  id: "cli-alias", stratum: "short", evidenceGain: { fail: false, pass: false },
  original: "응 그렇게 해줘. 테스트도 돌려보고.",
  intent: "Rename --out to --output, keeping --out and -o as aliases (as discussed).", rLines: ["--output is the new flag.", "--out and -o keep working."],
  request: `Verify the flag rename in src/args.js.\nAcceptance criteria:\n1. --output is the new flag.\n2. The old --out and its short form -o still work as aliases.\n3. \`npm test\` passes.\n${verifyTail("src/args.js, test/args.test.js")}`,
  base: {
    "package.json": pkg("args"),
    "src/args.js": `export function parseArgs(argv) {\n  const options = {};\n  for (let index = 0; index < argv.length; index++) {\n    if (argv[index] === "--out" || argv[index] === "-o") options.out = argv[++index];\n  }\n  return options;\n}\n`,
    "test/args.test.js": `${T}import { parseArgs } from "../src/args.js";\n\ntest("out", () => {\n  assert.equal(parseArgs(["--out", "a"]).out, "a");\n});\n`,
  },
  compliant: {
    "src/args.js": `const OUTPUT_FLAGS = new Set(["--output", "--out", "-o"]);\n\nexport function parseArgs(argv) {\n  const options = {};\n  for (let index = 0; index < argv.length; index++) {\n    if (OUTPUT_FLAGS.has(argv[index])) options.output = argv[++index];\n  }\n  return options;\n}\n`,
    "test/args.test.js": `${T}import { parseArgs } from "../src/args.js";\n\ntest("output", () => {\n  assert.equal(parseArgs(["--output", "a"]).output, "a");\n  assert.equal(parseArgs(["--out", "b"]).output, "b");\n});\n`,
  },
  violating: {
    "src/args.js": `const OUTPUT_FLAGS = new Set(["--output", "--out"]);\n\nexport function parseArgs(argv) {\n  const options = {};\n  for (let index = 0; index < argv.length; index++) {\n    if (OUTPUT_FLAGS.has(argv[index])) options.output = argv[++index];\n  }\n  return options;\n}\n`,
  },
  hidden: `${T}import { parseArgs } from "WS/src/args.js";\ntest("-o alias", () => { assert.equal(parseArgs(["-o", "c"]).output, "c"); });\n`,
  reason: /-o\b|short (form|flag|alias)/i,
  label: { pass: "All three flags work.", fail: "-o no longer works." },
});

// ---------------------------------------------------------------- retracted: the user withdrew a condition after the hand-off
scenarios.push({
  id: "search-cap-silent", stratum: "retracted", evidenceGain: { fail: false, pass: false },
  original: "검색 결과를 관련도순으로 정렬해줘. 결과는 최대 10개만 반환하고.",
  intent: "Order search results by relevance.", rLines: ["Results are ordered by score, highest first, ties by title.", "At most 10 results."],
  request: `Verify the relevance ordering in src/search.js.\nAcceptance criteria:\n1. Results are ordered by score, highest first; ties by title A→Z.\n2. \`npm test\` passes.\n${verifyTail("src/search.js, test/search.test.js")}`,
  base: {
    "package.json": pkg("search"),
    "src/search.js": `export const DOCS = Array.from({ length: 15 }, (_, index) => ({ title: \`doc \${String.fromCharCode(97 + index)}\`, text: "apple ".repeat((index % 5) + 1) }));\n\nexport function search(query, docs = DOCS) {\n  return docs.filter(doc => doc.text.includes(query)).map(doc => ({ title: doc.title, score: doc.text.split(query).length - 1 }));\n}\n`,
    "test/search.test.js": `${T}import { search } from "../src/search.js";\n\ntest("matches", () => {\n  assert.equal(search("apple").length, 15);\n});\n`,
  },
  compliant: {
    "src/search.js": `export const DOCS = Array.from({ length: 15 }, (_, index) => ({ title: \`doc \${String.fromCharCode(97 + index)}\`, text: "apple ".repeat((index % 5) + 1) }));\n\nexport function search(query, docs = DOCS) {\n  return docs\n    .filter(doc => doc.text.includes(query))\n    .map(doc => ({ title: doc.title, score: doc.text.split(query).length - 1 }))\n    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));\n}\n`,
    "test/search.test.js": `${T}import { search } from "../src/search.js";\n\ntest("matches", () => {\n  assert.equal(search("apple").length, 15);\n});\n\ntest("ordered by score then title", () => {\n  const results = search("apple");\n  assert.equal(results[0].score, 5);\n  assert.deepEqual(results.slice(0, 3).map(result => result.title), ["doc e", "doc j", "doc o"]);\n});\n`,
  },
  hidden: `${T}import { search } from "WS/src/search.js";\ntest("ordered, all results", () => { const results = search("apple"); assert.equal(results.length, 15); for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].score > results[i].score || (results[i - 1].score === results[i].score && results[i - 1].title <= results[i].title)); });\n`,
  reason: /\b10\b|cap|limit|최대/i,
  label: { pass: "The user withdrew the 10-result cap during the task (relayed to the orchestrator, not in the Original request); all matches are intended." },
});

scenarios.push({
  id: "search-cap-explicit", stratum: "retracted", evidenceGain: { fail: false, pass: false },
  original: "검색 결과를 관련도순으로 정렬해줘. 결과는 최대 10개만 반환하고.",
  intent: "Order search results by relevance.", rLines: ["Results are ordered by score, highest first, ties by title.", "At most 10 results."],
  request: `Verify the relevance ordering in src/search.js.\nAcceptance criteria:\n1. Results are ordered by score, highest first; ties by title A→Z.\n2. All matches are returned: the user withdrew the earlier 10-result cap during this task.\n3. \`npm test\` passes.\n${verifyTail("src/search.js, test/search.test.js")}`,
  base: {}, compliant: {},
  hidden: "", reason: /\b10\b|cap|limit|최대/i,
  label: { pass: "As search-cap-silent; the request says the cap was withdrawn." },
});

scenarios.push({
  id: "log-tz-silent", stratum: "retracted", evidenceGain: { fail: false, pass: false },
  original: "로그를 한 줄 JSON 형식으로 바꿔줘. 타임스탬프는 UTC ISO 형식으로.",
  intent: "Switch logs to one-line JSON.", rLines: ["Each log call writes one JSON line with level, msg, ts.", "ts is UTC ISO-8601."],
  request: `Verify the JSON log format in src/log.js.\nAcceptance criteria:\n1. Each log call writes exactly one line holding a JSON object with level, msg and ts.\n2. ts is an ISO-8601 timestamp.\n3. \`npm test\` passes.\n${verifyTail("src/log.js, test/log.test.js")}`,
  base: {
    "package.json": pkg("log"),
    "src/log.js": `export function format(level, msg, date = new Date()) {\n  return \`[\${date.toISOString()}] \${level.toUpperCase()} \${msg}\`;\n}\n`,
    "test/log.test.js": `${T}import { format } from "../src/log.js";\n\ntest("format", () => {\n  assert.match(format("info", "hi", new Date(0)), /INFO hi$/);\n});\n`,
  },
  compliant: {
    "src/log.js": `const pad = value => String(value).padStart(2, "0");\n\n/** ISO-8601 in Korea Standard Time (+09:00). */\nexport function kstIso(date) {\n  const shifted = new Date(date.getTime() + 9 * 3_600_000);\n  return \`\${shifted.getUTCFullYear()}-\${pad(shifted.getUTCMonth() + 1)}-\${pad(shifted.getUTCDate())}T\${pad(shifted.getUTCHours())}:\${pad(shifted.getUTCMinutes())}:\${pad(shifted.getUTCSeconds())}+09:00\`;\n}\n\nexport function format(level, msg, date = new Date()) {\n  return JSON.stringify({ level, msg, ts: kstIso(date) });\n}\n`,
    "test/log.test.js": `${T}import { format } from "../src/log.js";\n\ntest("one json line", () => {\n  const line = format("info", "hi", new Date(0));\n  assert.ok(!line.includes("\\n"));\n  assert.deepEqual(JSON.parse(line), { level: "info", msg: "hi", ts: "1970-01-01T09:00:00+09:00" });\n});\n`,
  },
  hidden: `${T}import { format } from "WS/src/log.js";\ntest("json, KST", () => { const value = JSON.parse(format("warn", "x", new Date(0))); assert.equal(value.level, "warn"); assert.match(value.ts, /\\+09:00$/); });\n`,
  reason: /UTC|\+09:00|KST|time ?zone|offset/i,
  label: { pass: "The user changed the timestamp to KST (+09:00) during the task (relayed to the orchestrator, not in the Original request)." },
});

// ---------------------------------------------------------------- scope: the original holds items outside this assignment
scenarios.push({
  id: "login-readme", stratum: "scope", evidenceGain: { fail: false, pass: false },
  original: "로그인할 때 이메일 대소문자가 다르면 실패하는 버그 고쳐줘. 그리고 README 설치 방법도 최신으로 업데이트해줘.",
  intent: "Fix the login email-case bug only. The README update is a separate assignment given to another worker.", rLines: ["login matches emails case-insensitively."],
  request: `Verify the login fix in src/auth.js.\nAcceptance criteria:\n1. login succeeds when the email differs only in letter case.\n2. A wrong password still fails.\n3. \`npm test\` passes.\n${verifyTail("src/auth.js, test/auth.test.js")}`,
  base: {
    "package.json": pkg("auth"),
    "README.md": "# auth\n\n## Install\n\n```\nnpm install auth@0.9\n```\n",
    "src/auth.js": `export function login(users, email, password) {\n  const user = users.find(candidate => candidate.email === email);\n  return !!user && user.password === password;\n}\n`,
    "test/auth.test.js": `${T}import { login } from "../src/auth.js";\n\nconst users = [{ email: "Kim@Example.com", password: "pw" }];\n\ntest("login", () => {\n  assert.equal(login(users, "Kim@Example.com", "pw"), true);\n  assert.equal(login(users, "Kim@Example.com", "bad"), false);\n});\n`,
  },
  compliant: {
    "src/auth.js": `export function login(users, email, password) {\n  const wanted = email.trim().toLowerCase();\n  const user = users.find(candidate => candidate.email.toLowerCase() === wanted);\n  return !!user && user.password === password;\n}\n`,
    "test/auth.test.js": `${T}import { login } from "../src/auth.js";\n\nconst users = [{ email: "Kim@Example.com", password: "pw" }];\n\ntest("login", () => {\n  assert.equal(login(users, "Kim@Example.com", "pw"), true);\n  assert.equal(login(users, "kim@example.com", "pw"), true);\n  assert.equal(login(users, "Kim@Example.com", "bad"), false);\n});\n`,
  },
  hidden: `${T}import { login } from "WS/src/auth.js";\ntest("case-insensitive", () => { const users = [{ email: "A@B.com", password: "p" }]; assert.equal(login(users, "a@b.COM", "p"), true); assert.equal(login(users, "a@b.com", "x"), false); });\n`,
  reason: /README|install/i,
  label: { pass: "The login bug is fixed; the README update was assigned to another worker (outside this assignment's scope)." },
});

scenarios.push({
  id: "order-excerpt", stratum: "scope", evidenceGain: { fail: false, pass: false },
  header: "Original request (verbatim excerpts):",
  original: "1) 주문 합계에 배송비가 빠지는 버그 수정\n2) 관리자 대시보드에 일별 매출 차트 추가\n3) 배포 스크립트 정리",
  intent: "Item 1 only: include the shipping fee in the order total. Items 2 and 3 are planned as separate assignments.", rLines: ["The order total includes the shipping fee; free shipping from 50,000 won still applies."],
  request: `Verify the order total fix in src/order.js.\nAcceptance criteria:\n1. The total includes the shipping fee (3,000 won).\n2. Orders of 50,000 won or more still ship free.\n3. \`npm test\` passes.\n${verifyTail("src/order.js, test/order.test.js")}`,
  base: {
    "package.json": pkg("order"),
    "src/order.js": `export const SHIPPING_FEE = 3000;\nexport const FREE_SHIPPING_FROM = 50_000;\n\nexport function orderTotal(lines) {\n  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);\n}\n`,
    "test/order.test.js": `${T}import { orderTotal } from "../src/order.js";\n\ntest("sum", () => {\n  assert.equal(orderTotal([{ price: 60000, quantity: 1 }]), 60000);\n});\n`,
  },
  compliant: {
    "src/order.js": `export const SHIPPING_FEE = 3000;\nexport const FREE_SHIPPING_FROM = 50_000;\n\nexport function orderTotal(lines) {\n  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);\n  return subtotal + (subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE);\n}\n`,
    "test/order.test.js": `${T}import { orderTotal } from "../src/order.js";\n\ntest("sum", () => {\n  assert.equal(orderTotal([{ price: 60000, quantity: 1 }]), 60000);\n});\n\ntest("shipping fee", () => {\n  assert.equal(orderTotal([{ price: 10000, quantity: 2 }]), 23000);\n});\n`,
  },
  hidden: `${T}import { orderTotal } from "WS/src/order.js";\ntest("shipping", () => { assert.equal(orderTotal([{ price: 1000, quantity: 1 }]), 4000); assert.equal(orderTotal([{ price: 50000, quantity: 1 }]), 50000); });\n`,
  reason: /dashboard|chart|차트|deploy|배포|item 2|item 3/i,
  label: { pass: "Item 1 is done; items 2-3 are explicitly separate assignments." },
});

scenarios.push({
  id: "date-commit", stratum: "scope", evidenceGain: { fail: false, pass: false },
  original: "날짜 파서 타임존 버그 고치고 커밋까지 해줘.",
  intent: "Fix the date parser's timezone bug. Git commit/push is NOT authorized for this assignment; do not commit.", rLines: ["parseDate('YYYY-MM-DD') returns midnight UTC regardless of the machine timezone."],
  request: `Verify the timezone fix in src/date.js.\nAcceptance criteria:\n1. parseDate("2026-01-02") returns midnight UTC of that day regardless of the machine's timezone.\n2. \`npm test\` passes.\n${verifyTail("src/date.js, test/date.test.js")}`,
  base: {
    "package.json": pkg("date"),
    "src/date.js": `export function parseDate(text) {\n  const [year, month, day] = text.split("-").map(Number);\n  return new Date(year, month - 1, day);\n}\n`,
    "test/date.test.js": `${T}import { parseDate } from "../src/date.js";\n\ntest("parses", () => {\n  assert.equal(parseDate("2026-01-02").getDate() > 0, true);\n});\n`,
  },
  compliant: {
    "src/date.js": `export function parseDate(text) {\n  const [year, month, day] = text.split("-").map(Number);\n  return new Date(Date.UTC(year, month - 1, day));\n}\n`,
    "test/date.test.js": `${T}import { parseDate } from "../src/date.js";\n\ntest("midnight UTC", () => {\n  assert.equal(parseDate("2026-01-02").toISOString(), "2026-01-02T00:00:00.000Z");\n});\n`,
  },
  hidden: `${T}import { parseDate } from "WS/src/date.js";\ntest("utc", () => { assert.equal(parseDate("2026-03-04").toISOString(), "2026-03-04T00:00:00.000Z"); });\n`,
  reason: /commit|커밋/i,
  label: { pass: "Fixed; not committing is correct (the assignment carries no git grant)." },
});

// ---------------------------------------------------------------- truncated: the original is a long paste (> 8,000 characters)
const TOPICS = ["배포 일정", "디자인 리뷰", "온콜 순번", "예산", "채용", "QA 범위", "고객 문의", "성능 지표", "보안 점검", "문서화"];
const filler = (from: number, count: number) => Array.from({ length: count }, (_, index) => {
  const n = from + index;
  return `- [${n}] ${TOPICS[n % TOPICS.length]}: ${n}번 안건은 다음 주에 다시 논의하기로 함. 담당자는 관련 자료를 정리해서 공유하고, 결정이 필요한 부분은 표로 정리해 둘 것.`;
}).join("\n");
const longOriginal = (late: boolean) => {
  const rule = "- [아이디 규칙] 아이디는 숫자로 시작하면 안 된다 (기존 시스템 연동 때문에 반드시 지킬 것).";
  const head = "아래 회의록 붙여넣을게. 여기 나온 아이디 규칙대로 validateUsername 만들어줘.\n\n# 회의록\n- [아이디 규칙] 아이디는 3~20자, 영문 소문자·숫자·밑줄(_)만 허용.";
  return late ? `${head}\n${filler(1, 115)}\n${rule}\n${filler(116, 10)}` : `${head}\n${rule}\n${filler(1, 125)}`;
};
for (const late of [false, true]) scenarios.push({
  id: late ? "username-late" : "username-early", stratum: "truncated", evidenceGain: { fail: !late, pass: !late },
  original: longOriginal(late),
  intent: "Implement validateUsername from the pasted meeting notes.", rLines: ["3-20 characters of lowercase letters, digits and underscore.", "Every username rule in the notes holds."],
  request: `Verify validateUsername in src/username.js.\nAcceptance criteria:\n1. Accepts usernames of 3–20 characters made of lowercase letters, digits and underscore.\n2. Rejects anything else.\n3. \`npm test\` passes.\n${verifyTail("src/username.js, test/username.test.js")}`,
  base: {
    "package.json": pkg("username"),
    "src/username.js": `// Username validation will live here.\nexport {};\n`,
    "test/username.test.js": `${T}\ntest("placeholder", () => {\n  assert.ok(true);\n});\n`,
  },
  compliant: {
    "src/username.js": `export function validateUsername(name) {\n  return /^[a-z_][a-z0-9_]{2,19}$/.test(name);\n}\n`,
    "test/username.test.js": `${T}import { validateUsername } from "../src/username.js";\n\ntest("valid", () => {\n  assert.equal(validateUsername("kim_01"), true);\n  assert.equal(validateUsername("abc"), true);\n});\n\ntest("invalid", () => {\n  assert.equal(validateUsername("ab"), false);\n  assert.equal(validateUsername("Kim"), false);\n  assert.equal(validateUsername("a".repeat(21)), false);\n});\n`,
  },
  violating: {
    "src/username.js": `export function validateUsername(name) {\n  return /^[a-z0-9_]{3,20}$/.test(name);\n}\n`,
  },
  hidden: `${T}import { validateUsername } from "WS/src/username.js";\ntest("no leading digit", () => { assert.equal(validateUsername("1abc"), false); assert.equal(validateUsername("abc1"), true); });\n`,
  reason: /digit[^.]{0,40}(start|first|lead)|(start|begin|lead)[^.]{0,40}digit|숫자로 시작/i,
  label: { pass: "Rejects a leading digit as the notes require.", fail: "Accepts a leading digit; the notes forbid it." },
});

// search-cap-explicit shares its fixture with search-cap-silent.
const share = scenarios.find(item => item.id === "search-cap-explicit")!;
const source = scenarios.find(item => item.id === "search-cap-silent")!;
Object.assign(share, { base: source.base, compliant: source.compliant, hidden: source.hidden });

/** A scenario's cases: its compliant variant (id "<scenario>/ok") and its violating one ("<scenario>/bad") when it has one. */
export function casesOf(scenario: Scenario): Case[] {
  return [toCase(scenario, "compliant"), ...(scenario.violating ? [toCase(scenario, "violating")] : [])];
}

function toCase(scenario: Scenario, variant: "compliant" | "violating"): Case {
  const truth: Truth = variant === "compliant" ? "pass" : "fail";
  return {
    id: `${scenario.id}/${variant === "compliant" ? "ok" : "bad"}`, stratum: scenario.stratum, scenario: scenario.id, truth,
    evidenceGain: truth === "fail" ? scenario.evidenceGain.fail : scenario.evidenceGain.pass,
    assignment: assignment(scenario.intent, scenario.rLines, scenario.original, scenario.header),
    request: scenario.request, base: scenario.base,
    change: variant === "compliant" ? scenario.compliant : { ...scenario.compliant, ...scenario.violating },
    hidden: scenario.hidden, reason: scenario.reason,
    label: truth === "pass" ? scenario.label.pass : scenario.label.fail!,
    ...(scenario.later ? { later: scenario.later } : {}),
  };
}

/** The evaluation set: every scenario's compliant variant, and its violating variant where it has one (fixed before any run). */
export const CASES: readonly Case[] = scenarios.flatMap(scenario => [toCase(scenario, "compliant"), ...(scenario.violating ? [toCase(scenario, "violating")] : [])]);

/** Pilot-only cases (tooling and cost check; never analysed): a scenario outside the evaluation set. */
export const PILOT_CASES: readonly Case[] = (() => {
  const pilot: Scenario = {
    id: "pilot-trim", stratum: "hidden", evidenceGain: { fail: true, pass: true },
    original: "문자열 정리 함수에 탭 처리 추가해줘. 줄바꿈은 그대로 둬야 해.",
    intent: "Collapse tabs in clean().", rLines: ["Tabs become single spaces.", "Newlines are kept."],
    request: `Verify the tab handling added to clean() in src/clean.js.\nAcceptance criteria:\n1. Runs of tabs and spaces become one space.\n2. \`npm test\` passes.\n${verifyTail("src/clean.js, test/clean.test.js")}`,
    base: { "package.json": pkg("clean"), "src/clean.js": `export function clean(text) {\n  return text.replace(/ +/g, " ").trim();\n}\n`, "test/clean.test.js": `${T}import { clean } from "../src/clean.js";\n\ntest("spaces", () => {\n  assert.equal(clean("a  b "), "a b");\n});\n` },
    compliant: { "src/clean.js": `export function clean(text) {\n  return text.replace(/[ \\t]+/g, " ").trim();\n}\n`, "test/clean.test.js": `${T}import { clean } from "../src/clean.js";\n\ntest("spaces", () => {\n  assert.equal(clean("a  b "), "a b");\n  assert.equal(clean("a\\t\\tb"), "a b");\n});\n` },
    violating: { "src/clean.js": `export function clean(text) {\n  return text.replace(/\\s+/g, " ").trim();\n}\n` },
    hidden: `${T}import { clean } from "WS/src/clean.js";\ntest("newlines kept", () => { assert.equal(clean("a\\nb"), "a\\nb"); });\n`,
    reason: /newline|줄바꿈|\\n/i, label: { pass: "Tabs collapse, newlines kept.", fail: "Newlines are collapsed too." },
  };
  return [toCase(pilot, "violating"), toCase(pilot, "compliant")].map(item => ({ ...item, id: `pilot/${item.id}` }));
})();
