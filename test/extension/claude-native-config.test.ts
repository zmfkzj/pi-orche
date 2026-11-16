import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverOrcheConfig, loadOrcheConfigFile } from "../../src/extension/config.js";

const dirs: string[] = [];
async function fixture(body: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "orche-claude-native-"));
  dirs.push(dir);
  const path = join(dir, "orche.config.json");
  await writeFile(path, JSON.stringify(body));
  return path;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("claudeNative routing toggle", () => {
  const base = { routes: {}, default: { model: "cliproxyapi/claude-opus-5-5" } };
  it("is automatic by default, even with no config", async () => {
    const path = await fixture(base);
    expect((await loadOrcheConfigFile(path)).claudeNative).toBe(true);
    const agentDir = await mkdtemp(join(tmpdir(), "orche-claude-native-empty-"));
    dirs.push(agentDir);
    const cwd = join(agentDir, "project");
    const found = await discoverOrcheConfig({ agentDir, cwd, projectTrusted: false, session: { model: "cliproxyapi/claude-opus-5-5" } });
    expect(found.claudeNative).toBe(true);
  });
  it("respects an explicit opt-out at the selected config scope", async () => {
    const path = await fixture({ ...base, claudeNative: false });
    expect((await loadOrcheConfigFile(path)).claudeNative).toBe(false);
  });
  it("rejects unknown nonboolean values instead of silently rerouting", async () => {
    for (const value of ["false", null, 1, []]) {
      const path = await fixture({ ...base, claudeNative: value });
      await expect(loadOrcheConfigFile(path)).rejects.toThrow("config.claudeNative: expected a boolean");
    }
  });
});
