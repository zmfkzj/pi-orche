import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createSpillExtension, spillToolResult, type SpillEvent } from "../../src/tools/spill.js";
import { filterOutput, genericPreview } from "../../src/tools/output-filter.js";
import * as events from "../../src/tools/tool-events.js";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

// Freeze only artifact-name randomness/time, so comparisons include the notice bytes.
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(), randomBytes: () => Buffer.from("abcdef", "hex"),
}));

type Reduced = ReturnType<typeof events.outputReducedEvent>;
type Access = NonNullable<ReturnType<typeof events.artifactAccessEvent>>;
type Logged = Reduced | Access;
const secret = "SENTINEL_TOOL_EVENT_SECRET_92";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const rows = (n: number) => Array.from({ length: n }, (_, i) => `ordinary row ${i}`);
const passes = (n: number) => Array.from({ length: n }, (_, i) => ` ✓ src/example-${i}.test.ts (10 tests) 12ms`);
const summary = [" Test Files 100 passed (100)", " Tests 100 passed (100)", " Duration 2.5s"];
const textOf = (result: Awaited<ReturnType<typeof spillToolResult>>) => (result!.content[0] as { text: string }).text;
const artifactOf = (text: string) => /saved to (\S+\.txt)/.exec(text)![1]!;
const toolEvent = (toolName: string, text: string, input: Record<string, unknown> = {}): SpillEvent => ({
  toolName, toolCallId: "call-1", input, content: [{ type: "text", text }], isError: false,
});

async function waitEvents(path: string, count: number): Promise<Logged[]> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.endsWith("\n")) {
      const parsed: Logged[] = text.trimEnd().split("\n").map(line => JSON.parse(line));
      if (parsed.length >= count) return parsed;
    }
    await sleep(10);
  }
  throw new Error(`Expected ${count} events in ${path}`);
}

beforeEach(() => {
  vi.stubEnv("PI_ORCHE_TOOL_EVENTS", undefined);
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
});
afterEach(async () => {
  await sleep(20); // Drain best-effort appends before removing their temporary workspace.
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupWorkspaces();
});

describe("opt-in tool event log", () => {
  it("unset: keeps existing results and does no logging or file I/O", async () => {
    const cwd = await tempWorkspace();
    const path = join(cwd, "events.jsonl");
    const append = vi.spyOn(events, "appendToolEvent");
    expect(await spillToolResult(toolEvent("bash", "small"), cwd)).toBeUndefined();
    expect(await spillToolResult(toolEvent("read", "1#abcd|secret", { path: ".orche/artifacts/x.txt" }), cwd)).toBeUndefined();
    const original = rows(600).join("\n");
    const result = await spillToolResult(toolEvent("bash", original), cwd);
    expect(textOf(result)).toBe(`${genericPreview(original)!.text}\n\n[Output truncated: ${genericPreview(original)!.reason} (${genericPreview(original)!.omittedLines} lines omitted). Full output saved to ${artifactOf(textOf(result))}; use read with offset/limit or grep to inspect it.]`);
    expect(append).not.toHaveBeenCalled();
    expect(await stat(path).catch(() => undefined)).toBeUndefined();
  });

  const generic = rows(600);
  for (let i = 100; i < 150; i++) generic[i] = `Error: failure ${i} ${secret}`;
  const failures = [...passes(100), " FAIL src/broken.test.ts", `AssertionError: ${secret}`, "- Expected", "+ Received", "    at frame (src/test.ts:1:1)", ...passes(100), " Tests 1 failed | 200 passed"];
  const tsc = [...Array.from({ length: 80 }, (_, i) => `src/a${i}.ts(1,1): error TS2322: Duplicate message.`),
    "  A continuation.", "src/unique.ts(2,1): error TS2339: Unique message.", "Found 81 errors."];
  const lint = ["/repo/src/first.ts", ...Array.from({ length: 80 }, (_, i) => `  ${i}:3 warning unused no-unused-vars`),
    "  90:7 error Unexpected any no-explicit-any", "", "/repo/src/second.ts", "  1:1 error Unexpected console no-console", "✖ 82 problems (2 errors, 80 warnings)"];
  const grep = Array.from({ length: 24 }, (_, i) => `long/repository/path/to/file.ts:${i + 1}: match ${secret}`);
  const fallback = [...passes(400), ...Array.from({ length: 300 }, (_, i) => [
    ` FAIL src/broken-${i}.test.ts`, `AssertionError: expected ${i} ${"x".repeat(120)}`, "    at frame (src/test.ts:1:1)",
  ]).flat(), " Tests 300 failed"];
  const fixtures: Array<{
    name: string; tool: string; command?: string; original: string; piText?: string;
    reducer: Reduced["reducer"]; method: Reduced["shownMethod"]; mode: Reduced["mode"];
    shown?: number[][]; transformed: boolean; isError?: boolean;
  }> = [
    { name: "vitest pass-only", tool: "bash", command: "vitest run", original: [...passes(100), ...summary].join("\n"), reducer: "test", method: "aligned", mode: "filtered", shown: [[101, 103]], transformed: false },
    { name: "vitest with failures", tool: "bash", command: "vitest run", original: failures.join("\n"), reducer: "test", method: "aligned", mode: "filtered", shown: [[101, 105], [206, 206]], transformed: false, isError: true },
    { name: "tsc with duplicates", tool: "bash", command: "tsc --noEmit", original: tsc.join("\n"), reducer: "tsc", method: "aligned", mode: "filtered", shown: [[81, 83]], transformed: true },
    { name: "eslint", tool: "bash", command: "eslint .", original: lint.join("\n"), reducer: "lint", method: "aligned", mode: "filtered", shown: [[1, 1], [82, 82], [84, 86]], transformed: true },
    { name: "grep grouping", tool: "grep", original: grep.join("\n"), reducer: "grep", method: "lossless", mode: "filtered", shown: [[1, 24]], transformed: true },
    { name: "generic big bash with middle errors", tool: "bash", command: `echo ${secret}`, original: generic.join("\n"), reducer: "generic", method: "numbered", mode: "truncated", shown: [[1, 30], [101, 140], [541, 600]], transformed: false },
    { name: "Pi-truncated bash with fullOutputPath", tool: "bash", original: rows(100).join("\n"), piText: [...rows(100).slice(-3), "", "Command exited with code 3"].join("\n"), reducer: "pi-tail", method: "tail", mode: "truncated", shown: [[98, 100]], transformed: false, isError: true },
    { name: "non-bash browser_fetch spill", tool: "browser_fetch", original: rows(600).join("\n"), reducer: "generic", method: "aligned", mode: "truncated", shown: [[1, 30], [541, 600]], transformed: false },
    { name: "over-threshold specialized summary falls back", tool: "bash", command: "vitest run", original: fallback.join("\n"), reducer: "generic", method: "numbered", mode: "filtered", transformed: false },
  ];

  it.each(fixtures)("set: byte-identical results and correct metadata for $name", async fixture => {
    const cwd = await tempWorkspace();
    const path = join(cwd, "events.jsonl");
    const event = toolEvent(fixture.tool, fixture.piText ?? fixture.original, fixture.command ? { command: fixture.command } : {});
    event.isError = fixture.isError ?? false;
    event.structuredContent = { private: secret };
    event.content.push({ type: "image", data: "dummy", mimeType: "image/png" });
    if (fixture.piText) {
      const full = join(cwd, "full.txt");
      await writeFile(full, fixture.original);
      event.details = { fullOutputPath: full };
    }
    const baseline = await spillToolResult(event, cwd, "session-a");
    const savedPath = join(cwd, artifactOf(textOf(baseline)));
    const saved = await readFile(savedPath);
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", path);
    const logged = await spillToolResult(event, cwd, "session-a");
    expect(logged).toEqual(baseline); // Notice, content, images, isError and structuredContent policy.
    expect(Buffer.from(textOf(logged))).toEqual(Buffer.from(textOf(baseline)));
    expect(await readFile(savedPath)).toEqual(saved);
    const [record] = await waitEvents(path, 1) as Reduced[];
    const preview = filterOutput(fixture.tool, fixture.original, event.input) ?? genericPreview(fixture.original, fixture.tool === "bash" || fixture.tool === "grep");
    const inline = preview?.text ?? fixture.piText!;
    expect(record).toMatchObject({
      v: 1, type: "output_reduced", pid: process.pid, sessionId: "session-a", cwd,
      toolName: fixture.tool, toolCallId: "call-1", artifact: artifactOf(textOf(logged)),
      mode: fixture.mode, reducer: fixture.reducer, reason: preview?.reason ?? "Pi output truncation",
      original: events.textSize(fixture.original), inline: events.textSize(inline), visible: events.textSize(textOf(logged)),
      shownMethod: fixture.method, transformed: fixture.transformed, shownTruncated: false,
      clippedLines: 0, isError: fixture.isError ?? false,
    });
    expect(new Date(record!.ts).toISOString()).toBe(record!.ts);
    expect(record!.diagnostics).toEqual({
      original: fixture.original.split("\n").filter(line => /error|fail|warn|exception|panic|traceback|[✗×]/i.test(line)).length,
      visible: inline.split("\n").filter(line => /error|fail|warn|exception|panic|traceback|[✗×]/i.test(line)).length,
    });
    if (fixture.shown) expect(record!.shown).toEqual(fixture.shown);
    else {
      const numbers = inline.split("\n").flatMap(line => {
        const match = /^\[L(\d+)\] (.*)$/.exec(line);
        if (!match) return [];
        expect(fixture.original.split("\n")[Number(match[1]) - 1]).toBe(match[2]);
        return [Number(match[1])];
      });
      expect(record!.shown.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))).toEqual(numbers);
      expect(record!.reason).toContain("specialized summary was too large");
      expect(record!.omittedDiagnostics).toBeGreaterThan(0);
    }
    if (fixture.name === "generic big bash with middle errors") expect(record!.omittedDiagnostics).toBe(10);
    if (fixture.piText) expect(record!.exitCode).toBe(3);
    expect(await readFile(path, "utf8")).not.toContain(secret);
    expect(await readFile(savedPath, "utf8")).toBe(fixture.original);
  });

  it("records clipped ANSI lines with original coordinates and diagnostic counts", async () => {
    const cwd = await tempWorkspace();
    const path = join(cwd, "events.jsonl");
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", path);
    const original = [...passes(100), `\x1b[31mError: ${"x".repeat(3_000)}\x1b[0m`, ...summary].join("\n");
    await spillToolResult(toolEvent("bash", original, { command: "vitest" }), cwd);
    const [record] = await waitEvents(path, 1) as Reduced[];
    expect(record).toMatchObject({ shownMethod: "aligned", shown: [[101, 104]], clippedLines: 1, diagnostics: { original: 1, visible: 1 } });
    const genericOriginal = rows(600); genericOriginal[200] = "x".repeat(3_000) + " ERROR hidden";
    await spillToolResult(toolEvent("browser_fetch", genericOriginal.join("\n")), cwd);
    const all = await waitEvents(path, 2) as Reduced[];
    expect(all[1]).toMatchObject({ shown: [[1, 30], [541, 600]], clippedLines: 1, diagnostics: { original: 1, visible: 0 } });
  });

  it("best-effort log failures and artifact-save failures do not affect results or leak errors", async () => {
    const cwd = await tempWorkspace();
    await writeFile(join(cwd, ".orche"), "not a directory");
    const event = toolEvent("bash", rows(600).join("\n"));
    const baseline = await spillToolResult(event, cwd);
    const path = join(cwd, "events.jsonl");
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", path);
    expect(await spillToolResult(event, cwd)).toEqual(baseline);
    const [record] = await waitEvents(path, 1) as Reduced[];
    expect(record!.artifact).toBeNull();
    expect(record!.reason).not.toContain("ENOTDIR");
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", join(cwd, secret, "missing.jsonl"));
    expect(await spillToolResult(event, cwd)).toEqual(baseline);
    events.appendToolEvent(path, () => { throw new Error(secret); });
    await sleep(30);
    expect(await waitEvents(path, 1)).toHaveLength(1);
    expect(await readFile(path, "utf8")).not.toContain(secret);
  });
});

describe("artifact access metadata", () => {
  it.each([
    { name: "read offset/limit", tool: "read", input: { path: ".orche/artifacts/x.txt", offset: 10, limit: 3 }, text: `10#abcd|${secret}\n11|\n12#1234|other\n[more lines]`, expected: { read: { offset: 10, limit: 3, mode: "range", firstLine: 10, lastLine: 12, returnedLines: 3 } } },
    { name: "read outline", tool: "read", input: { path: ".orche/artifacts/x.txt", outline: true }, text: `file: 50 lines, 1 declarations\n10-20 function ${secret}`, expected: { read: { offset: null, limit: null, mode: "outline", firstLine: null, lastLine: null, returnedLines: 0 } } },
    { name: "read symbol", tool: "read", input: { path: ".orche/artifacts/x.txt", symbol: secret }, text: `-- function ${secret} (lines 20-21)\n20#abcd|body\n21|`, expected: { read: { mode: "symbol", firstLine: 20, lastLine: 21, returnedLines: 2 } } },
    { name: "grep artifact full path", tool: "grep", input: { path: ".orche/artifacts/x.txt", pattern: secret }, text: `.orche/artifacts/x.txt:10: ${secret}\n.orche/artifacts/x.txt-11- context\n.orche/artifacts/x.txt:20: match:999: not a line`, expected: { matchedLines: [10, 20], matchedLinesTruncated: false } },
    { name: "grep artifact Pi basename", tool: "grep", input: { path: ".orche/artifacts/x.txt", pattern: secret }, text: `x.txt:10: ${secret}\nx.txt:20: match`, expected: { matchedLines: [10, 20], matchedLinesTruncated: false } },
    { name: "bash sed-range", tool: "bash", input: { command: "sed -n '10,20p' .orche/artifacts/x.txt" }, text: secret, expected: { bashForm: "sed-range", range: { firstLine: 10, lastLine: 20 } } },
    { name: "bash tail", tool: "bash", input: { command: "tail -n 50 .orche/artifacts/x.txt" }, text: secret, expected: { bashForm: "tail", range: { lastLines: 50 } } },
    { name: "bash head", tool: "bash", input: { command: "head -n 20 .orche/artifacts/x.txt" }, text: secret, expected: { bashForm: "head", range: { firstLine: 1, lastLine: 20 } } },
    { name: "bash grep-n", tool: "bash", input: { command: `grep -n ${secret} .orche/artifacts/x.txt` }, text: secret, expected: { bashForm: "grep" } },
    { name: "bash cat", tool: "bash", input: { command: "cat .orche/artifacts/x.txt" }, text: secret, expected: { bashForm: "cat" } },
    { name: "bash awk", tool: "bash", input: { command: `awk '/${secret}/' .orche/artifacts/x.txt` }, text: secret, expected: { bashForm: "awk" } },
    { name: "bash other", tool: "bash", input: { command: `python .orche/artifacts/x.txt --${secret}` }, text: secret, expected: { bashForm: "other" } },
    { name: "find path", tool: "find", input: { path: ".orche/artifacts/x.txt", pattern: secret }, text: secret, expected: {} },
    { name: "ls path", tool: "ls", input: { path: ".orche/artifacts/x.txt" }, text: secret, expected: {} },
    { name: "other string input", tool: "custom", input: { source: ".orche/artifacts/x.txt", ignored: secret }, text: secret, expected: {} },
  ])("logs $name without output or arguments", async fixture => {
    const cwd = await tempWorkspace();
    const path = join(cwd, "events.jsonl");
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", path);
    const event = toolEvent(fixture.tool, fixture.text, fixture.input);
    const result = await spillToolResult(event, cwd, "access-session");
    if (fixture.tool === "read") expect(result).toBeUndefined();
    const records = await waitEvents(path, result ? 2 : 1);
    const record = records.find(record => record.type === "artifact_access") as Access;
    expect(record).toMatchObject({
      v: 1, type: "artifact_access", pid: process.pid, sessionId: "access-session", cwd,
      toolName: fixture.tool, toolCallId: "call-1", artifacts: [".orche/artifacts/x.txt"],
      resultChars: fixture.text.length, resultLines: fixture.text.split("\n").length, isError: false,
      ...fixture.expected,
    });
    expect(await readFile(path, "utf8")).not.toContain(secret);
    for (const forbidden of ["command", "pattern", "input", "content", "symbol", "text"]) expect(record).not.toHaveProperty(forbidden);
  });

  it("emits nothing without references; normalizes and deduplicates only workspace artifact paths", async () => {
    const cwd = await tempWorkspace();
    const path = join(cwd, "events.jsonl");
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", path);
    await spillToolResult(toolEvent("bash", secret, { command: `echo ${secret}` }), cwd);
    await spillToolResult(toolEvent("grep", "none", { path: "src", pattern: ".orche/artifacts/x.txt" }), cwd);
    await sleep(30);
    expect(await stat(path).catch(() => undefined)).toBeUndefined();
    expect(events.referencedArtifacts({ command: `cat ${join(cwd, ".orche/artifacts/x.txt")} ./.orche/artifacts/x.txt /elsewhere/.orche/artifacts/x.txt .orche/artifacts/../../secret` }, "bash", cwd)).toEqual([".orche/artifacts/x.txt"]);
    expect(events.referencedArtifacts({ command: `bash -c 'cat .orche/artifacts/x.txt' --file=.orche/artifacts/y.txt` }, "bash", cwd)).toEqual([".orche/artifacts/x.txt", ".orche/artifacts/y.txt"]);
    expect(events.referencedArtifacts({ path: ".orche/artifacts/space name.txt" }, "read", cwd)).toEqual([".orche/artifacts/space name.txt"]);
    expect(events.referencedArtifacts({ command: `cat '.orche/artifacts/space name.txt'` }, "bash", cwd)).toEqual([".orche/artifacts/space name.txt"]);
  });

  it("logs access before a replacement and snapshots the original mutable hook event", async () => {
    const cwd = await tempWorkspace();
    const path = join(cwd, "events.jsonl");
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", path);
    const original = rows(600).join("\n");
    const event = toolEvent("bash", original, { command: "cat .orche/artifacts/x.txt" });
    const result = await spillToolResult(event, cwd);
    event.content = result!.content;
    const all = await waitEvents(path, 2);
    expect(all.find(record => record.type === "artifact_access")).toMatchObject({ resultChars: original.length, resultLines: 600 });
    expect(all.find(record => record.type === "output_reduced")).toBeDefined();
    expect(all.every(record => !("sessionId" in record))).toBe(true);
  });

  it("caps grep matchedLines at 2,000", async () => {
    const cwd = await tempWorkspace();
    const event = toolEvent("grep", Array.from({ length: 2_001 }, (_, i) => `x.txt:${i + 1}: match`).join("\n"), { path: ".orche/artifacts/x.txt" });
    const record = events.artifactAccessEvent(event, cwd)!;
    expect(record.matchedLines).toHaveLength(2_000);
    expect(record.matchedLinesTruncated).toBe(true);
  });
});

describe("shown alignment and session logging", () => {
  it("aligns ANSI and both documented clips greedily, skipping rewritten lines", () => {
    const long = `\x1b[31mError: ${"x".repeat(3_000)}\x1b[0m`;
    expect(events.alignShown(`a\n${long}\na\nb`, `rewritten\na\n${long.slice(0, 2_000).replace(/\x1b\[31m/, "")}…[+${long.length - 2_000} chars]\na`)).toEqual({ shown: [[1, 3]], shownTruncated: false });
    const original = ["x".repeat(3_000), ...rows(600)].join("\n");
    const inline = genericPreview(original, false)!.text;
    expect(events.alignShown(original, inline).shown[0]).toEqual([1, 30]); // Includes the clipped head line and its short neighbors.
    expect(events.alignShown("same\nx\nsame", "same", true).shown).toEqual([[3, 3]]);
  });

  it("caps shown at 2,000 merged ranges with shownTruncated", () => {
    const original = rows(5_000);
    const inline = original.filter((_, i) => i % 2 === 0).join("\n");
    const aligned = events.alignShown(original.join("\n"), inline);
    expect(aligned.shown).toHaveLength(2_000);
    expect(aligned.shownTruncated).toBe(true);
    expect(aligned.shown.at(-1)).toEqual([3999, 3999]);
  });

  it("5 MB alignment completes in under 1 second", () => {
    const original = Array.from({ length: 50_000 }, (_, i) => `row ${i} ${"x".repeat(100)}`).join("\n");
    expect(original.length).toBeGreaterThan(5 * 1024 * 1024);
    const inline = original.split("\n").slice(-60).join("\n");
    const start = performance.now();
    const aligned = events.alignShown(original, inline);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(aligned).toEqual({ shown: [[49_941, 50_000]], shownTruncated: false });
  });

  it("two sessions append concurrently as valid JSONL and resolve the variable at event time", async () => {
    const cwd = await tempWorkspace();
    const path = join(cwd, "events.jsonl");
    const extension = createSpillExtension(cwd);
    const handler = extension.handlers.get("tool_result")![0] as (event: ToolResultEvent, ctx?: ExtensionContext) => ReturnType<typeof spillToolResult>;
    const context = (id: string) => ({ sessionManager: { getSessionId: () => id } }) as ExtensionContext;
    const event = toolEvent("read", `1#abcd|${secret}`, { path: ".orche/artifacts/x.txt" }) as ToolResultEvent;
    await handler(event, context("off"));
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", path);
    await Promise.all(Array.from({ length: 40 }, (_, i) => handler({ ...event, toolCallId: `call-${i}` }, context(i % 2 ? "session-a" : "session-b"))));
    // Destination is captured even though append/analysis is deferred.
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", undefined);
    const all = await waitEvents(path, 40);
    expect(all).toHaveLength(40);
    expect(new Set(all.map(record => record.sessionId))).toEqual(new Set(["session-a", "session-b"]));
    expect(new Set(all.map(record => record.toolCallId)).size).toBe(40);
    expect(await readFile(path, "utf8")).not.toContain(secret);
  });

  it("real worker hook receives Pi session context and logs artifact paging", async () => {
    const cwd = await tempWorkspace();
    await mkdir(join(cwd, ".orche/artifacts"), { recursive: true });
    await writeFile(join(cwd, ".orche/artifacts/x.txt"), "one\ntwo\nthree");
    const path = join(cwd, "events.jsonl");
    vi.stubEnv("PI_ORCHE_TOOL_EVENTS", path);
    const [result] = await runToolScript(cwd, ["read"], [() => ({ name: "read", args: { path: ".orche/artifacts/x.txt", offset: 2, limit: 1 } })]);
    expect(result!.text).toMatch(/^2#[0-9a-f]{4}\|two/);
    const [record] = await waitEvents(path, 1) as Access[];
    expect(record!.sessionId).toEqual(expect.any(String));
    expect(record!.read).toMatchObject({ firstLine: 2, lastLine: 2, returnedLines: 1 });
  });
});
