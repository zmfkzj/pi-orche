import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { InheritedProviders } from "../../src/pi/inherit-providers.js";
import { beginThinking, lowerThinkingForRecovery } from "../../src/pi/thinking-state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orche-session-factory-"));
  roots.push(root);
  return root;
}
const mode = async (path: string) => (await stat(path)).mode & 0o777;
async function entries(file: string): Promise<Array<Record<string, any>>> {
  return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
}
const assistantTexts = (list: Array<Record<string, any>>) => list
  .filter(entry => entry.type === "message" && entry.message.role === "assistant")
  .map(entry => (entry.message.content as Array<{ type: string; text?: string }>).filter(part => part.type === "text").map(part => part.text).join(""));
async function open(steps: FauxResponseStep[], options: { sessionDir?: string; sessionFile?: string; cwd: string }) {
  const f = await fauxRuntime(steps);
  const session = await createSession({ cwd: options.cwd, route: f.route, modelRuntime: f.runtime, tools: [], instructions: "test", ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}), ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}) });
  return { f, session };
}

describe("session persistence in createSession", () => {
  it("stays in memory without a target: no file, no directory", async () => {
    const root = await temp();
    const { session } = await open([reply("hello")], { cwd: root });
    await session.prompt("hi");
    expect(session.sessionFile).toBeUndefined();
    expect(session.sessionManager.isPersisted()).toBe(false);
    expect(await readdir(root)).toEqual([]);
    session.dispose();
  });

  it("sessionDir: a session that never ran still leaves a valid 0600 JSONL in a 0700 directory", async () => {
    const root = await temp();
    const dir = join(root, "a", "b", "sessions");
    const { session } = await open([], { cwd: root, sessionDir: dir });
    const file = session.sessionFile!;
    expect(file.startsWith(dir)).toBe(true);
    expect(file).toMatch(/\.jsonl$/);
    session.dispose();
    const [header, ...rest] = await entries(file);
    expect(header).toMatchObject({ type: "session", version: 3, cwd: root });
    expect(rest.every(entry => entry.type !== "message")).toBe(true);
    expect(await mode(file)).toBe(0o600);
    for (const path of [dir, join(root, "a", "b"), join(root, "a")]) expect(await mode(path), path).toBe(0o700);
  });

  it("sessionDir: a short session records the user prompt and the assistant message", async () => {
    const root = await temp();
    const { session } = await open([reply("hello from the faux model")], { cwd: root, sessionDir: join(root, "s") });
    await session.prompt("say hello");
    session.dispose();
    const list = await entries(session.sessionFile!);
    // pi also records the system prompt the session ran with, which is what a reviewer needs.
    expect(list.filter(entry => entry.type === "message").map(entry => entry.message.role).filter(role => role !== "system")).toEqual(["user", "assistant"]);
    expect(assistantTexts(list)).toEqual(["hello from the faux model"]);
    // The routed model and thinking level are in the transcript too.
    expect(list.some(entry => entry.type === "model_change")).toBe(true);
    expect(await mode(session.sessionFile!)).toBe(0o600);
  });

  it("a failed session (provider error) is written as well", async () => {
    const root = await temp();
    const failing = () => reply("", { stopReason: "error", errorMessage: "provider exploded" }) as AssistantMessage;
    const { session } = await open([failing, failing], { cwd: root, sessionDir: join(root, "s") });
    await session.prompt("go").catch(() => undefined);
    session.dispose();
    const list = await entries(session.sessionFile!);
    const failed = list.filter(entry => entry.type === "message" && entry.message.role === "assistant");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every(entry => entry.message.stopReason === "error" && entry.message.errorMessage === "provider exploded")).toBe(true);
  });

  it("sessionFile: exactly that path, created 0600 with 0700 parents, and reused by a later session with the same file", async () => {
    const root = await temp();
    const file = join(root, "workers", "W1-2026-10-02T00-00-00-000Z.jsonl");
    const first = await open([reply("first answer")], { cwd: root, sessionFile: file });
    expect(first.session.sessionFile).toBe(file);
    await first.session.prompt("one");
    first.session.dispose();
    const second = await open([reply("second answer")], { cwd: root, sessionFile: file });
    expect(second.session.sessionFile).toBe(file);
    await second.session.prompt("two");
    second.session.dispose();
    const list = await entries(file);
    expect(list.filter(entry => entry.type === "session")).toHaveLength(1);
    expect(assistantTexts(list)).toEqual(["first answer", "second answer"]);
    expect(await mode(file)).toBe(0o600);
    expect(await mode(join(root, "workers"))).toBe(0o700);
    expect(await readdir(join(root, "workers"))).toEqual(["W1-2026-10-02T00-00-00-000Z.jsonl"]);
  });

  it("one live session across several prompts (a persistent worker) keeps appending to the same file", async () => {
    const root = await temp();
    const file = join(root, "w.jsonl");
    const { session } = await open([reply("a1"), reply("a2")], { cwd: root, sessionFile: file });
    await session.prompt("t1");
    await session.prompt("t2");
    session.dispose();
    expect(assistantTexts(await entries(file))).toEqual(["a1", "a2"]);
  });

  it("sessionFile wins over sessionDir", async () => {
    const root = await temp();
    const file = join(root, "chosen.jsonl");
    const { session } = await open([reply("x")], { cwd: root, sessionFile: file, sessionDir: join(root, "ignored") });
    session.dispose();
    expect(session.sessionFile).toBe(file);
    await expect(stat(join(root, "ignored"))).rejects.toThrow();
  });

  it("an existing file is chmod'ed to 0600 and its content is kept", async () => {
    const root = await temp();
    const file = join(root, "w.jsonl");
    const first = await open([reply("kept")], { cwd: root, sessionFile: file });
    await first.session.prompt("p");
    first.session.dispose();
    const { chmod } = await import("node:fs/promises");
    await chmod(file, 0o644);
    const second = await open([], { cwd: root, sessionFile: file });
    second.session.dispose();
    expect(await mode(file)).toBe(0o600);
    expect(assistantTexts(await entries(file))).toEqual(["kept"]);
  });

  it("disposing mid-stream leaves a marker entry with what had streamed", async () => {
    const root = await temp();
    let started!: () => void;
    const streaming = new Promise<void>(resolve => { started = resolve; });
    const blocked: FauxResponseStep = async (_context, options) => {
      started();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("late") as AssistantMessage;
    };
    const { session } = await open([blocked], { cwd: root, sessionFile: join(root, "w.jsonl") });
    const prompted = session.prompt("work").catch(() => undefined);
    await streaming;
    session.dispose();
    await prompted;
    const list = await entries(session.sessionFile!);
    const marker = list.find(entry => entry.type === "custom" && entry.customType === "orche:disposed");
    expect(marker?.data).toMatchObject({ whileStreaming: true });
    // The user prompt of the interrupted turn is on disk.
    expect(list.some(entry => entry.type === "message" && entry.message.role === "user")).toBe(true);
  });

  it("an unusable target falls back to memory instead of failing the session", async () => {
    const root = await temp();
    const file = join(root, "not-a-session.jsonl");
    await writeFile(file, "this is not a pi session\n");
    const { session } = await open([reply("ok")], { cwd: root, sessionFile: file });
    await session.prompt("hi");
    expect(session.sessionFile).toBeUndefined();
    session.dispose();
    expect(await readFile(file, "utf8")).toBe("this is not a pi session\n");
  });
});

describe("Pi 1.3 worker model-switch thinking (real SDK, faux provider)", () => {
  it("clamps each model without rewriting the default, and recalculates assignment effort after switching", async () => {
    const root = await temp();
    const requests: { model: string; thinking: string }[] = [];
    const host = await fauxRuntime(Array.from({ length: 4 }, () => (_context, options, _state, model) => {
      requests.push({ model: model.id, thinking: options?.reasoning ?? "off" });
      return reply("done");
    }));
    const base = host.faux.getModel();
    const capable = { ...base, id: "capable", reasoning: true };
    const plain = { ...base, id: "plain", reasoning: false };
    const limited = { ...base, id: "limited", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null } };
    host.runtime.registerNativeProvider({ ...host.faux.provider, getModels: () => [capable, plain, limited] });
    const child = await fauxRuntime();
    const runtime = new InheritedProviders().sync(child.runtime, new ModelRegistry(host.runtime));
    const session = await createSession({ cwd: root, modelRuntime: runtime, route: { ...host.route, model: `${base.provider}/capable`, thinking: "high" }, tools: [], instructions: "test" });
    try {
      session.settingsManager.applyOverrides({ defaultThinkingLevel: "high" });
      expect(beginThinking(session).baseline).toBe("high");
      await session.prompt("capable");
      expect(lowerThinkingForRecovery(session)).toBe(true);
      for (const [model, level] of [[plain, "off"], [limited, "low"], [capable, "high"]] as const) {
        await session.setModel(model);
        expect(session.thinkingLevel).toBe(level);
        const state = beginThinking(session, session.thinkingLevel);
        expect(state.baseline).toBe(level);
        expect(state.override).toBeUndefined();
        expect(session.getAvailableThinkingLevels()).toContain(state.step);
        await session.prompt(model.id);
      }
      expect(requests).toEqual([{ model: "capable", thinking: "high" }, { model: "plain", thinking: "off" }, { model: "limited", thinking: "low" }, { model: "capable", thinking: "high" }]);
      expect(session.settingsManager.getDefaultThinkingLevel()).toBe("high");
      expect(child.faux.state.callCount).toBe(0);
      const before = session.sessionManager.getEntries().length;
      session.setThinkingLevel("high");
      expect(session.sessionManager.getEntries()).toHaveLength(before); // no duplicate level entry
    } finally { session.dispose(); }
  });
});
