import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { fauxRuntime } from "../helpers/faux.js";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";

const managers: AgentManager[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(["spawn", "adopt"] as const)("guarded %s without a per-file guard fails closed for directory rewrite", async mode => {
  const cwd = await mkdtemp(join(tmpdir(), "orche-manager-file-guard-"));
  roots.push(cwd);
  await writeFile(join(cwd, "a.ts"), "console.log(value);\n");
  const f = await fauxRuntime([
    reply([call("ast_rewrite", { path: ".", pattern: "console.log($X)", replacement: "console.info($X)", language: "typescript" })], { stopReason: "toolUse" }),
    reply([call("report_result", { kind: "implement", summary: "done" })], { stopReason: "toolUse" }),
  ]);
  const manager = new AgentManager(f.runtime);
  managers.push(manager);
  if (mode === "spawn") {
    await manager.spawn({ id: "a", role: "test", cwd, route: f.route, instructions: "test", tools: ["ast_rewrite"], toolGuard: () => undefined });
  } else {
    const source = new AgentManager(f.runtime);
    managers.push(source);
    await source.spawn({ id: "a", role: "test", cwd, route: f.route, instructions: "test", tools: ["ast_rewrite"], writeFileGuard: () => undefined });
    manager.adopt(source.detach("a"), { toolGuard: () => undefined });
  }
  manager.assign("a", "implement", "rewrite");
  expect(await manager.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
  expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("console.log(value);\n");
  const messages = JSON.stringify(manager.session("a").messages);
  expect(messages).toContain("Skipped files:");
  expect(messages).toContain("requires a per-file write guard");
});

it("unguarded manager sessions still support directory rewrites", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orche-manager-unguarded-"));
  roots.push(cwd);
  await writeFile(join(cwd, "a.ts"), "console.log(value);\n");
  const f = await fauxRuntime([
    reply([call("ast_rewrite", { path: ".", pattern: "console.log($X)", replacement: "console.info($X)", language: "typescript" })], { stopReason: "toolUse" }),
    reply([call("report_result", { kind: "implement", summary: "done" })], { stopReason: "toolUse" }),
  ]);
  const manager = new AgentManager(f.runtime);
  managers.push(manager);
  await manager.spawn({ id: "a", role: "test", cwd, route: f.route, instructions: "test", tools: ["ast_rewrite"] });
  manager.assign("a", "implement", "rewrite");
  expect(await manager.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
  expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("console.info(value);\n");
});
