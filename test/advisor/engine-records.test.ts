import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { AdvisorEngine } from "../../src/advisor/engine.js";
import { parseAdvisorConfigs } from "../../src/advisor/config.js";
import { directorySessionRecords } from "../../src/agent/records.js";
import type { CoordinatorEvent } from "../../src/orchestration/events.js";
import { fauxRuntime } from "../helpers/faux.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});
const verdict = reply([call("advisor_verdict", { verdict: "ok", notes: [] })], { stopReason: "toolUse" });
const report = reply([call("report_result", { kind: "implement", summary: "done" })], { stopReason: "toolUse" });

describe("advisor engine records", () => {
  it("each advisor call is a session of its own, numbered per advisor, reported through the host's records hook", async () => {
    const out = await mkdtemp(join(tmpdir(), "orche-engine-records-"));
    cleanup.push(() => rm(out, { recursive: true, force: true }));
    const worker = await fauxRuntime([report]);
    const advisor = await fauxRuntime([verdict]);
    worker.runtime.registerNativeProvider(advisor.faux.provider);
    const manager = new AgentManager(worker.runtime);
    cleanup.push(() => manager.dispose());
    await manager.spawn({ id: "a", role: "implementer", route: worker.route, modelRuntime: worker.runtime, cwd: process.cwd(), instructions: "worker", tools: [] });
    const events: CoordinatorEvent[] = [];
    const records = directorySessionRecords(out);
    const engine = new AdvisorEngine(parseAdvisorConfigs([{ name: "watch", domains: ["scope"], targets: ["coordinator"], triggers: [{ on: "assignment_started" }] }]), {
      cwd: process.cwd(), problem: "p", runtime: worker.runtime, routes: { routes: { advisor: { model: advisor.route.model } } },
      manager, coordinator: () => undefined, emit: event => events.push(event), records,
    });
    engine.start();
    cleanup.push(() => engine.dispose());
    manager.assign("a", "implement", "do it");
    await manager.wait("a", 3000);
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.type === "advisor_result") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(events.some(event => event.type === "advisor_result")).toBe(true);
    expect(records.entries.map(entry => entry.id)).toEqual(["advisor:watch#1"]);
    expect(records.entries[0]).toMatchObject({ kind: "advisor", role: "advisor", status: "completed", model: advisor.route.model, requests: 1 });
    expect(await readdir(out)).toEqual(["advisor-watch-1.jsonl"]);
  });
});
