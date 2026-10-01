import { runtime, raw, bounded, text, save } from "./raw-sdk.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
const rt = await runtime();
const records: unknown[] = [];
let requests: unknown[] = [];
const original = rt.streamSimple.bind(rt);
rt.streamSimple = (model, context, options) => {
  requests.push(JSON.parse(JSON.stringify(context)));
  return original(model, context, options);
};
const sender = await raw(rt, "openai/gpt-6-luna");
await bounded(sender, "You are A1. Reply exactly: PEER_NOTE_739");
const finding = text(sender);
await save("exp2-sender", { finding, messages: sender.messages });
sender.dispose();
function deliver(s: AgentSession, mode: string) {
  const note = `A1 finding: ${finding}. Mention this code if you have received it.`;
  if (mode === "steer") void s.steer(note);
  else if (mode === "followUp") void s.followUp(note);
  else
    void s.sendCustomMessage(
      {
        customType: "pi-orche.note",
        content: note,
        display: true,
        details: { id: "note-1", from: "A1" },
      },
      mode === "nextTurn" ? { deliverAs: "nextTurn" } : { triggerTurn: false },
    );
}
for (const mode of ["steer", "followUp", "custom", "nextTurn"])
  for (const timing of ["tool", "final", "idle"]) {
    requests = [];
    const s = await raw(rt, "deepseek/deepseek-flash", ["bash"]);
    const events: unknown[] = [];
    let delivered = false;
    const start = performance.now();
    s.subscribe((e) => {
      events.push({
        type: e.type,
        ms: performance.now() - start,
        ...(e.type === "tool_execution_end"
          ? { isError: e.isError, result: e.result }
          : {}),
      });
      if (
        !delivered &&
        ((timing === "tool" && e.type === "tool_execution_start") ||
          (timing === "final" &&
            e.type === "message_end" &&
            e.message.role === "assistant" &&
            e.message.stopReason === "stop"))
      ) {
        delivered = true;
        deliver(s, mode);
      }
    });
    if (timing === "idle") {
      deliver(s, mode);
      delivered = true;
      await s.waitForIdle();
      records.push({ mode, timing, requestsBeforeAssignment: requests.length });
    }
    await bounded(
      s,
      timing === "tool"
        ? 'First call bash with command "sleep 5 && echo TOOL_FINISHED". Then reply with the output plus any peer code received.'
        : "Reply only FINAL_DONE.",
    );
    const initialRequests = requests.length;
    const initialAnswer = text(s);
    await bounded(s, "What peer code did you receive? Reply code or NONE.");
    records.push({
      mode,
      timing,
      delivered,
      initialRequests,
      initialAnswer,
      nextAssignmentAnswer: text(s),
      requests,
      events,
      messages: s.messages,
      stats: s.getSessionStats(),
    });
    s.dispose();
    console.log(mode, timing, initialRequests, initialAnswer);
  }
await save("exp2-note", records);
