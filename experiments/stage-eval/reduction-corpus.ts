/**
 * Real-output corpus for the bash output reducers (change #6), rebuilt from transcripts without any model call: a reduced bash
 * result whose saved full output the same session then read IN FULL with `read` (no offset/limit, or the read reports the whole
 * file) gives the exact original text (the read's anchored lines without their `N#TAG|` prefixes) next to the command and the
 * reduced text the agent saw. Each case is replayed through a given filterOutput (old runtime vs working tree) to compare what the
 * agent would see.
 *
 *   npx tsx experiments/stage-eval/reduction-corpus.ts build <out.json> <transcript.jsonl|records dir> ...
 *   npx tsx experiments/stage-eval/reduction-corpus.ts replay <corpus.json> <old output-filter.ts> <new output-filter.ts> <out.json>
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CorpusCase { source: string; command: string; reason: string; original: string; seen: string; reread: boolean }
const RUNNER = /\b(?:vitest|jest|mocha|pytest|tox|nox)\b|\bnode\b[^\n]{0,500}--test\b|\b(?:go|cargo|bun|deno)\s{1,40}test\b|\bnpm\s+(?:run\s+)?test\b|\blune\s+run\s+tests\b/;

const NOTICE = /\[Output filtered: ([^.(\]]+)[^\]]*Full output saved to (\.orche\/artifacts\/[^\s;\]]+?)(?:;|\s)/;

/** The text of a `read` result (anchored or plain numbered lines) without line prefixes; undefined when it is not a full read. */
export function unanchor(text: string): string | undefined {
  const lines = text.split("\n");
  if (/\[Showing lines \d+-\d+ of \d+/.test(text) || /Use offset=\d+ to continue/.test(text)) return undefined;
  const out: string[] = [];
  for (const line of lines) {
    const match = /^(\d+)(?:#[0-9a-f]{4,16})?\|(.*)$/.exec(line);
    if (match) { out.push(match[2]!); continue; }
    if (!line.trim()) continue;
    return undefined;
  }
  return out.length ? out.join("\n") : undefined;
}

export async function casesOf(file: string, mode: "reread" | "artifacts" = "reread"): Promise<CorpusCase[]> {
  const calls = new Map<string, { name: string; args: any }>();
  const reduced = new Map<string, { command: string; reason: string; seen: string; item?: CorpusCase }>();
  const cases: CorpusCase[] = [];
  let cwd = "";
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!cwd && line.includes('"type":"session"')) { try { cwd = JSON.parse(line).cwd ?? ""; } catch { /* not a header */ } }
    if (!line.includes('"type":"message"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall") continue;
        calls.set(part.id, { name: part.name, args: part.arguments });
        if (mode === "artifacts") { const text = JSON.stringify(part.arguments ?? {}); for (const [path, item] of reduced) if (item.item && text.includes(path)) item.item.reread = true; }
      }
    } else if (message?.role === "toolResult" && Array.isArray(message.content)) {
      const text = message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
      const call = calls.get(message.toolCallId);
      const match = NOTICE.exec(text);
      if (match && call?.name === "bash") {
        const record: { command: string; reason: string; seen: string; item?: CorpusCase } = { command: String(call.args?.command ?? ""), reason: match[1]!.trim(), seen: text };
        if (mode === "artifacts" && cwd && record.reason.startsWith("passing tests")) {
          // The saved original, when the project still keeps it (artifacts are relative to the session cwd).
          const path = join(cwd, match[2]!);
          if (existsSync(path) && statSync(path).size < 2_000_000) {
            record.item = { source: file, command: record.command, reason: record.reason, original: readFileSync(path, "utf8"), seen: text, reread: false };
            cases.push(record.item);
          }
        }
        reduced.set(match[2]!, record);
        continue;
      }
      if (mode === "reread" && call?.name === "read" && typeof call.args?.path === "string" && call.args.offset === undefined && call.args.limit === undefined) {
        const key = [...reduced.keys()].find(path => call.args.path.endsWith(path));
        if (!key) continue;
        const original = unanchor(text);
        if (original === undefined) continue;
        const item = reduced.get(key)!;
        cases.push({ source: file, command: item.command, reason: item.reason, original, seen: item.seen, reread: true });
        reduced.delete(key);
      }
    }
  }
  return cases;
}

function transcripts(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 6) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes(".advisor") && statSync(full).size > 5_000) out.push(full);
    }
  };
  walk(path, 0);
  return out.sort();
}

export interface ReplayRow { source: string; command: string; reason: string; reread: boolean; runner: boolean; originalLines: number; originalChars: number; old: Shown; next: Shown }
export interface Shown { reduced: boolean; reason?: string; lines: number; chars: number; keptNonProgress: number; nonProgress: number; diagnosticsKept: number; diagnostics: number }

const DIAG = /error|fail|exception|panic|traceback|[✗×✖]/i;
/** Lines a test runner prints for passing tests / progress (what a reducer may drop without losing information). */
const PROGRESS = /^\s*(?:[✓√✔]\s|ok \d+ - |PASSED\s|PASS\s|\.+\s*(?:\[\s*\d+%\])?$|\S+::\S+\s+PASSED\b|test \S+ \.\.\. ok$|--- PASS:|\s*(?:---|\.\.\.|duration_ms:|type: 'test'))/;

export function shown(original: string, reduction: { text: string; reason: string } | undefined): Shown {
  const lines = original.split("\n");
  const visible = new Set((reduction?.text ?? original).split("\n"));
  const nonProgress = lines.filter(line => line.trim() && !PROGRESS.test(line));
  const diagnostics = lines.filter(line => DIAG.test(line));
  return {
    reduced: !!reduction, ...(reduction ? { reason: reduction.reason } : {}), lines: (reduction?.text ?? original).split("\n").length, chars: (reduction?.text ?? original).length,
    keptNonProgress: nonProgress.filter(line => visible.has(line) || [...visible].some(v => v.includes(line.slice(0, 200)))).length, nonProgress: nonProgress.length,
    diagnosticsKept: diagnostics.filter(line => visible.has(line) || [...visible].some(v => v.includes(line.slice(0, 200)))).length, diagnostics: diagnostics.length,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build" || command === "build-artifacts") {
    const out = args.shift()!;
    const cases: CorpusCase[] = [];
    for (const path of args) for (const file of transcripts(path)) cases.push(...await casesOf(file, command === "build" ? "reread" : "artifacts").catch(() => []));
    await writeFile(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: command, sources: args, cases }, null, 2)}\n`);
    console.log(`${cases.length} cases`);
  } else if (command === "replay") {
    const [corpusFile, oldFilter, newFilter, out] = args as [string, string, string, string];
    const corpus: { cases: CorpusCase[] } = JSON.parse(readFileSync(corpusFile, "utf8"));
    const oldModule = await import(pathToFileURL(oldFilter).href);
    const newModule = await import(pathToFileURL(newFilter).href);
    const rows: ReplayRow[] = corpus.cases.map(item => ({
      source: item.source, command: item.command.slice(0, 300), reason: item.reason, reread: item.reread, runner: RUNNER.test(item.command),
      originalLines: item.original.split("\n").length, originalChars: item.original.length,
      old: shown(item.original, oldModule.filterOutput("bash", item.original, { command: item.command }) ?? oldModule.genericPreview(item.original, true)),
      next: shown(item.original, newModule.filterOutput("bash", item.original, { command: item.command }) ?? newModule.genericPreview(item.original, true)),
    }));
    const sum = (list: ReplayRow[], pick: (row: ReplayRow) => number) => list.reduce((total, row) => total + pick(row), 0);
    const side = (list: ReplayRow[], key: "old" | "next") => ({
      reduced: list.filter(r => r[key].reduced).length,
      nonProgressKept: `${sum(list, r => r[key].keptNonProgress)}/${sum(list, r => r[key].nonProgress)}`,
      casesLosingNonProgress: list.filter(r => r[key].keptNonProgress < r[key].nonProgress).length,
      diagnosticsKept: `${sum(list, r => r[key].diagnosticsKept)}/${sum(list, r => r[key].diagnostics)}`,
      chars: sum(list, r => r[key].chars), maxChars: Math.max(0, ...list.map(r => r[key].chars)),
    });
    const groups: Record<string, unknown> = {};
    for (const [name, list] of Object.entries({
      all: rows, reread: rows.filter(r => r.reread), notReread: rows.filter(r => !r.reread),
      testRunnerCommand: rows.filter(r => r.runner), otherCommand: rows.filter(r => !r.runner),
    })) groups[name] = { cases: list.length, originalChars: sum(list, r => r.originalChars), old: side(list, "old"), next: side(list, "next") };
    // Inferred (not measured): a reread case cost the reduced text plus the full original; with the new filter the reread is
    // assumed unnecessary when the new view drops no non-progress line.
    const rereads = rows.filter(r => r.reread);
    const inferred = {
      rereadCases: rereads.length,
      oldShownPlusReread: sum(rereads, r => r.old.chars + r.originalChars),
      nextShownPlusRemainingReread: sum(rereads, r => r.next.chars + (r.next.keptNonProgress < r.next.nonProgress ? r.originalChars : 0)),
      rereadsStillNeeded: rereads.filter(r => r.next.keptNonProgress < r.next.nonProgress).length,
    };
    await writeFile(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), oldFilter, newFilter, groups, inferred, rows }, null, 2)}\n`);
    console.log(JSON.stringify({ groups, inferred }, null, 1));
  }

}
