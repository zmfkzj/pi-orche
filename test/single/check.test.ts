import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedCommand, checkReport, fixPrompt, formatCheck, probePathError, recheck, runCheckCommand, scratchDir, verifierGuard, type Check } from "../../src/single/check.js";

const scratch = scratchDir("T1");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const finding = (extra: Partial<Check["findings"][number]> = {}): Check["findings"][number] => ({ id: "F1", severity: "blocking", kind: "executed", requirement: "R1", claim: "wrong", evidence: "probe fails", probe: `node ${scratch}/a.probe.mjs`, ...extra });
const check = (findings: Check["findings"], extra: Partial<Check> = {}): Check => ({ verdict: findings.some(item => item.severity === "blocking") ? "fail" : "pass", trace: [], findings, checks: [], ...extra });

describe("Verifier", () => {
  it("writes only probe files in its scratch directory", () => {
    expect(probePathError("/w", scratch, ".orche/scratch/T1/a.probe.mjs")).toBeUndefined();
    expect(probePathError("/w", scratch, "/w/.orche/scratch/T1/fixtures/data.json")).toBeUndefined();
    expect(probePathError("/w", scratch, "src/a.mjs")).toContain("may write only probe files inside .orche/scratch/T1/");
    expect(probePathError("/w", scratch, ".orche/scratch/T2/a.probe.mjs")).toContain("may write only probe files");
    expect(probePathError("/w", scratch, ".orche/scratch/T1/a.mjs")).toContain('must contain ".probe."');
    const guard = verifierGuard("/w", scratch);
    expect(guard("edit", { path: "src/a.mjs" })).toContain("never edit the change under review");
    expect(guard("ast_rewrite", {})).toContain("never rewrites code");
    expect(guard("read", { path: "src/a.mjs" })).toBeUndefined();
  });

  it("runs the trusted checks and probe files, nothing else", () => {
    for (const command of ["node --test", "npm test", "pytest -q", `node ${scratch}/a.probe.mjs`, `python3 ${scratch}/b.probe.py --fast`, `cd ${scratch} && node a.probe.mjs`, `npx --no-install tsx ${scratch}/c.probe.ts`, `deno run ${scratch}/d.probe.ts`]) expect(allowedCommand(command, scratch)).toBe(true);
    for (const command of ["node src/a.mjs", `node ${scratch}/a.mjs`, `node ${scratch}/../x.probe.mjs`, `node ${scratch}/sub/a.probe.mjs`, `node ${scratch}/a.probe.mjs; rm -rf src`, `node $(echo x).probe.mjs`, "rm -rf src", "make test"]) expect(allowedCommand(command, scratch)).toBe(false);
    expect(verifierGuard("/w", scratch)("bash", { command: "rm -rf src" })).toContain("Blocked for the Verifier");
  });

  it("requires re-runnable evidence for blocking findings and a matching verdict", () => {
    expect(checkReport(check([finding()]), scratch)).toBeUndefined();
    expect(checkReport(check([finding({ probe: undefined })]), scratch)).toContain("needs probe");
    expect(checkReport(check([finding({ kind: "static", probe: undefined })]), scratch)).toContain("needs quote");
    expect(checkReport(check([finding({ kind: "static", probe: undefined, quote: "must be 2" })]), scratch)).toBeUndefined();
    expect(checkReport(check([finding({ probe: "curl http://x" })]), scratch)).toContain("is not a command orche can re-run");
    expect(checkReport(check([finding()], { verdict: "pass" }), scratch)).toBe("verdict must be fail when a finding is blocking.");
    expect(checkReport(check([finding({ severity: "minor", probe: undefined })], { verdict: "fail" }), scratch)).toBe("verdict must be pass when no finding is blocking.");
    expect(checkReport(check([finding(), finding()]), scratch)).toBe("Duplicate finding id F1.");
  });

  it("re-runs probes and passing checks deterministically", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orche-check-"));
    dirs.push(cwd);
    await mkdir(join(cwd, scratch), { recursive: true });
    await writeFile(join(cwd, scratch, "a.probe.mjs"), "process.exit(0)\n");
    await writeFile(join(cwd, scratch, "b.probe.mjs"), "console.error('still 1'); process.exit(1)\n");
    const verified = check([finding(), finding({ id: "F2", probe: `node ${scratch}/b.probe.mjs` }), finding({ id: "F3", probe: `node ${scratch}/b.probe.mjs` }), finding({ id: "F4", severity: "minor", probe: undefined })],
      { checks: [{ command: `node ${scratch}/a.probe.mjs`, exitCode: 0, summary: "ok" }, { command: "npm test", exitCode: 1, summary: "already failing" }] });
    const result = await recheck(cwd, scratch, verified, new Map([["F3", "the request asks for 1"]]));
    expect(result.findings).toEqual([
      { id: "F1", status: "fixed", detail: "probe exits 0" },
      { id: "F2", status: "open", detail: "probe exits 1: still 1" },
      { id: "F3", status: "disputed", detail: "probe exits 1; the implementer disputes it: the request asks for 1: still 1" },
    ]);
    expect(result.checks.map(item => [item.command, item.exitCode])).toEqual([[`node ${scratch}/a.probe.mjs`, 0]]);
    expect(await runCheckCommand(cwd, scratch, "rm -rf src")).toMatchObject({ exitCode: null, skipped: "not an allowed check or probe command" });
    expect(formatCheck(verified, result)).toEqual([
      `Verifier: fail, 3 blocking, 1 minor; checks: \`node ${scratch}/a.probe.mjs\` pass, \`npm test\` exit 1`,
      "- F1 blocking R1 (executed): wrong → fixed: probe exits 0",
      "- F2 blocking R1 (executed): wrong → open: probe exits 1: still 1",
      "- F3 blocking R1 (executed): wrong → disputed: probe exits 1; the implementer disputes it: the request asks for 1: still 1",
      "- F4 minor R1 (executed): wrong",
      `Recheck (orche, no LLM): \`node ${scratch}/a.probe.mjs\` pass`,
    ]);
  });

  it("sends only blocking findings to the fix round, with their probes", () => {
    const text = fixPrompt("T1", check([finding(), finding({ id: "F2", severity: "minor" })]), scratch);
    expect(text).toContain("fix round for task T1");
    expect(text).toContain(`Re-run: \`node ${scratch}/a.probe.mjs\``);
    expect(text).not.toContain("F2");
    expect(text).toContain('report it in data.disputed as [{"id":"F1","reason":"…"}]');
  });
});
