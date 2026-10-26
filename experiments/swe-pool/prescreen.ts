/**
 * Round-2 SWE task pool P2 (results/cb-ab/PROTOCOL-R2.md "Pool P2"): the deterministic, model-free prescreen.
 *
 *   npx tsx experiments/swe-pool/prescreen.ts        -> results/swe-pool/r2/prescreen.json (refuses to overwrite)
 *
 * - Source: the SWE-rebench 2026 records of results/iso-token/raw/rebench-2026_0{1,2,3}.jsonl that are not set up in
 *   fixtures/advisor-bench/swe (set up = a directory named id or id + "_interface" exists there).
 * - Order: the ids sorted, then ordered by sha256("cb-ab-r2-2026-10-24:" + id) hex, ascending. `order` is 1-based.
 * - D1: FAIL_TO_PASS is non-empty and the problem statement is non-empty (after trim).
 * - D2: the record's `patch` (the reference fix) changes at least two hunks in non-test Python source (`isNonTestPython`).
 * - Also recorded: multiFile (at least two such files changed) and interface (the record's interface text is non-empty after trim).
 * Every record's decision is recorded with its reason. No model is involved and nothing is judged beyond these rules.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
/** The record files, relative to the repository (as setup-swe.ts names them in task.json `source.file`). */
export const SOURCE_FILES = ["results/iso-token/raw/rebench-2026_01.jsonl", "results/iso-token/raw/rebench-2026_02.jsonl", "results/iso-token/raw/rebench-2026_03.jsonl"] as const;
export const OLD_FIXTURES = "fixtures/advisor-bench/swe";
export const PRESCREEN_OUT = "results/swe-pool/r2/prescreen.json";
/** Pool order seed (PROTOCOL-R2.md "Pool P2"). */
export const POOL_SEED = "cb-ab-r2-2026-10-24:";
/** Stage-3 calibration pool seed (results/ultra-ho/stage3-r2/PREREGISTRATION.md "Calibration"). */
export const STAGE3_SEED = "ultra-ho-r2-2026-10-24:";
export const EXPECTED_POOL = 172;

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** The ids sorted, then ordered by sha256(seed + id) hex ascending (a stable sort, so equal hashes would keep the id order). */
export function seededOrder(ids: readonly string[], seed: string): string[] {
  const keyed = [...ids].sort().map(id => ({ id, key: sha256Hex(seed + id) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map(item => item.id);
}

/** Already set up in the old pool: a fixture directory named id or id + "_interface" exists. */
export function setUpAs(id: string, fixtureDirs: ReadonlySet<string>): string | undefined {
  if (fixtureDirs.has(id)) return id;
  if (fixtureDirs.has(`${id}_interface`)) return `${id}_interface`;
  return undefined;
}

const NON_SOURCE_DIRS = new Set(["test", "tests", "testing", "docs", "doc", "examples"]);

/**
 * Non-test Python source: a `.py` file none of whose path segments is test, tests, testing, docs, doc or examples and whose basename
 * is not test_*.py, *_test.py or conftest.py. Segments compare exactly (case-sensitive), as the protocol names them.
 */
export function isNonTestPython(path: string): boolean {
  if (!path.endsWith(".py")) return false;
  const segments = path.split("/");
  if (segments.some(segment => NON_SOURCE_DIRS.has(segment))) return false;
  const base = segments[segments.length - 1]!;
  return !(base.startsWith("test_") || base.endsWith("_test.py") || base === "conftest.py");
}

export interface DiffFile {
  /** Path before the patch; null for an added file. */
  oldPath: string | null;
  /** Path after the patch; null for a deleted file. */
  newPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed" | "copied";
  hunks: number;
}

/** Git's C-style quoted path ("a/x\tb.py", octal escapes for non-ASCII bytes) to the plain path; unquoted text is returned as is. */
export function unquotePath(text: string): string {
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text;
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== "\\") { bytes.push(...Buffer.from(char, "utf8")); continue; }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    if (next in named) { bytes.push(named[next]!); i += 1; continue; }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString("utf8");
}

const stripSide = (path: string): string => (/^[ab]\//.test(path) ? path.slice(2) : path);

/** A path of a `---` / `+++` line: null for /dev/null; quotes, a trailing tab-separated timestamp and the a/ or b/ prefix removed. */
function headerPath(text: string): string | null {
  const raw = text.startsWith('"') ? text : text.split("\t")[0]!;
  const path = unquotePath(raw.trimEnd());
  return path === "/dev/null" ? null : stripSide(path);
}

/** Old and new path of a `diff --git a/X b/Y` line (exact for equal paths and for quoted paths; renames get theirs from `rename` lines). */
function gitHeaderPaths(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const end = /^"(?:[^"\\]|\\.)*"/.exec(rest);
    if (!end) return undefined;
    const second = rest.slice(end[0].length + 1);
    return [stripSide(unquotePath(end[0])), stripSide(second.startsWith('"') ? unquotePath(second) : second)];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3) && rest.startsWith("a/") && rest.slice(half + 1).startsWith("b/")) {
    return [rest.slice(2, half), rest.slice(half + 3)];
  }
  const split = rest.indexOf(" b/");
  if (split < 0) return undefined;
  const second = rest.slice(split + 1);
  return [stripSide(rest.slice(0, split)), stripSide(second.startsWith('"') ? unquotePath(second) : second)];
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * The files of a unified diff (git format, or plain `---`/`+++` sections) with their hunk counts. Hunk bodies are consumed by their
 * line counts, so a body line that looks like a header (e.g. a removed "-- comment" shown as "--- comment") is never one. New and
 * deleted files have their usual single hunk; a pure rename, mode change or binary change has an entry with zero hunks.
 */
export function parseDiff(patch: string): DiffFile[] {
  const lines = patch.split("\n");
  type Entry = DiffFile & { header: boolean };
  const files: Entry[] = [];
  let current: Entry | undefined;
  const start = (): Entry => {
    const file: Entry = { oldPath: null, newPath: null, status: "modified", hunks: 0, header: false };
    files.push(file);
    return file;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      current = start();
      const paths = gitHeaderPaths(line.slice("diff --git ".length));
      if (paths) [current.oldPath, current.newPath] = paths;
      continue;
    }
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      if (!current || current.header || current.hunks > 0) current = start();
      current.header = true;
      current.oldPath = headerPath(line.slice(4));
      current.newPath = headerPath(lines[i + 1]!.slice(4));
      if (current.oldPath === null) current.status = "added";
      else if (current.newPath === null) current.status = "deleted";
      i++;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode ")) { current.status = "added"; current.oldPath = null; continue; }
    if (line.startsWith("deleted file mode ")) { current.status = "deleted"; current.newPath = null; continue; }
    if (line.startsWith("rename from ")) { current.status = "renamed"; current.oldPath = unquotePath(line.slice("rename from ".length)); continue; }
    if (line.startsWith("rename to ")) { current.status = "renamed"; current.newPath = unquotePath(line.slice("rename to ".length)); continue; }
    if (line.startsWith("copy from ")) { current.status = "copied"; current.oldPath = unquotePath(line.slice("copy from ".length)); continue; }
    if (line.startsWith("copy to ")) { current.status = "copied"; current.newPath = unquotePath(line.slice("copy to ".length)); continue; }
    const hunk = HUNK.exec(line);
    if (!hunk) continue;
    current.hunks++;
    let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
    let newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
      const body = lines[i + 1]!;
      // A body line always starts with ' ', '+', '-' or '\'; a header here means a truncated hunk: stop and read it as a header.
      if (body.startsWith("diff --git ") || body.startsWith("@@ ")) break;
      i++;
      if (body.startsWith("\\")) continue;
      if (body.startsWith("+")) newLeft--;
      else if (body.startsWith("-")) oldLeft--;
      else { oldLeft--; newLeft--; }
    }
  }
  return files.map(({ header: _header, ...file }) => file);
}

/** The path a diff entry is classified by: its path after the patch, or before it for a deleted file. */
export const diffPath = (file: DiffFile): string => file.newPath ?? file.oldPath ?? "";

/** Non-test Python source files the patch changes (any diff entry counts as a change) and the hunks in them. */
export function nonTestPython(patch: string): { files: string[]; hunks: number } {
  const hunks = new Map<string, number>();
  for (const file of parseDiff(patch)) {
    const path = diffPath(file);
    if (isNonTestPython(path)) hunks.set(path, (hunks.get(path) ?? 0) + file.hunks);
  }
  return { files: [...hunks.keys()], hunks: [...hunks.values()].reduce((sum, count) => sum + count, 0) };
}

export interface RawRecord {
  id: string;
  /** The parsed dataset record. */
  record: any;
  /** Repository-relative record file. */
  recordFile: string;
  /** sha256 of the record's JSONL line, as setup-swe.ts computes it. */
  recordSha256: string;
}

/** Every record of the given JSONL files (repository-relative), with the line hash exactly as setup-swe.ts `record()` takes it. */
export function readRecords(repo: string, files: readonly string[] = SOURCE_FILES): RawRecord[] {
  const out: RawRecord[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(repo, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      out.push({ id: String(record.instance_id), record, recordFile: file, recordSha256: sha256Hex(line) });
    }
  }
  return out;
}

export interface Screen {
  d1: boolean;
  d2: boolean;
  multiFile: boolean;
  interface: boolean;
  nonTestPyFiles: string[];
  nonTestPyHunks: number;
  reason: string;
}

const nonEmptyText = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

/** D1, D2, multiFile and interface of one dataset record, with the reason of the decision. */
export function screenRecord(record: any): Screen {
  const f2p = Array.isArray(record.FAIL_TO_PASS) && record.FAIL_TO_PASS.length > 0;
  const statement = nonEmptyText(record.problem_statement);
  const { files, hunks } = nonTestPython(typeof record.patch === "string" ? record.patch : "");
  const d1 = f2p && statement, d2 = hunks >= 2;
  const where = `${hunks} hunk(s) in ${files.length} non-test Python file(s)`;
  const failed = [...(f2p ? [] : ["D1: FAIL_TO_PASS is empty"]), ...(statement ? [] : ["D1: the problem statement is empty"]), ...(d2 ? [] : [`D2: ${where} (< 2 hunks)`])];
  return { d1, d2, multiFile: files.length >= 2, interface: nonEmptyText(record.interface), nonTestPyFiles: files, nonTestPyHunks: hunks, reason: failed.length ? failed.join("; ") : `D1 and D2 pass: ${where}` };
}

export interface PrescreenEntry extends Screen {
  id: string;
  order: number;
  recordFile: string;
  recordSha256: string;
}

/** The prescreen of every record not set up in the old pool, in pool order. */
export function prescreen(records: readonly RawRecord[], fixtureDirs: ReadonlySet<string>): { excluded: { id: string; fixture: string }[]; entries: PrescreenEntry[] } {
  const ids = new Set<string>();
  for (const item of records) {
    if (ids.has(item.id)) throw new Error(`duplicate record id ${item.id}`);
    ids.add(item.id);
  }
  const excluded = records.flatMap(item => { const fixture = setUpAs(item.id, fixtureDirs); return fixture ? [{ id: item.id, fixture }] : []; }).sort((a, b) => (a.id < b.id ? -1 : 1));
  const skip = new Set(excluded.map(item => item.id));
  const byId = new Map(records.map(item => [item.id, item]));
  const entries = seededOrder(records.filter(item => !skip.has(item.id)).map(item => item.id), POOL_SEED).map((id, index) => {
    const item = byId.get(id)!;
    const { d1, d2, multiFile, interface: hasInterface, nonTestPyFiles, nonTestPyHunks, reason } = screenRecord(item.record);
    return { id, order: index + 1, recordFile: item.recordFile, recordSha256: item.recordSha256, d1, d2, multiFile, interface: hasInterface, nonTestPyFiles, nonTestPyHunks, reason };
  });
  return { excluded, entries };
}

/** The fixture directory names of the old pool. */
export function fixtureDirsOf(dir: string): Set<string> {
  return new Set(readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name));
}

export const RULES = {
  source: `SWE-rebench 2026 records in ${SOURCE_FILES.join(", ")} not set up in ${OLD_FIXTURES} (a directory named id or id + "_interface" exists)`,
  order: `ids sorted, then sha256("${POOL_SEED}" + id) hex ascending; order is 1-based`,
  d1: "FAIL_TO_PASS is non-empty and the problem statement is non-empty (after trim)",
  d2: "the reference patch (`patch`) changes at least two hunks in non-test Python source",
  nonTest: "a .py file none of whose path segments is test, tests, testing, docs, doc or examples (exact, case-sensitive) and whose basename is not test_*.py, *_test.py or conftest.py; a diff entry is classified by its post-patch path (pre-patch for a deleted file) and every entry counts as a changed file",
  multiFile: "at least two non-test Python source files changed",
  interface: "the record's interface text is non-empty after trim",
} as const;

function main(): number {
  const out = join(REPO, PRESCREEN_OUT);
  const records = readRecords(REPO);
  const { excluded, entries } = prescreen(records, fixtureDirsOf(join(REPO, OLD_FIXTURES)));
  const d1d2 = entries.filter(entry => entry.d1 && entry.d2);
  const counts = {
    records: records.length, excluded: excluded.length, pool: entries.length, expectedPool: EXPECTED_POOL,
    d1: entries.filter(entry => entry.d1).length, d2: entries.filter(entry => entry.d2).length, d1d2: d1d2.length,
    multiFile: entries.filter(entry => entry.multiFile).length, interface: entries.filter(entry => entry.interface).length,
    d1d2MultiFile: d1d2.filter(entry => entry.multiFile).length, d1d2Interface: d1d2.filter(entry => entry.interface).length,
  };
  const document = {
    createdAt: new Date().toISOString(), protocol: 'results/cb-ab/PROTOCOL-R2.md "Pool P2"', seed: POOL_SEED, rules: RULES,
    sources: SOURCE_FILES.map(file => ({ file, sha256: sha256Hex(readFileSync(join(REPO, file))), records: records.filter(item => item.recordFile === file).length })),
    fixturesDir: OLD_FIXTURES, counts, excluded, entries,
  };
  mkdirSync(dirname(out), { recursive: true });
  try {
    writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") { console.error(`${PRESCREEN_OUT} exists; refusing to overwrite`); return 1; }
    throw error;
  }
  if (entries.length !== EXPECTED_POOL) console.error(`WARNING: ${entries.length} records after exclusion, ${EXPECTED_POOL} expected`);
  console.log(JSON.stringify({ out: PRESCREEN_OUT, ...counts }));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main());
