import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../../src/extension/bash-policy.js";

// CLI acceptance and policy permission are separate assertions. No network,
// staging or commits: even execution-hook fixtures run only inside os.tmpdir().
function binary(name: string): string | undefined {
  const paths = [...(process.env.PATH ?? "").split(delimiter).map(p => join(p, name))];
  if (name === "tsc") paths.unshift(resolve("node_modules/.bin/tsc"));
  return paths.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
}
const tsc = binary("tsc"), node = binary("node"), git = binary("git"), rg = binary("rg");
function fixture(check: (cwd: string, run: (bin: string, args: string[]) => ReturnType<typeof spawnSync>) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "orche-policy-cli-"));
  const run = (bin: string, args: string[]) => spawnSync(bin, args, {
    cwd, encoding: "utf8", timeout: 2_000,
    env: { ...process.env, NODE_OPTIONS: "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", RIPGREP_CONFIG_PATH: "" },
  });
  try { check(cwd, run); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

describe("shell allowlist alignment with installed CLIs (skip absent binaries)", () => {
  it.skipIf(!tsc)("tsc accepts separate boolean values, rejects =true, and false really emits", () => fixture((cwd, run) => {
    writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], lib: ["es5"], skipLibCheck: true }, files: ["x.ts"] }));
    writeFileSync(join(cwd, "x.ts"), "const x: number = 1;\n");
    for (const args of [["--noEmit"], ["--noEmit", "true"]]) {
      const result = run(tsc!, args);
      expect({ code: result.status, out: result.stdout, err: result.stderr }).toEqual({ code: 0, out: "", err: "" });
      expect(existsSync(join(cwd, "x.js"))).toBe(false);
      expect(classifyBash(`tsc ${args.join(" ")}`)).toEqual({ allowed: true });
    }
    const invalid = run(tsc!, ["--noEmit=true"]);
    expect(invalid.status).toBe(1);
    expect(String(invalid.stdout)).toContain("Unknown compiler option '--noEmit=true'");
    expect(classifyBash("tsc --noEmit=true")).toMatchObject({ allowed: false, category: "unsupported" });
    const emit = run(tsc!, ["--noEmit", "false"]);
    expect({ code: emit.status, out: emit.stdout, err: emit.stderr }).toEqual({ code: 0, out: "", err: "" });
    expect(existsSync(join(cwd, "x.js"))).toBe(true);
    expect(classifyBash("tsc --noEmit false")).toMatchObject({ allowed: false, category: "mutation" });
  }));

  it.skipIf(!node)("node --test executes data-URL imports and separate -r preloads; policy blocks both", () => fixture((cwd, run) => {
    writeFileSync(join(cwd, "x.test.cjs"), "require('node:test')('tiny', () => {});\n");
    writeFileSync(join(cwd, "x.cjs"), "console.log('PRELOAD_EXECUTED');\n");
    const plain = run(node!, ["--test", "x.test.cjs"]);
    expect(plain.status, String(plain.stderr)).toBe(0);
    expect(classifyBash("node --test x.test.cjs")).toEqual({ allowed: true });
    const flag = "--import=data:text/javascript,console.log('DATA_EXECUTED')";
    const imported = run(node!, ["--test", flag, "x.test.cjs"]);
    expect(imported.status, String(imported.stderr)).toBe(0);
    expect(String(imported.stdout)).toContain("DATA_EXECUTED");
    expect(classifyBash(`node --test "${flag}" x.test.cjs`)).toMatchObject({ allowed: false, category: "unsupported" });
    const required = run(node!, ["--test", "-r", "./x.cjs", "x.test.cjs"]);
    expect(required.status, String(required.stderr)).toBe(0);
    expect(String(required.stdout)).toContain("PRELOAD_EXECUTED");
    expect(classifyBash("node --test -r ./x.cjs x.test.cjs")).toMatchObject({ allowed: false });
  }));

  it.skipIf(!git || process.platform === "win32")("git grep -O executes a pager, diff -O reads an order file, and log --output writes even on failure", () => fixture((cwd, run) => {
    expect(run(git!, ["init", "--quiet"]).status).toBe(0);
    writeFileSync(join(cwd, "x.txt"), "pattern\n");
    writeFileSync(join(cwd, "orderfile"), "x.txt\n");
    writeFileSync(join(cwd, "pager.sh"), '#!/bin/sh\necho PAGER_EXECUTED\ncat "$@"\n', { mode: 0o700 });
    const pager = run(git!, ["grep", "--no-index", "-O./pager.sh", "pattern", "x.txt"]);
    expect(pager.status, String(pager.stderr)).toBe(0);
    expect(String(pager.stdout)).toContain("PAGER_EXECUTED");
    expect(classifyBash("git grep --no-index -O./pager.sh pattern x.txt")).toMatchObject({ allowed: false, category: "unsupported" });
    expect(run(git!, ["diff", "-Oorderfile"]).status).toBe(0);
    expect(classifyBash("git diff -Oorderfile")).toEqual({ allowed: true });
    const log = run(git!, ["log", "--output=log.txt"]);
    expect(log.status).toBe(128); // An unborn branch; still creates the output file.
    expect(String(log.stderr)).toContain("does not have any commits");
    expect(existsSync(join(cwd, "log.txt"))).toBe(true);
    expect(classifyBash("git log --output=log.txt")).toMatchObject({ allowed: false, category: "mutation" });
  }));

  it.skipIf(!rg || process.platform === "win32")("rg pre/hostname hooks execute, but pre-glob alone only selects files", () => fixture((cwd, run) => {
    writeFileSync(join(cwd, "x.txt"), "pattern\n");
    writeFileSync(join(cwd, "pre.sh"), '#!/bin/sh\necho yes > pre-executed\ncat "$1"\n', { mode: 0o700 });
    writeFileSync(join(cwd, "host.sh"), "#!/bin/sh\necho yes > host-executed\necho localhost\n", { mode: 0o700 });
    for (const [flag, marker] of [["--pre=./pre.sh", "pre-executed"], ["--hostname-bin=./host.sh", "host-executed"]]) {
      const result = run(rg!, [flag!, "pattern", "x.txt"]);
      expect(result.status, String(result.stderr)).toBe(0);
      expect(readFileSync(join(cwd, marker!), "utf8")).toBe("yes\n");
      expect(classifyBash(`rg ${flag} pattern x.txt`)).toMatchObject({ allowed: false, category: "unsupported" });
    }
    expect(run(rg!, ["--pre-glob=*.txt", "pattern", "x.txt"]).status).toBe(0);
    expect(classifyBash("rg --pre-glob='*.txt' pattern x.txt")).toEqual({ allowed: true });
  }));
});
