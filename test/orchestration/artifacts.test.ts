import { describe, expect, it } from "vitest";
import { classifyNewFile } from "../../src/orchestration/artifacts.js";
import { parseRouteConfig, RouteConfigError } from "../../src/orchestration/routing.js";
import { describeProgress } from "../../src/extension/progress.js";

const directories = ["coverage", ".nyc_output", ".pytest_cache", "__pycache__", ".mypy_cache", ".ruff_cache", ".cache", "node_modules", "dist", "build", "out", "target", ".turbo", ".next", ".vite", "__snapshots__"];
const files = [".eslintcache", "app.tsbuildinfo", "test.log", "mod.pyc", "a.orig", "a.rej", "a.tmp", "a.swp", ".DS_Store", "junit.xml", "junit-results.xml", "test.lcov", "coverage.json", "coverage-final.json", "report.json", "test-report.html"];

describe("classifyNewFile", () => {
  it.each(directories)("classifies output under %s at any depth", dir => {
    expect(classifyNewFile(`${dir}/output.ts`)).toBe("artifact");
    expect(classifyNewFile(`packages/app/${dir}/nested/output.json`)).toBe("artifact");
    expect(classifyNewFile(`packages\\app\\${dir}\\output.py`)).toBe("artifact");
    expect(classifyNewFile(`${dir}-source/output.ts`)).toBe("source");
    expect(classifyNewFile(dir)).toBe("source");
  });
  it.each(files)("classifies generated basename %s at any depth", file => {
    expect(classifyNewFile(file)).toBe("artifact");
    expect(classifyNewFile(`packages/app/${file}`)).toBe("artifact");
  });
  it.each([
    "new.ts", "new.js", "new.mjs", "new.cjs", "new.tsx", "new.jsx", "new.py", "new.go", "new.rs", "new.java",
    "config.json", "config.yaml", "config.yml", "config.toml", "notes.md", "new.sh", "new.sql", "new.css", "new.html",
    "stray.txt", ".env", ".env.local", ".env.log", ".npmrc", ".gitignore", ".eslintrc.json", "junit.json", "report.xml", "coverage.ts",
  ])("defaults %s to source", file => {
    expect(classifyNewFile(file)).toBe("source");
    expect(classifyNewFile(`src/nested/${file}`)).toBe("source");
  });
  it("matches only explicit extra concrete paths, directory areas and extension globs", () => {
    const extra = ["notes.md", "generated/", "reports/**", "*.trace", "./scratch/result.json", "windows\\output/"];
    for (const file of ["notes.md", "generated/nested/new.ts", "reports/deep/config.json", "test.trace", "pkg/test.trace", "scratch/result.json", "windows/output/x.txt"])
      expect(classifyNewFile(file, extra)).toBe("artifact");
    for (const file of ["pkg/notes.md", "generated-other/new.ts", "pkg/generated/new.ts", "reports-other/config.json", "test.trace.ts", "scratch/other.json"])
      expect(classifyNewFile(file, extra)).toBe("source");
    expect(classifyNewFile("coverage/new.ts", [])).toBe("artifact");
    expect(classifyNewFile("notes.md", ["**/*.md"])).toBe("source");
    expect(classifyNewFile(".env", [".env"])).toBe("artifact");
  });
  it("explains creation and both escape hatches in progress without changing existing-file wording", () => {
    const base = { type: "ownership_violation" as const, timestamp: 0, agentId: "A1", file: "x.ts", ownerTaskIds: [], via: "workspace" as const };
    const progress = describeProgress({ ...base, created: true });
    expect(progress).toContain("created unowned source file x.ts");
    expect(progress).toContain("Own the path in the backlog");
    expect(progress).toContain("audit.artifacts");
    expect(describeProgress(base)).toBe("ownership violation: x.ts changed during work by A1");
  });
});

describe("audit config", () => {
  it("accepts optional/empty settings and valid extra patterns", () => {
    expect(parseRouteConfig({ routes: {} }).audit).toBeUndefined();
    expect(parseRouteConfig({ routes: {}, audit: {} }).audit).toEqual({});
    expect(parseRouteConfig({ routes: {}, audit: { artifacts: [] } }).audit).toEqual({ artifacts: [] });
    const artifacts = ["notes.md", "generated/", "reports/**", "*.trace", "./scratch/result.json"];
    const config = parseRouteConfig({ routes: {}, audit: { artifacts } });
    expect(config.audit).toEqual({ artifacts });
    expect(classifyNewFile("notes.md", config.audit?.artifacts)).toBe("artifact");
  });
  it.each([
    null, false, [], "output", { unknown: [] }, { artifacts: "*.log" }, { artifacts: null },
    ...[1, null, "", " ", " notes.md", "notes.md ", "**/*.md", "src/*.json", "file?.txt", "[ab].txt", "{a,b}.txt", "!notes.md", "#comment", "/tmp/output", "C:\\output", "../notes.md", "src/../notes.md", ".", "./", "dir/**/*", "dir/**/file", "*", "notes\n.md"].map(pattern => ({ artifacts: [pattern] })),
  ])("rejects invalid audit settings %j with location", audit => {
    expect(() => parseRouteConfig({ routes: {}, audit })).toThrow(RouteConfigError);
    expect(() => parseRouteConfig({ routes: {}, audit })).toThrow(/config\.audit/);
  });
});
