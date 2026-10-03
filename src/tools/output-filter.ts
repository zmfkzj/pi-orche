/** Deterministic model-side reductions. Full originals are persisted by spill.ts. */
export const SPILL_MAX_CHARS = 12_000;
export const SPILL_MAX_LINES = 300;
const MIN_FILTER_CHARS = 2_000;
const MIN_FILTER_LINES = 60;
const MAX_SPECIALIZED_BYTES = 2 * 1024 * 1024;
const ANSI = /\x1b\[[0-?]{0,40}[ -/]{0,40}[@-~]/g;
interface Analysis {
  lines: string[];
  diagnostic: boolean[];
  strong: boolean[];
  clipped: boolean[];
  longLines: number;
}
const STRONG_WORDS = ["error", "fail", "exception", "panic", "traceback", "✗", "×"];
function analysisLines(text: string): Analysis {
  const diagnostic: boolean[] = [], strong: boolean[] = [], clipped: boolean[] = [];
  let longLines = 0;
  const lines = text.split("\n").map((line, i) => {
    clipped[i] = line.length > 2_000;
    const plain = (clipped[i] ? `${line.slice(0, 2_000)}…[+${line.length - 2_000} chars]` : line).replace(ANSI, "");
    // Only fixed-word scans touch an unclipped line; all regexes use its bounded head.
    const lower = clipped[i] ? line.toLowerCase() : "";
    strong[i] = STRONG_DIAGNOSTIC.test(plain) || (clipped[i] && STRONG_WORDS.some(word => lower.includes(word)));
    diagnostic[i] = strong[i] || DIAGNOSTIC.test(plain) || (clipped[i] && lower.includes("warn"));
    if (clipped[i]) longLines++;
    return plain;
  });
  return { lines, diagnostic, strong, clipped, longLines };
}
function clippingReason(analysis: Analysis, reduction: OutputReduction | undefined): OutputReduction | undefined {
  if (reduction && analysis.longLines) reduction.reason += `; ${analysis.longLines} long lines clipped at 2,000 chars`;
  return reduction;
}
// Do not let a progress/noise heuristic hide a diagnostic.
export const DIAGNOSTIC = /error|fail|warn|exception|panic|traceback|[✗×]/i;
const STRONG_DIAGNOSTIC = /error|fail|exception|panic|traceback|[✗×]/i;
const STATUS = /^Command (?:exited|aborted|timed out|failed|was aborted|was terminated)/i;
const clip = (line: string) => {
  if (line.length <= 1_000) return line;
  const suffix = /…\[\+(\d{1,9}) chars\]$/.exec(line);
  const omitted = suffix ? line.length - suffix[0].length - 1_000 + Number(suffix[1]) : line.length - 1_000;
  return `${line.slice(0, 1_000)}…[+${omitted} chars]`;
};

export interface OutputReduction {
  text: string;
  omittedLines: number;
  reason: string;
}

export function exceedsSpill(text: string): boolean {
  if (text.length > SPILL_MAX_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > SPILL_MAX_LINES) return true;
  return false;
}

/** Numbered bash fallback; other tools retain the generic unnumbered head/tail preview. */
export function genericPreview(text: string, numbered = true): OutputReduction | undefined {
  if (!exceedsSpill(text)) return undefined;
  const analysis = analysisLines(text);
  return clippingReason(analysis, previewLines(analysis, numbered));
}

function previewLines(analysis: Analysis, numbered: boolean): OutputReduction {
  const { lines, diagnostic, strong } = analysis;
  const shown = new Set<number>();
  const rendered = new Map<number, string>();
  const take = (indices: number[], maxLines: number, maxChars: number, fill = false) => {
    let count = 0, chars = 0;
    for (const i of indices) {
      if (shown.has(i)) continue;
      const line = `${numbered ? `[L${i + 1}] ` : ""}${clip(lines[i]!)}`;
      if (count >= maxLines) break;
      const cost = line.length + (fill && !shown.has(i - 1) && !shown.has(i + 1) ? 65 : 1);
      if (chars + cost > maxChars) {
        if (fill) continue;
        break;
      }
      shown.add(i); rendered.set(i, line); count++; chars += cost;
    }
  };
  take(Array.from({ length: Math.min(lines.length, 30) }, (_, i) => i), 30, 3_000);
  take(Array.from({ length: Math.min(lines.length, 60) }, (_, i) => lines.length - 1 - i), 60, 4_000);
  let omittedDiagnostics = 0;
  if (numbered) {
    const errors: number[] = [], warnings: number[] = [];
    let lastStatus: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!shown.has(i) && diagnostic[i]) (strong[i] ? errors : warnings).push(i);
      if (STATUS.test(line)) lastStatus = i;
    }
    // Stable, linear error-first partition; ANSI was stripped once during preparation.
    const middle = errors.concat(warnings);
    take(middle, 40, 3_000, true);
    if (lastStatus !== undefined && !shown.has(lastStatus)) {
      const status = lines[lastStatus]!;
      const bounded = status.length > 160 ? `${status.slice(0, 160)}…[+${status.length - 160} chars]` : status;
      shown.add(lastStatus); rendered.set(lastStatus, `[L${lastStatus + 1}] ${bounded}`);
    }
    omittedDiagnostics = middle.filter((i) => !shown.has(i)).length;
  }
  const ordered = [...shown].sort((a, b) => a - b);
  const result: string[] = [];
  let previous = -1;
  for (const i of ordered) {
    if (i > previous + 1) result.push(`… [${i - previous - 1} lines omitted from the middle] …`);
    result.push(rendered.get(i)!); previous = i;
  }
  if (previous < lines.length - 1) result.push(`… [${lines.length - previous - 1} lines omitted from the middle] …`);
  const preview = result.join("\n");
  const reason = `middle output / long lines truncated${omittedDiagnostics ? `; ${omittedDiagnostics} more matching diagnostic lines omitted; grep the artifact` : ""}`;
  return { text: preview, omittedLines: lines.length - shown.size, reason };
}

const TEST_SUMMARY = /^(?:Test (?:Files|Suites)|Tests:|Tests\s{1,40}\d|Snapshots:|Time:|Ran all test suites|Duration\s|Start at\s|Test run finished|# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)|(?:={1,100}\s{0,40})?\d{1,9} (?:passed|failed)|test result:|FAIL\s{1,40}\S{1,500}\s{1,40}[\d.]{1,20}s|\d{1,9} (?:passing|failing|pending))/i;
function testSummary(line: string): boolean {
  const plain = line.trim();
  return TEST_SUMMARY.test(plain) || (plain.endsWith("=") && /\b(?:passed|failed)\b/i.test(plain));
}
function testPass(line: string): boolean {
  const plain = line.trim();
  if (/^(?:[✓√✔]|PASS\b|ok\s{1,40}\d{1,9}\s{1,40}-|ok\s{1,40}\S{1,500}\s{1,40}(?:[\d.]{1,20}s|\(cached\))|\.\.\.|[.s]{1,2000}$)/i.test(plain)) return true;
  if (plain.startsWith("test ") && plain.includes("...") && /\.\.\.\s{1,40}ok\b/.test(plain)) return true;
  const progress = /\[\s{0,40}\d{1,3}%\s{0,40}\]$/.exec(plain);
  if (progress && /^\.{1,2000}$/.test(plain.slice(0, progress.index).trimEnd().split(/\s+/).at(-1) ?? "")) return true;
  const words = plain.split(/\s+/);
  return /^(?:\[\d{1,3}%\]|[\d.]{1,20}m?s)$/.test(words.at(-1) ?? "")
    && (/^\.{1,2000}$/.test(words.at(-2) ?? "") || /\(\d{1,9} tests?\)/.test(plain));
}
const FAILURE_HEADER = /^\s{0,40}(?:FAIL\b|FAILED\b|[✗×]|not ok\b|(?:[-─]{1,100}\s{0,40})?(?:Failed Tests|FAILURES|ERRORS)\b|failures:|\d{1,9}\)\s)/i;
const STACK = /^\s{0,40}(?:at\s|❯\s|File "[^"\n]{0,1000}", line \d{1,9})/;

function testOutput(analysis: Analysis): OutputReduction | undefined {
  const { lines, diagnostic, strong, clipped } = analysis;
  if (!lines.some((line) => testPass(line) || testSummary(line) || FAILURE_HEADER.test(line))) return undefined;
  const kept: string[] = [];
  const hasFailure = lines.some((line, i) => FAILURE_HEADER.test(line) || (clipped[i] && strong[i]) || /(?:AssertionError|Error:|Traceback|panic:)/.test(line));
  let inFailure = false, stacks = 0, passingTap = false, inConsole = false;
  for (const [i, line] of lines.entries()) {
    const plain = line;
    const summary = testSummary(plain);
    if (FAILURE_HEADER.test(plain)) { inFailure = true; stacks = 0; passingTap = false; inConsole = false; }
    if (hasFailure && (/stdout\s{0,40}\||stderr\s{0,40}\||Captured std(?:out|err)|console\.(?:log|warn|error)/.test(plain) || (plain.includes("----") && plain.includes("stdout")))) inConsole = true;
    if (summary || STATUS.test(plain)) { kept.push(line); continue; }
    if (diagnostic[i]) { kept.push(line); continue; }
    if (testPass(plain)) {
      // Console content may itself look like passing progress. Only resume
      // dropping progress at a recognizable runner result, not an arbitrary ✓.
      const runnerResult = (/\.(?:[cm]?[jt]sx?|py|rs)\b/.test(plain) && /\d{1,9}(?:ms|s)|\[\s{0,40}\d{1,3}%/.test(plain))
        || /^\s{0,40}(?:PASS\s|ok\s|test\s)/.test(plain);
      if (inConsole && !runnerResult) { kept.push(line); continue; }
      inConsole = false; inFailure = false; passingTap = /^\s{0,40}ok\s{1,40}\d{1,9}\s{1,40}-/.test(plain); continue;
    }
    if (passingTap && /^\s{1,40}(?:---|duration_ms:|type:|\.\.\.)/.test(plain)) continue;
    if (inFailure && STACK.test(plain) && ++stacks > 10) continue;
    // With failures, conservatively retain all non-progress output: code frames,
    // console output (including output preceding a failure), diffs, and unknown text.
    if (hasFailure || inFailure) kept.push(line);
  }
  if (!lines.some(testSummary)) {
    // Go has no aggregate footer; its last package result serves as the summary.
    const lastPackage = lines.findLast((line) => /^\s{0,40}ok\s{1,40}\S{1,500}\s{1,40}(?:[\d.]{1,20}s|\(cached\))/.test(line));
    if (lastPackage) kept.push(lastPackage);
  }
  return { text: kept.join("\n"), omittedLines: lines.length - kept.length, reason: "passing tests / progress omitted" };
}

interface TsError { code: string; message: string; locations: string[]; continuations: string[]; line: string }
function tscOutput(analysis: Analysis): OutputReduction | undefined {
  const { lines, diagnostic, clipped } = analysis;
  const groups = new Map<string, TsError>();
  const extra: string[] = [];
  let current: TsError | undefined;
  for (const [i, line] of lines.entries()) {
    const plain = line;
    const match = /^(.*)\((\d{1,9}),(\d{1,9})\):\s{0,40}error (TS\d{1,9}):\s{0,40}(.*)$/.exec(plain)
      ?? /^(.*):(\d{1,9}):(\d{1,9})\s{1,40}-\s{1,40}error (TS\d{1,9}):\s{0,40}(.*)$/.exec(plain);
    if (match) {
      const [, file, row, col, code, message] = match;
      // Distinct tails must not collapse just because their clipped heads match.
      const key = `${code}\0${message}${clipped[i] ? `\0long-line-${i}` : ""}`;
      current = groups.get(key);
      if (!current) { current = { code: code!, message: message!, locations: [], continuations: [], line }; groups.set(key, current); }
      current.locations.push(`${file}:${row}:${col}`);
    } else if (/^\s{0,40}(?:\d{1,9}\s{1,40}|[~^]{1,2000}\s{0,40}$)/.test(plain)) {
      // --pretty source and underline lines, not message continuations.
      if (diagnostic[i]) extra.push(line);
    } else if (current && !plain.trim()) {
      // Pretty output can separate message continuations and source frames with blanks.
    } else if (current && /^\s{1,40}\S/.test(plain)) {
      if (!current.continuations.includes(line)) current.continuations.push(line);
    } else {
      current = undefined;
      if (/^Found \d{1,9} errors?/.test(plain) || STATUS.test(plain) || diagnostic[i]) extra.push(line);
    }
  }
  if (!groups.size && !lines.some((_, i) => clipped[i] && diagnostic[i])) return undefined;
  const kept: string[] = [];
  for (const group of groups.values()) {
    kept.push(group.locations.length === 1 ? group.line : `${group.code}: ${group.message} (${group.locations.length} occurrences; ${group.locations.slice(0, 5).join(", ")}${group.locations.length > 5 ? ", …" : ""})`);
    kept.push(...group.continuations);
  }
  kept.push(...extra);
  return { text: kept.join("\n"), omittedLines: Math.max(0, lines.length - kept.length), reason: "duplicate TypeScript errors / code frames collapsed" };
}

function lintOutput(analysis: Analysis): OutputReduction | undefined {
  const { lines, diagnostic, strong, clipped } = analysis;
  const kept: string[] = [];
  const warnings = new Map<string, string[]>();
  let file = "", printedFile = "";
  let entries = 0;
  let pendingBiome: { warning: boolean; rule: string; location: string; lines: string[]; keep: boolean } | undefined;
  const flushBiome = () => {
    if (!pendingBiome) return;
    if (pendingBiome.warning && !pendingBiome.keep) {
      const locations = warnings.get(pendingBiome.rule) ?? [];
      locations.push(pendingBiome.location); warnings.set(pendingBiome.rule, locations);
    } else kept.push(...pendingBiome.lines);
    pendingBiome = undefined;
  };
  for (const [i, line] of lines.entries()) {
    const plain = line;
    const prefix = /^\s{0,40}(\d{1,9}):(\d{1,9})\s{1,40}(error|warning)\s{1,40}/.exec(plain);
    const words = prefix ? plain.slice(prefix[0].length).trim().split(/\s+/) : [];
    const rule = words.pop();
    const entry = prefix && rule && words.length ? ["", prefix[1], prefix[2], prefix[3], words.join(" "), rule] : undefined;
    const biomePrefix = /^(.*):(\d{1,9}):(\d{1,9})\s{1,40}(\S{1,500})\s{1,40}/.exec(plain);
    const biomeTail = biomePrefix ? plain.slice(biomePrefix[0].length) : "";
    const severity = /\b(WARNING|WARN|ERROR)\b/i.exec(biomeTail)?.[1];
    const biome = biomePrefix && (severity || (/^(?:lint\/|parse$)/.test(biomePrefix[4]!) && /^[-━─]/.test(biomeTail)))
      ? [...biomePrefix, severity] : undefined;
    if (biome) {
      flushBiome(); entries++;
      pendingBiome = { warning: /^WARN/i.test(biome[5] ?? ""), rule: biome[4]!, location: `${biome[1]}:${biome[2]}:${biome[3]}`, lines: [line], keep: strong[i]! || (clipped[i]! && diagnostic[i]!) };
    } else if (entry) {
      flushBiome(); entries++;
      const [, row, col, severity, message, rule] = entry;
      if (severity === "warning" && !strong[i] && !(clipped[i] && diagnostic[i])) {
        const locations = warnings.get(rule!) ?? [];
        locations.push(`${file}:${row}:${col}`); warnings.set(rule!, locations);
      } else {
        if (file && printedFile !== file) { kept.push(file); printedFile = file; }
        kept.push(line);
      }
    } else if (/^\s{0,40}(?:✖|Found \d{1,9}|Checked \d{1,9}|\d{1,9} problems?\b)/.test(plain) || STATUS.test(plain)) {
      flushBiome(); kept.push(line);
    } else if (pendingBiome) {
      if (/^\s{0,40}!\s/.test(plain)) pendingBiome.warning = true;
      pendingBiome.lines.push(line);
      pendingBiome.keep ||= strong[i]! || (clipped[i]! && diagnostic[i]!);
    }
    else if (plain.trim() && !/^\s/.test(plain) && !diagnostic[i]) file = line;
    else if (diagnostic[i]) kept.push(line);
    else if (/^\s{1,40}\S/.test(plain)) kept.push(line);
  }
  flushBiome();
  if (!entries && !lines.some((_, i) => clipped[i] && diagnostic[i])) return undefined;
  for (const [rule, locations] of warnings) kept.push(`warning ${rule}: ${locations.length} occurrences (${locations.slice(0, 3).join(", ")}${locations.length > 3 ? ", …" : ""})`);
  return { text: kept.join("\n"), omittedLines: Math.max(0, lines.length - kept.length), reason: "linter warnings collapsed" };
}

/** Prefer the earliest Pi match/context delimiter, never one embedded in source text. */
export function groupGrep(text: string): OutputReduction | undefined {
  const analysis = analysisLines(text);
  return clippingReason(analysis, grepLines(analysis.lines, text.length));
}

function grepLines(lines: string[], originalLength: number): OutputReduction | undefined {
  const files = new Map<string, string[]>();
  const matchPaths = new Set<string>(), contextPaths = new Set<string>();
  const notices: string[] = [];
  let previousPath: string | undefined;
  for (const line of lines) {
    const matched = /^(.+?):(\d{1,9}): (.*)$/.exec(line);
    const context = /^(.+?)-(\d{1,9})- (.*)$/.exec(line);
    const match = matched && context ? (matched[1]!.length <= context[1]!.length ? matched : context) : matched ?? context;
    if (match) {
      const [, path, row, body] = match;
      // Decline rather than reorder interleaved files or mid-output notices.
      if (notices.length || (path !== previousPath && files.has(path!))) return undefined;
      previousPath = path;
      const delimiter = line[path!.length] === ":" ? ":" : "-";
      (delimiter === ":" ? matchPaths : contextPaths).add(path!);
      const entries = files.get(path!) ?? [];
      entries.push(`  ${row}${delimiter} ${body}`); files.set(path!, entries);
    } else if (!line.trim() || /^\[(?:\d{1,9} matches limit reached|[\d.]{1,20}\s{0,40}\w{0,10}B limit reached|Some lines truncated)/.test(line)) notices.push(line);
    else return undefined;
  }
  if (!files.size || [...contextPaths].some(path => !matchPaths.has(path))) return undefined;
  const grouped = [...files].flatMap(([file, entries]) => [file, ...entries]).concat(notices).join("\n");
  return grouped.length <= originalLength * 0.85 ? { text: grouped, omittedLines: 0, reason: "repeated grep paths grouped" } : undefined;
}

/** Prepare once before regex work; very large outputs only use the linear fallback. */
export function filterOutput(toolName: string, text: string, input?: Record<string, unknown>): OutputReduction | undefined {
  if (toolName !== "bash" && toolName !== "grep") return undefined;
  const analysis = analysisLines(text);
  const { lines } = analysis;
  const fallback = () => exceedsSpill(text) ? clippingReason(analysis, previewLines(analysis, true)) : undefined;
  if (text.length > MAX_SPECIALIZED_BYTES || Buffer.byteLength(text) > MAX_SPECIALIZED_BYTES) return fallback();
  let candidate: OutputReduction | undefined;
  let specialized = toolName === "grep";
  if (toolName === "grep") candidate = grepLines(lines, text.length);
  else {
    if (text.length < MIN_FILTER_CHARS && lines.length < MIN_FILTER_LINES) return undefined;
    const command = typeof input?.command === "string" ? analysisLines(input.command).lines[0]! : "";
    const sample = lines.length > 800 ? lines.slice(0, 400).concat(lines.slice(-400)) : lines;
    if (/\btsc\b/.test(command) || sample.some(line => /error TS\d{1,9}:/.test(line))) {
      specialized = true; candidate = tscOutput(analysis);
    } else if (/\b(?:eslint|biome)\b/.test(command) || sample.some(line => /\d{1,9}:\d{1,9}\s{1,40}(?:error|warning)\s|:\d{1,9}:\d{1,9}\s{1,40}lint\/\S{1,500}/.test(line))) {
      specialized = true; candidate = lintOutput(analysis);
    } else if (/\b(?:vitest|jest|mocha|pytest)\b|\bnode\b[^\n]{0,500}--test\b|\b(?:go|cargo)\s{1,40}test\b/.test(command)
      || sample.some(line => testSummary(line) || /^(?:ok|FAIL)\s{1,40}\S{1,500}\s{1,40}(?:[\d.]{1,20}s|\(cached\))/.test(line.trim()))) {
      specialized = true; candidate = testOutput(analysis);
    }
  }
  if (candidate && exceedsSpill(candidate.text)) {
    const preview = fallback();
    if (preview) preview.reason = `specialized summary was too large; ${preview.reason}`;
    return preview;
  }
  if (!candidate && specialized) return fallback();
  return candidate && candidate.text.length <= text.length * (toolName === "grep" ? 0.85 : 0.8) ? clippingReason(analysis, candidate) : undefined;
}
