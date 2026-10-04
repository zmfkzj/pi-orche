import { appendFile } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { DIAGNOSTIC, type OutputReduction } from "./output-filter.js";
import type { SpillEvent } from "./spill.js";

const MAX_RANGES = 2_000;
const ANSI = /\x1b\[[0-?]{0,40}[ -/]{0,40}[@-~]/g;
type Range = [number, number];
type Reducer = "test" | "tsc" | "lint" | "grep" | "generic" | "pi-tail";

/** Counts use JS string lengths and split-on-newline lines, including a trailing empty line. */
export function textSize(text: string): { chars: number; lines: number } {
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return { chars: text.length, lines };
}

function normalized(line: string, cap: number): string {
  return (line.length > cap ? `${line.slice(0, cap)}…[+${line.length - cap} chars]` : line).replace(ANSI, "");
}

function mergedRanges(numbers: number[]): { shown: Range[]; shownTruncated: boolean } {
  const shown: Range[] = [];
  let truncated = false;
  for (const n of numbers.sort((a, b) => a - b)) {
    const last = shown.at(-1);
    if (last && n <= last[1] + 1) last[1] = Math.max(last[1], n);
    else if (shown.length < MAX_RANGES) shown.push([n, n]);
    else { truncated = true; break; }
  }
  return { shown, shownTruncated: truncated };
}

/** Greedy in-order matching without rescanning the original for unmatched/transformed lines.
 * Keys reproduce both the analysis's raw 2,000-char clip-before-ANSI-strip and the
 * generic preview's subsequent 1,000-char clip. Rewritten lines are not claimed visible.
 * Tail matching runs backwards to disambiguate repeated lines in Pi's tail.
 */
export function alignShown(original: string, inline: string, tail = false): { shown: Range[]; shownTruncated: boolean } {
  const source = original.split("\n");
  const index = new Map<string, number[]>();
  for (let i = 0; i < source.length; i++) {
    const raw = source[i]!;
    const plain = normalized(raw, 2_000);
    const keys = [plain];
    if (plain.length > 1_000) {
      const suffix = /…\[\+(\d{1,9}) chars\]$/.exec(plain);
      const omitted = suffix ? plain.length - suffix[0].length - 1_000 + Number(suffix[1]) : plain.length - 1_000;
      keys.push(`${plain.slice(0, 1_000)}…[+${omitted} chars]`);
    }
    for (const key of new Set(keys)) {
      const entries = index.get(key);
      if (entries) entries.push(i + 1);
      else index.set(key, [i + 1]);
    }
  }
  const selected: number[] = [];
  let cursor = tail ? source.length + 1 : 0;
  const target = inline.split("\n");
  if (tail) target.reverse();
  for (const line of target) {
    const entries = index.get(line.replace(ANSI, ""));
    if (!entries) continue;
    let lo = 0, hi = entries.length;
    // First entry > cursor (forward), or first entry >= cursor (backwards).
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid]! < cursor || (!tail && entries[mid] === cursor)) lo = mid + 1;
      else hi = mid;
    }
    const n = entries[tail ? lo - 1 : lo];
    if (n !== undefined) { selected.push(n); cursor = n; }
  }
  return mergedRanges(selected);
}

function reducerKind(preview: OutputReduction | undefined): Reducer {
  // Reasons are fixed reducer metadata, never output/arguments or a save-error message.
  if (!preview) return "pi-tail";
  if (preview.reason.startsWith("passing tests")) return "test";
  if (preview.reason.startsWith("duplicate TypeScript")) return "tsc";
  if (preview.reason.startsWith("linter warnings")) return "lint";
  if (preview.reason.startsWith("repeated grep")) return "grep";
  return "generic";
}

function common(event: SpillEvent, cwd: string, sessionId?: string) {
  return {
    v: 1 as const, ts: new Date().toISOString(), pid: process.pid,
    ...(sessionId === undefined ? {} : { sessionId }), cwd,
    toolName: event.toolName, toolCallId: event.toolCallId ?? null,
  };
}

export interface ReductionMetadata {
  original: string;
  inline: string;
  visible: string;
  piText: string;
  artifact: string | null;
  filtered: boolean;
  preview?: OutputReduction;
  /** Full files above the spill reader's cap have unknown original line coordinates. */
  originalUnavailable?: boolean;
}

export function outputReducedEvent(event: SpillEvent, cwd: string, meta: ReductionMetadata, sessionId?: string) {
  const reducer = !meta.preview && meta.inline !== meta.piText ? "generic" : reducerKind(meta.preview);
  const source = meta.original.split("\n");
  const inlineLines = meta.inline.split("\n");
  const numbered = reducer === "generic" && (event.toolName === "bash" || event.toolName === "grep");
  const shownMethod = reducer === "grep" ? "lossless" : reducer === "pi-tail" ? "tail" : numbered ? "numbered" : "aligned";
  const selected = meta.originalUnavailable ? { shown: [], shownTruncated: false }
    : shownMethod === "lossless" ? { shown: [[1, source.length]] as Range[], shownTruncated: false }
    : numbered ? mergedRanges(inlineLines.flatMap(line => {
      const n = /^\[L(\d+)\] /.exec(line);
      return n && Number(n[1]) <= source.length ? [Number(n[1])] : [];
    })) : alignShown(meta.original, meta.inline, shownMethod === "tail");
  const originalDiagnostics = source.reduce((n, line) => n + Number(DIAGNOSTIC.test(line.replace(ANSI, ""))), 0);
  const visibleDiagnostics = inlineLines.reduce((n, line) => n + Number(DIAGNOSTIC.test(line.replace(ANSI, ""))), 0);
  const omitted = /; (\d+) more matching diagnostic lines omitted/.exec(meta.preview?.reason ?? "");
  const exit = /(?:^|\n)Command exited with code (-?\d+)\s*$/.exec(meta.piText);
  return {
    ...common(event, cwd, sessionId), type: "output_reduced" as const,
    artifact: meta.artifact, mode: meta.filtered ? "filtered" as const : "truncated" as const,
    reducer, reason: meta.preview?.reason ?? "Pi output truncation",
    original: textSize(meta.original), inline: textSize(meta.inline), visible: textSize(meta.visible),
    omittedLines: meta.preview?.omittedLines ?? Math.max(0, source.length - selected.shown.reduce((n, [a, b]) => n + b - a + 1, 0)),
    ...(numbered ? { omittedDiagnostics: omitted ? Number(omitted[1]) : 0 } : {}),
    clippedLines: meta.preview ? source.filter(line => line.length > 2_000).length : 0,
    diagnostics: { original: originalDiagnostics, visible: visibleDiagnostics },
    ...selected, shownMethod, transformed: reducer === "tsc" || reducer === "lint" || reducer === "grep",
    ...(meta.originalUnavailable ? { originalUnavailable: true } : {}),
    isError: event.isError ?? false, ...(exit ? { exitCode: Number(exit[1]) } : {}),
  };
}

/** Only normalized paths inside this workspace's artifact directory may enter the log. */
export function referencedArtifacts(input: Record<string, unknown> | undefined, toolName: string, cwd: string): string[] {
  const pathInput = ["read", "grep", "find", "ls"].includes(toolName);
  const values = toolName === "bash" ? [input?.command]
    : pathInput ? [input?.path] : Object.values(input ?? {});
  const paths = new Set<string>();
  const visit = (value: unknown, depth = 0) => {
    if (typeof value !== "string" || depth > 8) return;
    const candidates = pathInput ? [value] : [...value.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s"'`|;&<>()]+)/g)]
      .map(token => token[1] ?? token[2] ?? token[3]!);
    // Explicit path arguments are kept whole; shell tokens honor quoted spaces.
    for (const candidate of candidates) {
      if (!candidate.includes(".orche/artifacts")) continue;
      const path = relative(cwd, resolve(cwd, candidate)).split(sep).join("/");
      if (path === ".orche/artifacts" || path.startsWith(".orche/artifacts/")) paths.add(path);
      else if (!pathInput) {
        // Quoted bash -c payloads and --file=path arguments still reference artifacts.
        if (candidate !== value) visit(candidate, depth + 1);
        const equals = candidate.indexOf("=");
        if (equals >= 0) visit(candidate.slice(equals + 1), depth + 1);
      }
    }
  };
  for (const value of values) visit(value);
  return [...paths];
}

export function bashMetadata(command: string): {
  bashForm: "cat" | "head" | "tail" | "sed-range" | "grep" | "awk" | "other";
  range?: { firstLine: number; lastLine: number } | { lastLines: number };
} {
  const form = /^\s*(cat|head|tail|sed|grep|awk)\b/.exec(command)?.[1];
  const sed = /^\s*sed\s+-n\s+(['"])(\d+),(\d+)p\1\s+[^|;&\n]+$/.exec(command);
  if (sed) return { bashForm: "sed-range", range: { firstLine: Number(sed[2]), lastLine: Number(sed[3]) } };
  const count = /^\s*(head|tail)\s+-n\s+(\d+)\s+[^|;&\n]+$/.exec(command);
  if (count) return {
    bashForm: count[1] as "head" | "tail",
    range: count[1] === "head" ? { firstLine: 1, lastLine: Number(count[2]) } : { lastLines: Number(count[2]) },
  };
  return { bashForm: form && form !== "sed" ? form as "cat" | "head" | "tail" | "grep" | "awk" : "other" };
}

export function artifactAccessEvent(event: SpillEvent, cwd: string, sessionId?: string) {
  const artifacts = referencedArtifacts(event.input, event.toolName, cwd);
  if (!artifacts.length) return undefined;
  const text = event.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  const lines = text.split("\n");
  const anchors = event.toolName === "read" ? lines.flatMap(line => {
    const match = /^(\d+)(?:#[\da-fA-F]{4,16})?\|/.exec(line);
    return match ? [Number(match[1])] : [];
  }) : [];
  const matched: number[] = [];
  let matchedLinesTruncated = false;
  if (event.toolName === "grep") {
    for (const line of lines) {
      const match = /^(.+?):(\d+):/.exec(line);
      // Pi prints a basename for file searches and a search-root-relative path for directories.
      if (!match) continue;
      if (matched.length < MAX_RANGES) matched.push(Number(match[2]));
      else matchedLinesTruncated = true;
    }
  }
  return {
    ...common(event, cwd, sessionId), type: "artifact_access" as const, artifacts,
    ...(event.toolName === "read" ? { read: {
      offset: typeof event.input?.offset === "number" ? event.input.offset : null,
      limit: typeof event.input?.limit === "number" ? event.input.limit : null,
      mode: event.input?.outline === true ? "outline" : typeof event.input?.symbol === "string" ? "symbol" : "range",
      firstLine: anchors.length ? anchors.reduce((a, b) => Math.min(a, b)) : null,
      lastLine: anchors.length ? anchors.reduce((a, b) => Math.max(a, b)) : null, returnedLines: anchors.length,
    } } : {}),
    ...(event.toolName === "grep" ? { matchedLines: matched, matchedLinesTruncated } : {}),
    ...(event.toolName === "bash" ? bashMetadata(typeof event.input?.command === "string" ? event.input.command : "") : {}),
    resultChars: text.length, resultLines: lines.length, isError: event.isError ?? false,
  };
}

/** Defer analysis and never await disk I/O. One callback append per event, no directories,
 * retries, output text or error messages. The destination is captured at hook/event time.
 */
export function appendToolEvent(path: string, build: () => object | undefined): void {
  try {
    setImmediate(() => {
      try {
        const event = build();
        if (event) appendFile(path, `${JSON.stringify(event)}\n`, () => {});
      } catch { /* Logging must never affect tools. */ }
    });
  } catch { /* Best effort, including scheduling/serialization errors. */ }
}
