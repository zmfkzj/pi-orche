import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { filterOutput, genericPreview, groupGrep } from "../../src/tools/output-filter.js";
import { spillToolResult } from "../../src/tools/spill.js";
import { cleanupWorkspaces, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);
const repeat = (line: string, n = 100) => Array.from({ length: n }, (_, i) => line.replace("$i", String(i)));
const filtered = (command: string, lines: string[]) => filterOutput("bash", lines.join("\n"), { command })!;
const passes = (n: number) => repeat(" ✓ src/example-$i.test.ts (10 tests) 12ms", n);
const vitestSummary = [" Test Files  60 passed (60)", "      Tests  600 passed (600)", "   Duration  2.53s"];

function failure(id: number): string[] {
  return [
    ` FAIL src/broken-${id}.test.ts > handles bad input`,
    `AssertionError: expected ${id} to be ${id + 1}`,
    "- Expected", `+ Received: ${id}`,
    " ❯ src/broken.test.ts:15:9",
    "     13| const value = compute();", "     14| expect(value)", "     15|   .toBe(2);", "       |    ^",
    `stdout | src/broken-${id}.test.ts`, "logged decisive diagnostic context",
    ...repeat(`    at frame$i (src/context-${id}.ts:12:3)`, 12),
  ];
}

describe("test-runner output reductions", () => {
  it("reduces pass-only vitest output to its final summary", () => {
    const result = filtered("npx vitest run", [...passes(100), ...vitestSummary]);
    expect(result.text).toBe(vitestSummary.join("\n"));
    expect(result.omittedLines).toBe(100);
  });

  it("retains two vitest failures in the middle of 600 progress lines, diffs, code frames and failure console output", () => {
    const result = filtered("vitest run", [
      ...passes(200), ...failure(1), ...passes(200), ...failure(2), ...passes(200),
      " Test Files  2 failed | 60 passed (62)", "      Tests  2 failed | 600 passed (602)",
    ]);
    for (const id of [1, 2]) {
      expect(result.text).toContain(`FAIL src/broken-${id}.test.ts`);
      expect(result.text).toContain(`AssertionError: expected ${id} to be ${id + 1}`);
      expect(result.text).toContain(`stdout | src/broken-${id}.test.ts`);
    }
    expect(result.text).toContain("- Expected");
    expect(result.text).toContain("+ Received");
    expect(result.text).toContain("15|   .toBe(2);");
    expect(result.text).toContain("logged decisive diagnostic context");
    expect(result.text.match(/    at frame/g)).toHaveLength(18); // source-frame line also consumes a stack slot
    expect(result.text).not.toContain("✓");
    expect(result.text.length).toBeLessThan(3_000);
  });

  it("filters jest pass files while retaining its full failure block and summary", () => {
    const result = filtered("jest", [
      ...repeat("PASS src/example-$i.test.js (0.03 s)"),
      "FAIL src/broken.test.js", "  ● adds numbers", "    expect(received).toBe(expected)",
      "    Expected: 3", "    Received: 2", "    console.log", "      user console evidence",
      "      7 | expect(add(1, 1)).toBe(3);", "    at Object.<anonymous> (src/broken.test.js:7:1)",
      "Test Suites: 1 failed, 100 passed, 101 total", "Tests: 1 failed, 100 passed, 101 total", "Time: 1.25 s",
    ]);
    expect(result.text).not.toContain("PASS src/");
    expect(result.text).toContain("● adds numbers");
    expect(result.text).toContain("user console evidence");
    expect(result.text).toContain("Expected: 3");
    expect(result.text).toContain("Test Suites:");
  });

  it("filters pytest dotted progress and preserves traceback, captured stdout and assertion code", () => {
    const result = filtered("pytest", [
      ...repeat("test_example_$i.py ............ [ 10%]"),
      "=================================== FAILURES ===================================",
      "____________________________ test_add ____________________________",
      "    def test_add():", ">       assert add(1, 1) == 3", "E       assert 2 == 3",
      "test_add.py:4: AssertionError", "----------------------------- Captured stdout call -----------------------------",
      "debug value = 2", "=========================== short test summary info ============================",
      "FAILED test_add.py::test_add - assert 2 == 3", "========================= 1 failed, 100 passed in 0.20s =========================",
    ]);
    expect(result.text).not.toContain("test_example_0.py");
    expect(result.text).toContain("assert add(1, 1) == 3");
    expect(result.text).toContain("debug value = 2");
    expect(result.text).toContain("1 failed, 100 passed");
  });

  it("drops go package pass timings, keeps failure output and the final result", () => {
    const result = filtered("go test ./...", [
      ...repeat("ok example.org/pkg$i 0.023s"),
      "--- FAIL: TestAdd (0.00s)", "    add_test.go:12: got 2; expected 3", "panic: decisive panic",
      "FAIL example.org/broken 0.003s", "FAIL",
    ]);
    expect(result.text).not.toContain("ok example.org/pkg0");
    expect(result.text).toContain("got 2; expected 3");
    expect(result.text).toContain("panic: decisive panic");
    expect(result.text).toContain("FAIL example.org/broken");
    const success = filtered("go test ./...", repeat("ok example.org/pkg$i 0.023s"));
    expect(success.text).toBe("ok example.org/pkg99 0.023s");
  });

  it("drops cargo passing tests and retains failure details and the aggregate result", () => {
    const result = filtered("cargo test", [
      "running 101 tests", ...repeat("test module::test_$i ... ok"),
      "test module::broken ... FAILED", "failures:", "---- module::broken stdout ----",
      "thread 'module::broken' panicked at src/lib.rs:12:9:", "assertion `left == right` failed", "  left: 2", " right: 3",
      "test result: FAILED. 100 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s",
    ]);
    expect(result.text).not.toContain("test module::test_0");
    expect(result.text).toContain("left: 2");
    expect(result.text).toContain("panicked at src/lib.rs");
    expect(result.text).toContain("test result: FAILED.");
  });

  it.each([
    ["mocha", repeat("  ✓ passes test $i").concat(["  100 passing (20ms)"])],
    ["node --test", repeat("ok $i - passes test").concat(["# tests 100", "# pass 100", "# fail 0"])],
  ])("reduces %s output", (command, lines) => {
    const result = filtered(command, lines);
    expect(result.text).not.toContain("passes test");
    expect(result.omittedLines).toBe(100);
  });

  it("classifies by content when the bash command invokes a project script", () => {
    expect(filtered("npm run check", [...passes(100), ...vitestSummary]).text).toBe(vitestSummary.join("\n"));
    expect(filtered("npm run check", [...repeat(" ✓ passes test $i"), "100 passing (20ms)"]).text).toContain("100 passing");
    expect(filtered("./test-script.sh", repeat("ok example.org/pkg$i 0.023s")).text).toBe("ok example.org/pkg99 0.023s");
  });

  it("never drops diagnostics disguised as passing test lines", () => {
    const result = filtered("vitest run", [...passes(100), " ✓ handles error and panic safely", "Warning: optional configuration absent", ...vitestSummary]);
    expect(result.text).toContain("✓ handles error and panic safely");
    expect(result.text).toContain("Warning: optional configuration absent");
  });

  it("keeps progress-like console output attached to failures", () => {
    const result = filtered("vitest run", [
      ...passes(100), "FAIL src/broken.test.ts", "stdout | src/broken.test.ts", " ✓ logged successful intermediate step",
      "Expected: 3", "Received: 2", ...passes(100), "Tests 1 failed | 200 passed",
    ]);
    expect(result.text).toContain("✓ logged successful intermediate step");
    expect(result.text).not.toContain("✓ src/example-");
  });
});

describe("compiler and linter reductions", () => {
  it("collapses duplicate plain tsc errors with up to five locations and indented continuations", () => {
    const result = filtered("tsc --noEmit", [
      ...repeat("src/example-$i.ts(12,3): error TS2322: Type 'number' is not assignable to type 'string'.", 80),
      "  The expected type comes from property 'name'.", "src/other.ts(7,1): error TS2339: Property 'x' does not exist.", "Found 81 errors.",
    ]);
    expect(result.text).toContain("80 occurrences");
    expect(result.text).toContain("src/example-4.ts:12:3");
    expect(result.text).not.toContain("src/example-5.ts");
    expect(result.text).toContain("The expected type comes from property 'name'.");
    expect(result.text).toContain("src/other.ts(7,1): error TS2339");
    expect(result.text).toContain("Found 81 errors.");
  });

  it("drops ANSI pretty tsc source/underline frames while preserving messages and error-bearing frames", () => {
    const lines = repeat("src/example-$i.ts:12:3 - \x1b[91merror\x1b[0m TS2322: Wrong type.", 30)
      .flatMap((error) => [error, "", "12 const value = 3;", "   ~~~~~~~~~~~", "  Type 'number' is incompatible.", ""]);
    lines.push("77 const error = 1;", "Found 30 errors in 30 files.");
    const result = filtered("tsc --pretty", lines);
    expect(result.text).toContain("TS2322: Wrong type. (30 occurrences;");
    expect(result.text).toContain("Type 'number' is incompatible.");
    expect(result.text).not.toContain("12 const value");
    expect(result.text).not.toContain("~~~~~~~~~~~");
    expect(result.text).toContain("77 const error = 1;");
    expect(result.text).toContain("Found 30 errors");
  });

  it("retains eslint errors with file headers and collapses warnings by rule with three locations", () => {
    const result = filtered("eslint .", [
      "/repo/src/first.ts", ...repeat("  $i:3  warning  'unused' is defined but never used  no-unused-vars", 80),
      "  90:7  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any", "",
      "/repo/src/second.ts", "  1:1  error  Unexpected console statement  no-console",
      "✖ 82 problems (2 errors, 80 warnings)",
    ]);
    expect(result.text).toContain("/repo/src/first.ts\n  90:7  error");
    expect(result.text).toContain("/repo/src/second.ts\n  1:1  error");
    expect(result.text).toContain("warning no-unused-vars: 80 occurrences");
    expect(result.text).toContain("/repo/src/first.ts:2:3");
    expect(result.text).not.toContain("/repo/src/first.ts:3:3");
    expect(result.text).toContain("✖ 82 problems");
  });

  it("collapses biome warnings but keeps error code frames", () => {
    const warnings = repeat("src/file-$i.ts:2:1 lint/style/useConst ━━━━━━━", 80)
      .flatMap((header) => [header, "  ! Use const instead of let.", "  > 2 │ let value = 3;", ""]);
    const result = filtered("biome check", [
      ...warnings, "src/broken.ts:3:1 lint/correctness/noUnusedVariables ━━━━━━━",
      "  × Unused variable.", "  > 3 │ const value = 3;", "Checked 81 files in 10ms. Found 1 error.",
    ]);
    expect(result.text).toContain("warning lint/style/useConst: 80 occurrences");
    expect(result.text).toContain("src/broken.ts:3:1");
    expect(result.text).toContain("const value = 3;");
    expect(result.text).toContain("Checked 81 files");
  });
});

describe("grep grouping and generic fallback", () => {
  it("groups match and context lines including dash/colon paths and Pi notices", () => {
    const path = "very-long-directory/src/file-with-dashes:part.ts";
    const text = [`${path}-10- before`, `${path}:11: match:99: text`, `${path}-12- after`, "", "[3 matches limit reached. Use limit=6 for more, or refine pattern]"].join("\n");
    const result = groupGrep(text)!;
    expect(result.text).toBe(`${path}\n  10- before\n  11: match:99: text\n  12- after\n\n[3 matches limit reached. Use limit=6 for more, or refine pattern]`);
  });

  it.each(["long/repository/path/file.ts", "long/repository/path/file-12-part:34.ts"])("round-trips context containing match-looking source delimiters: %s", path => {
    const lines = [`${path}-7-   const m = "a:1: b";`, `${path}:8: match -9- context-looking`, `${path}-9- trailing`];
    const result = groupGrep(lines.join("\n"))!;
    expect(result).toBeDefined();
    const [header, ...rows] = result.text.split("\n");
    const expanded = rows.map(row => `${header}${row.trimStart().replace(/^(\d{1,9})([:-]) /, "$2$1$2 ")}`);
    expect(expanded).toEqual(lines);
  });

  it("declines t5 ambiguous paths and context-only paths instead of guessing", () => {
    const lines = repeat('src/some/long/path/a-1- b.ts:$i: const m = "x";', 20);
    lines.push('src/some/long/path/c.ts-7-   const m = "a:1: b";', 'src/some/long/path/c.ts:8: ok');
    expect(groupGrep(lines.join("\n"))).toBeUndefined();
    expect(groupGrep(repeat("long/repository/path/orphan.ts-$i- context only", 20).join("\n"))).toBeUndefined();
  });


  it("requires every grep line to parse and at least 15 percent character savings", () => {
    expect(groupGrep("a:1: x\na:2: x")).toBeUndefined();
    expect(groupGrep("long/path/to/file.ts:1: x\nunrecognized log line")).toBeUndefined();
    expect(groupGrep(repeat("long/path/to/file.ts:$i: x", 20).join("\n"))).toBeDefined();
  });

  it("keeps middle diagnostics with original line numbers in a bounded head/middle/tail preview", () => {
    const lines = repeat("normal output row $i", 600);
    lines[310] = "Error: decisive middle failure";
    const result = genericPreview(lines.join("\n"))!;
    expect(result.text).toContain("[L1] normal output row 0");
    expect(result.text).toContain("[L30] normal output row 29");
    expect(result.text).not.toContain("[L31]");
    expect(result.text).toContain("[L311] Error: decisive middle failure");
    expect(result.text).toContain("[L541] normal output row 540");
    expect(result.text).toContain("[L600] normal output row 599");
    expect(result.omittedLines).toBe(509);
    expect(result.text.length).toBeLessThan(10_000);
  });

  it("spills 600 bash lines with excess middle diagnostics to a bounded preview and full artifact", async () => {
    const cwd = await tempWorkspace();
    const lines = repeat("ordinary line $i", 600);
    for (let i = 100; i < 150; i++) lines[i] = `Error: independent failure ${i}`;
    const text = lines.join("\n");
    const preview = genericPreview(text)!;
    expect(preview.text.length).toBeLessThan(10_500);
    expect(preview.text.match(/Error:/g)).toHaveLength(40);
    expect(preview.reason).toContain("10 more matching diagnostic lines omitted; grep the artifact");
    const result = await spillToolResult({ toolName: "bash", content: [{ type: "text", text }] }, cwd);
    const output = (result!.content[0] as { text: string }).text;
    expect(output.split("\n\n[Output ")[0]!.length).toBeLessThan(10_500);
    expect(output).toContain(preview.reason);
    const path = /saved to (\S+\.txt)/.exec(output)![1]!;
    expect(await readFile(join(cwd, path), "utf8")).toBe(text);
  });

  it("prioritizes errors over warnings within the middle budget and displays them in source order", () => {
    const lines = repeat("ordinary line $i", 600);
    for (let i = 100; i < 140; i++) lines[i] = `Warn: optional setting ${i}`;
    for (let i = 200; i < 235; i++) lines[i] = `Error: independent failure ${i}`;
    const result = genericPreview(lines.join("\n"))!;
    expect(result.text.match(/Error:/g)).toHaveLength(35);
    expect(result.text.match(/Warn:/g)).toHaveLength(5);
    expect(result.text).toContain("[L105] Warn: optional setting 104");
    expect(result.text).not.toContain("[L106]");
    expect(result.text).toContain("[L235] Error: independent failure 234");
    expect(result.text.indexOf("[L101]")).toBeLessThan(result.text.indexOf("[L201]"));
    expect(result.reason).toContain("35 more matching diagnostic lines omitted");
  });

  it("fills the diagnostic character budget with shorter lines after an error cannot fit", () => {
    const lines = repeat("ordinary line $i", 600);
    for (let i = 100; i < 103; i++) lines[i] = `Error: ${"x".repeat(2_000)}`;
    lines[200] = "Warn: short warning";
    const result = genericPreview(lines.join("\n"))!;
    expect(result.text.match(/Error:/g)).toHaveLength(2);
    expect(result.text).toContain("…[+1007 chars]");
    expect(result.text).toContain("[L201] Warn: short warning");
    expect(result.reason).toContain("1 more matching diagnostic lines omitted");
    expect(result.text.length).toBeLessThan(10_500);
  });

  it("still spills 600 lines when the preview saves less than twenty percent", async () => {
    const cwd = await tempWorkspace();
    const lines = repeat("n", 600);
    for (let i = 0; i < 30; i++) lines[i] = "h".repeat(91);
    for (let i = 540; i < 600; i++) lines[i] = "t".repeat(57);
    for (let i = 40; i < 440; i += 10) lines[i] = `Error: ${"e".repeat(58)}`;
    const text = lines.join("\n");
    expect(text.length).toBeLessThan(12_000);
    const preview = genericPreview(text)!;
    expect(preview.text.length).toBeGreaterThan(text.length * 0.8);
    expect(preview.text.length).toBeLessThan(12_000);
    const result = await spillToolResult({ toolName: "bash", content: [{ type: "text", text }] }, cwd);
    const output = (result!.content[0] as { text: string }).text;
    expect(output).toContain(preview.text);
    expect(output).toContain("Output truncated");
    const path = /saved to (\S+\.txt)/.exec(output)![1]!;
    expect(await readFile(join(cwd, path), "utf8")).toBe(text);
  });

  it("does not apply a generic preview below the spill threshold, even for unparseable specialized output", async () => {
    const text = repeat("odd runner output row $i", 100).join("\n");
    expect(genericPreview(text)).toBeUndefined();
    expect(filterOutput("bash", text, { command: "vitest run" })).toBeUndefined();
    expect(await spillToolResult({ toolName: "bash", input: { command: "vitest run" }, content: [{ type: "text", text }] }, await tempWorkspace())).toBeUndefined();
  });

  it("falls back when specialized output cannot be parsed", () => {
    const text = repeat("odd runner output row $i", 600).join("\n");
    expect(filterOutput("bash", text, { command: "vitest run" })?.text).toContain("[L1]");
  });

  it("leaves small outputs and reductions below twenty percent unchanged", () => {
    expect(filterOutput("bash", "PASS file.test.js\nTests: 1 passed", { command: "jest" })).toBeUndefined();
    const lines = [...repeat("Error: different failure $i", 60), ...passes(2), "Tests: 60 failed"];
    expect(filterOutput("bash", lines.join("\n"), { command: "jest" })).toBeUndefined();
  });
});

describe("filter artifacts and event preservation", () => {
  it.each(["Command exited with code 3", "Command aborted", "Command timed out after 10 seconds"])("preserves %s, error state and images while omitting structured content", async (status) => {
    const cwd = await tempWorkspace();
    const text = [...passes(100), ...vitestSummary, "", status].join("\n");
    const result = await spillToolResult({
      toolName: "bash", input: { command: "vitest run" }, isError: true, structuredContent: { output: text },
      content: [{ type: "text", text }, { type: "image", data: "dummy", mimeType: "image/png" }],
    }, cwd);
    const output = (result!.content[0] as { text: string }).text;
    expect(output).toContain(status);
    expect(output).toContain("101 lines omitted");
    expect(result!.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    expect(result!.content[1]!.type).toBe("image");
    const path = /saved to (\S+\.txt)/.exec(output)![1]!;
    expect(await readFile(join(cwd, path), "utf8")).toBe(text);
    expect(await readFile(join(cwd, ".orche/artifacts/.gitignore"), "utf8")).toContain("*");
    expect(await readFile(join(cwd, ".orche/artifacts/.ignore"), "utf8")).toContain("*");
    expect(output.endsWith("inspect it.]")).toBe(true);
  });

  it("recovers full bash output and carries the separate Pi status line", async () => {
    const cwd = await tempWorkspace();
    const text = [...passes(600), ...failure(1), ...vitestSummary].join("\n");
    const file = join(cwd, "full-output.txt");
    await writeFile(file, text);
    const result = await spillToolResult({
      toolName: "bash", input: { command: "vitest run" }, isError: true, details: { fullOutputPath: file },
      content: [{ type: "text", text: "Pi tail only\n\nCommand exited with code 1" }],
    }, cwd);
    const output = (result!.content[0] as { text: string }).text;
    expect(output).toContain("FAIL src/broken-1.test.ts");
    expect(output).toContain("Command exited with code 1");
    const path = /saved to (\S+\.txt)/.exec(output)![1]!;
    expect(await readFile(join(cwd, path), "utf8")).toBe(text);
  });

  it("saves grouped grep originals, exempts read and does not specialize other tools", async () => {
    const cwd = await tempWorkspace();
    const text = repeat("long/repository/path/to/file.ts:$i: match", 20).join("\n");
    const result = await spillToolResult({ toolName: "grep", content: [{ type: "text", text }] }, cwd);
    const output = (result!.content[0] as { text: string }).text;
    expect(output).toContain("repeated grep paths grouped");
    const path = /saved to (\S+\.txt)/.exec(output)![1]!;
    expect(await readFile(join(cwd, path), "utf8")).toBe(text);
    const runner = [...passes(100), ...vitestSummary].join("\n");
    expect(await spillToolResult({ toolName: "orche_task", content: [{ type: "text", text: runner }] }, cwd)).toBeUndefined();
    expect(await spillToolResult({ toolName: "read", content: [{ type: "text", text: "huge\n".repeat(3000) }] }, cwd)).toBeUndefined();
  });
});


describe("bounded filter analysis", () => {
  const adversarial = [
    ["5 MB single line", "x".repeat(5 * 1024 * 1024)],
    ["spaces", " ".repeat(200_000) + "x"],
    ["lint spaces", "1:1 error x" + " ".repeat(200_000)],
    ["digits", "a:" + "1".repeat(200_000)],
    ["passed words", "passed ".repeat(50_000)],
    ["unterminated ANSI", "\x1b[" + "0".repeat(200_000)],
  ];
  it.each(adversarial)("filters %s in under 1.5 seconds", (_name, text) => {
    for (const command of ["vitest", "eslint", "tsc", "ls"]) {
      const start = performance.now();
      const result = filterOutput("bash", text!, { command });
      expect(performance.now() - start).toBeLessThan(1_500);
      expect((result ?? genericPreview(text!))!.text.length).toBeLessThan(10_500);
    }
  });

  it("clips specialized analysis/output to 2000 chars before regexes and strips ANSI once", () => {
    const original = `\x1b[31mError: ${"x".repeat(20_000)}\x1b[0m`;
    const result = filtered("vitest", [...passes(100), original, ...vitestSummary]);
    expect(result.text).toContain(`…[+${original.length - 2_000} chars]`);
    expect(result.text).not.toContain("\x1b[");
    expect(result.text.length).toBeLessThan(2_500);
  });

  it("skips specialized filters above 2 MB, including multibyte text", () => {
    for (const text of [passes(60_000).join("\n"), repeat(" ✓ " + "한".repeat(700), 1_100).join("\n")]) {
      const result = filterOutput("bash", text, { command: "vitest" })!;
      expect(result.text).toContain("[L1]");
      expect(result.reason).toContain("truncated");
      expect(result.text.length).toBeLessThan(10_500);
    }
  });

  it("bounds 300 failing vitest summaries using original artifact line numbers", async () => {
    const cwd = await tempWorkspace();
    const text = [...passes(400), ...Array.from({ length: 300 }, (_, i) => [
      ` FAIL src/broken-${i}.test.ts`, `AssertionError: expected ${i} ${"x".repeat(120)}`, "    at frame (src/test.ts:1:1)",
    ]).flat(), " Tests 300 failed"].join("\n");
    const reduction = filterOutput("bash", text, { command: "vitest" })!;
    expect(reduction.text.length).toBeLessThan(10_500);
    expect(reduction.text).toContain("[L401]  FAIL src/broken-0.test.ts");
    expect(reduction.reason).toContain("specialized summary was too large");
    expect(reduction.reason).toContain("more matching diagnostic lines omitted");
    const result = await spillToolResult({ toolName: "bash", input: { command: "vitest" }, content: [{ type: "text", text }] }, cwd);
    const output = (result!.content[0] as { text: string }).text;
    expect(output.split("\n\n[Output ")[0]!.length).toBeLessThan(10_500);
    const path = /saved to (\S+\.txt)/.exec(output)![1]!;
    expect(await readFile(join(cwd, path), "utf8")).toBe(text);
  });

  it("counts gap markers and repeated status lines within the generic bound", () => {
    const lines = repeat("ordinary $i " + "x".repeat(200), 2_000);
    for (let i = 50; i < 1950; i += 10) lines[i] = "Error: " + "x".repeat(68);
    for (let i = 500; i < 1500; i++) lines[i] = "Command exited with code 1";
    expect(genericPreview(lines.join("\n"))!.text.length).toBeLessThan(10_500);
  });
  it("keeps a clipped vitest pass-looking line whose tail contains a diagnostic (t7 case 1)", async () => {
    const hidden = ` ✓ x ${"a".repeat(2_500)} FATAL ERROR hidden`;
    const text = [...passes(100), hidden, ...passes(100), " Test Files 200 passed (200)"].join("\n");
    const reduction = filterOutput("bash", text, { command: "vitest" })!;
    expect(reduction.text).toContain(hidden.slice(0, 2_000));
    expect(reduction.text).toContain(`…[+${hidden.length - 2_000} chars]`);
    expect(reduction.reason).toContain("1 long lines clipped at 2,000 chars");
    const cwd = await tempWorkspace();
    const result = await spillToolResult({ toolName: "bash", input: { command: "vitest" }, content: [{ type: "text", text }] }, cwd);
    const output = (result!.content[0] as { text: string }).text;
    expect(output).toContain(reduction.text);
    expect(output).toContain(reduction.reason);
    const path = /saved to (\S+\.txt)/.exec(output)![1]!;
    expect(await readFile(join(cwd, path), "utf8")).toBe(text);
  });

  it("selects a generic diagnostic beyond char 2000 using its artifact line number (t7 case 1b)", () => {
    const lines = repeat("line $i", 400); lines[200] = "x".repeat(3_000) + " Error: boom";
    const result = genericPreview(lines.join("\n"))!;
    expect(result.text).toContain("[L201] " + "x".repeat(1_000));
    expect(result.reason).toContain("1 long lines clipped at 2,000 chars");
    expect(result.omittedLines).toBe(309);
  });

  it.each(["error", "FAIL", "warn", "exception", "panic", "traceback", "✗", "×"])("keeps hidden %s diagnostics in specialized test output", word => {
    const hidden = ` ✓ x ${"a".repeat(2_500)} ${word}`;
    const result = filtered("vitest", [...passes(100), hidden, ...vitestSummary]);
    expect(result.text).toContain(hidden.slice(0, 2_000));
    expect(result.reason).toContain("1 long lines clipped at 2,000 chars");
  });

  it("prioritizes hidden errors over warnings and counts omitted long diagnostics", () => {
    const lines = repeat("line $i", 600);
    for (let i = 100; i < 110; i++) lines[i] = "w".repeat(3_000) + " Warning: tail";
    for (let i = 200; i < 210; i++) lines[i] = "e".repeat(3_000) + " Error: tail";
    const result = genericPreview(lines.join("\n"))!;
    expect(result.text).toContain("[L201] " + "e".repeat(1_000));
    expect(result.text).not.toContain("[L101]");
    expect(result.reason).toContain("18 more matching diagnostic lines omitted");
    expect(result.reason).toContain("20 long lines clipped at 2,000 chars");
  });

  it.each(["tsc", "eslint", "biome"])("keeps long diagnostic lines instead of collapsing them in %s", command => {
    const noise = command === "tsc" ? repeat("src/a$i.ts(1,1): error TS1: duplicate", 100)
      : repeat("  1:1 warning unused no-unused-vars", 100);
    const hidden = command === "biome" ? `src/a.ts:1:1 lint/x WARNING ${"a".repeat(2_500)} ERROR tail`
      : command === "eslint" ? `  1:1 warning ${"a".repeat(2_500)} ERROR tail rule`
      : `src/b.ts(1,1): error TS1: ${"a".repeat(2_500)} ERROR tail`;
    const result = filtered(command, [...noise, hidden]);
    expect(result.text).toContain(hidden.slice(0, 2_000));
    expect(result.reason).toContain("1 long lines clipped at 2,000 chars");
  });

  it("keeps distinct clipped TypeScript errors and their message continuations", () => {
    const head = `src/b.ts(1,1): error TS1: ${"a".repeat(2_500)}`;
    const result = filtered("tsc", [
      ...repeat("src/a$i.ts(1,1): error TS1: duplicate", 100),
      `${head} ERROR first tail`, "  First continuation.", `${head} ERROR other tail`, "  Other continuation.",
    ]);
    expect(result.text.split(head.slice(0, 2_000))).toHaveLength(3);
    expect(result.text).toContain("First continuation.");
    expect(result.text).toContain("Other continuation.");
    expect(result.reason).toContain("2 long lines clipped at 2,000 chars");
  });


  it("reports all clipped lines even when their full word scan finds no diagnostic", () => {
    const result = genericPreview("x".repeat(5 * 1024 * 1024))!;
    expect(result.reason).toContain("1 long lines clipped at 2,000 chars");
    expect(result.text.length).toBeLessThan(10_500);
  });

});
