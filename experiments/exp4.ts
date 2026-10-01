import { runtime, raw, bounded, text, save } from "./raw-sdk.js";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";
import type {
  AgentSession,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
const rt = await runtime();
const variants = [];
for (const preempt of [false, true]) {
  const cwd = await mkdtemp(`${tmpdir()}/orche-exp4-`);
  await cp("fixtures/problem-a", cwd, { recursive: true });
  const sessions: AgentSession[] = [];
  const events: unknown[] = [];
  let foundAt: number | undefined;
  let requests = 0;
  const original = rt.streamSimple.bind(rt);
  rt.streamSimple = (m, c, o) => {
    requests++;
    return original(m, c, o);
  };
  const start = performance.now();
  for (let i = 0; i < 3; i++) {
    const report: ToolDefinition = {
      name: "root_cause",
      label: "Root cause",
      description: "Report proven root cause and stop.",
      parameters: Type.Object({
        cause: Type.String(),
        evidence: Type.String(),
      }),
      execute: async (_id, args) => {
        events.push({ agent: i, ms: performance.now() - start, payload: args });
        if (foundAt === undefined) {
          foundAt = performance.now() - start;
          if (preempt)
            for (const [j, s] of sessions.entries())
              if (j !== i) void s.abort();
        }
        return {
          content: [{ type: "text", text: "Accepted" }],
          details: args,
          terminate: true,
        };
      },
    };
    sessions.push(
      await raw(
        rt,
        "deepseek/deepseek-flash",
        ["read", "bash", "root_cause"],
        [report],
        cwd,
      ),
    );
  }
  await Promise.all(
    sessions.map((s, i) =>
      bounded(
        s,
        `Investigate ISSUE.md and source to find root cause. ${i === 0 ? "Start with source code." : i === 1 ? 'First run bash command "sleep 5 && node --test" then inspect source.' : 'First run bash command "sleep 8 && cat logs/production.log" then inspect source.'} Do not edit. Once certain, call root_cause with cause and evidence.`,
        90000,
      ),
    ),
  );
  const wallClockMs = performance.now() - start;
  const usage = sessions.map((s) => s.getSessionStats().tokens);
  variants.push({
    preempt,
    requests,
    wallClockMs,
    timeToRootCauseMs: foundAt,
    usage,
    events,
    answers: sessions.map(text),
    messages: sessions.map((s) => s.messages),
  });
  for (const s of sessions) s.dispose();
  rt.streamSimple = original;
  await rm(cwd, { recursive: true, force: true });
  console.log({ preempt, requests, wallClockMs, usage });
}
await save("exp4-preemption", variants);
