/**
 * The main session's long-response watch (src/extension/long-response.ts): a user notice while one response streams long without
 * a tool call or text, and a request-local note for the requests after such a response failed (Pi's auto-retry included).
 * Synthetic: fake timers and the faux provider stand in for the real ~15-minute provider cut-off, with thresholds scaled down.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage as reply, fauxThinking, fauxToolCall, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { hasVisibleOutput, LONG_RESPONSE_FAILURE_MS, LONG_RESPONSE_GUIDANCE_TYPE, LONG_RESPONSE_WARN_MS, LongResponseWatch } from "../../src/extension/long-response.js";
import type { MainMode } from "../../src/orchestration/routing.js";
import { createHarness, type Harness } from "./harness.js";

const NETWORK_ERROR = "network error: Codex error: stream error: stream disconnected before completion: stream closed before response.completed";
const MIN = 60_000;
const thinking = (text = "designing the change") => [{ type: "thinking", thinking: text }];

function watch(mode: MainMode = "single") {
  let now = 1_000_000;
  const notes: { message: string; type: string }[] = [];
  const current = { mode };
  const w = new LongResponseWatch(() => current.mode, (message, type) => notes.push({ message, type }), { now: () => now });
  return { w, notes, current, advance: (ms: number) => { now += ms; vi.advanceTimersByTime(ms); }, at: () => now };
}

describe("LongResponseWatch (unit, fake timers)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("defaults: notice after 10 min, a failure counts from 10 min", () => {
    expect(LONG_RESPONSE_WARN_MS).toBe(10 * MIN);
    expect(LONG_RESPONSE_FAILURE_MS).toBe(10 * MIN);
  });
  it("hasVisibleOutput: a tool call or non-blank text, not thinking", () => {
    expect(hasVisibleOutput(thinking())).toBe(false);
    expect(hasVisibleOutput([{ type: "text", text: "  \n" }])).toBe(false);
    expect(hasVisibleOutput([{ type: "text", text: "Answer" }])).toBe(true);
    expect(hasVisibleOutput([{ type: "toolCall", name: "orche_task", arguments: {} }])).toBe(true);
  });
  it("notifies the user once when one response streams past the threshold with only thinking", () => {
    vi.useFakeTimers();
    const { w, notes, advance, at } = watch();
    w.messageStart({ role: "assistant", content: [], timestamp: at() });
    advance(10 * MIN - 1);
    w.messageUpdate({ role: "assistant", content: thinking() });
    expect(notes).toHaveLength(0);
    advance(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "warning" });
    expect(notes[0]!.message).toContain("without a tool call or text");
    expect(notes[0]!.message).toContain("hand the task to orche_task now");
    advance(5 * MIN);
    expect(notes).toHaveLength(1);
    w.messageEnd({ role: "assistant", content: thinking(), stopReason: "toolUse" });
  });
  it("counts from the request start (message timestamp), and says 'short steps' in direct mode", () => {
    vi.useFakeTimers();
    const { w, notes, advance, at } = watch("direct");
    w.messageStart({ role: "assistant", content: [], timestamp: at() - 9 * MIN });
    advance(MIN);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("continue in short steps with tool calls");
  });
  it("no notice once the response shows text or a tool call, and none while tools or a worker run between responses", () => {
    vi.useFakeTimers();
    const { w, notes, advance, at } = watch();
    w.messageStart({ role: "assistant", content: [], timestamp: at() });
    advance(MIN);
    w.messageUpdate({ role: "assistant", content: [...thinking(), { type: "toolCall", name: "orche_task", arguments: {} }] });
    advance(20 * MIN);
    w.messageEnd({ role: "assistant", content: [{ type: "toolCall", name: "orche_task", arguments: {} }], stopReason: "toolUse" });
    // The attached orche_task wait (a tool execution) takes an hour: no response is streaming, no timer runs.
    advance(60 * MIN);
    w.messageStart({ role: "assistant", content: [], timestamp: at() });
    advance(MIN);
    w.messageUpdate({ role: "assistant", content: [{ type: "text", text: "Done: …" }] });
    advance(20 * MIN);
    w.messageEnd({ role: "assistant", content: [{ type: "text", text: "Done: …" }], stopReason: "stop" });
    expect(notes).toHaveLength(0);
    expect(w.armed).toBe(false);
  });
  it("a long failure without output arms the note: one notice per episode, the count grows, a completed response clears it", () => {
    const { w, notes, at } = watch();
    expect(w.guidance()).toBeUndefined();
    w.messageEnd({ role: "assistant", content: thinking(), stopReason: "error", errorMessage: NETWORK_ERROR, timestamp: at() - 15 * MIN, durationMs: 902_000 });
    expect(w.armed).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("ran 15 min without a tool call and failed");
    expect(notes[0]!.message).toContain("the retry itself is not blocked or delayed");
    const first = w.guidance()!;
    expect(first).toContain("[orche] Your previous response in this session ran 15 min without a tool call and ended with an error (network error:");
    expect(first).toContain("call orche_task now");
    expect(first).toContain("Do not drop or change any requirement the user stated");
    expect(first).not.toContain("times in a row");
    w.messageEnd({ role: "assistant", content: thinking(), stopReason: "error", errorMessage: NETWORK_ERROR, durationMs: 902_000 });
    expect(notes).toHaveLength(1);
    expect(w.guidance()).toContain("this happened 2 times in a row");
    // A short error in between (rate limit) neither arms nor clears.
    w.messageEnd({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit", durationMs: 800 });
    expect(w.armed).toBe(true);
    for (const stopReason of ["stop", "toolUse", "length"]) {
      w.messageEnd({ role: "assistant", content: thinking(), stopReason: "error", errorMessage: NETWORK_ERROR, durationMs: 902_000 });
      w.messageEnd({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason });
      expect(w.armed, stopReason).toBe(false);
    }
  });
  it("the note follows the mode in force at the request", () => {
    const { w, current } = watch("single");
    w.messageEnd({ role: "assistant", content: thinking(), stopReason: "error", errorMessage: NETWORK_ERROR, durationMs: 902_000 });
    current.mode = "direct";
    expect(w.guidance()).toContain("start with a tool call now");
    expect(w.guidance()).not.toContain("orche_task");
  });
  it("does not arm for a short error, a long failed answer that had text, or a user abort", () => {
    const { w, notes } = watch();
    w.messageEnd({ role: "assistant", content: thinking(), stopReason: "error", errorMessage: NETWORK_ERROR, durationMs: 9 * MIN });
    w.messageEnd({ role: "assistant", content: [{ type: "text", text: "A long ordinary answer …" }], stopReason: "error", errorMessage: NETWORK_ERROR, durationMs: 15 * MIN });
    w.messageEnd({ role: "assistant", content: thinking(), stopReason: "aborted", durationMs: 15 * MIN });
    expect(w.armed).toBe(false);
    expect(notes).toHaveLength(0);
  });
  it("abort and reset end an episode; a settled run that was not aborted keeps it for the user's next request", () => {
    const { w } = watch();
    const fail = () => w.messageEnd({ role: "assistant", content: thinking(), stopReason: "error", errorMessage: NETWORK_ERROR, durationMs: 902_000 });
    fail();
    w.settled(false);
    expect(w.armed).toBe(true);
    w.settled(true);
    expect(w.armed).toBe(false);
    fail();
    w.messageEnd({ role: "assistant", content: thinking(), stopReason: "aborted" });
    expect(w.armed).toBe(false);
    fail();
    w.reset();
    expect(w.armed).toBe(false);
  });
  it("an abort or a reset while streaming stops the pending notice; another instance (session) is independent", () => {
    vi.useFakeTimers();
    const a = watch();
    const b = watch();
    a.w.messageStart({ role: "assistant", content: [], timestamp: a.at() });
    b.w.messageStart({ role: "assistant", content: [], timestamp: b.at() });
    a.w.settled(true);
    a.advance(11 * MIN);
    expect(a.notes).toHaveLength(0);
    expect(b.notes).toHaveLength(1);
    b.w.messageEnd({ role: "assistant", content: thinking(), stopReason: "error", errorMessage: NETWORK_ERROR, durationMs: 902_000 });
    expect(b.w.armed).toBe(true);
    expect(a.w.armed).toBe(false);
  });
});

describe("long-response watch in a real session (scaled-down thresholds, Pi's own auto-retry)", () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.dispose(); h = undefined; });
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  /** The text of every user-role message the model received in a request. */
  const userTexts = (context: { messages: { role: string; content: unknown }[] }) => context.messages
    .filter(message => message.role === "user")
    .map(message => typeof message.content === "string" ? message.content : (message.content as { type: string; text?: string }[]).map(part => part.text ?? "").join(""));
  const longFailure = async () => {
    const start = Date.now();
    await sleep(60);
    return reply([fauxThinking("working out the whole design")], { stopReason: "error", errorMessage: NETWORK_ERROR, timestamp: start });
  };
  const harness = (mainSteps: Parameters<typeof createHarness>[0]["mainSteps"], failureAfterMs = 40) => createHarness({
    mainSteps, orcheSteps: [], mainMode: "single", settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
    extension: { longResponse: { warnAfterMs: 10 * MIN, failureAfterMs } },
  });

  it("Pi's automatic retry of a long failed response carries the note; the retry still runs; the note is request-local and ends with a completed response", async () => {
    const seen: string[][] = [];
    h = await harness([
      longFailure,
      context => { seen.push(userTexts(context)); return reply([fauxToolCall("orche_task_status", {})], { stopReason: "toolUse" }); },
      context => { seen.push(userTexts(context)); return reply("handed off"); },
      context => { seen.push(userTexts(context)); return reply("next answer"); },
    ]);
    await h.session.prompt("redesign the whole combat system");
    // The retry (second request) ran and ends with the note last; the continuation after the tool call no longer has it.
    expect(seen[0]!.at(-1)).toContain("[orche] Your previous response in this session ran");
    expect(seen[0]!.at(-1)).toContain("call orche_task now");
    expect(seen[0]!.at(-2)).toBe("redesign the whole combat system");
    expect(seen[1]!.join("\n")).not.toContain("[orche] Your previous response");
    await h.session.prompt("thanks");
    expect(seen[2]!.join("\n")).not.toContain("[orche] Your previous response");
    expect(h.main.faux.getPendingResponseCount()).toBe(0);
    // One user notice for the episode; nothing of the note is stored in the session.
    expect(h.notifications.filter(note => note.message.startsWith("orche: main's response ran"))).toHaveLength(1);
    expect(JSON.stringify(h.session.sessionManager.getBranch())).not.toContain(LONG_RESPONSE_GUIDANCE_TYPE);
  });
  it("repeated long failures: every retry carries the note; after Pi gives up it stays for the user's next prompt", async () => {
    const seen: string[][] = [];
    const failing: FauxResponseFactory = async context => { seen.push(userTexts(context)); return longFailure(); };
    h = await harness([longFailure, failing, failing, failing, context => { seen.push(userTexts(context)); return reply("short answer"); }]);
    await h.session.prompt("redesign it");
    expect(seen).toHaveLength(3);
    for (const texts of seen) expect(texts.at(-1)).toContain("[orche] Your previous response");
    expect(seen[2]!.at(-1)).toContain("times in a row");
    await h.session.prompt("redesign it, again");
    expect(seen[3]!.at(-1)).toContain("[orche] Your previous response");
    expect(seen[3]!.at(-2)).toBe("redesign it, again");
    expect(h.notifications.filter(note => note.message.startsWith("orche: main's response ran"))).toHaveLength(1);
  });
  it("a short retryable error does not add the note", async () => {
    const seen: string[][] = [];
    h = await harness([
      reply([fauxText("")], { stopReason: "error", errorMessage: NETWORK_ERROR }),
      context => { seen.push(userTexts(context)); return reply("ok"); },
    ], 5_000); // well above an immediate faux error, also on a loaded machine
    await h.session.prompt("hello");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.join("\n")).not.toContain("[orche]");
    expect(h.notifications.filter(note => note.message.startsWith("orche: main's response"))).toHaveLength(0);
  });
});
