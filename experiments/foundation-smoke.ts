import { AgentManager } from "../src/agent/agent-manager.js";
import { runtime, save } from "./raw-sdk.js";
import type { ManagerEvent } from "../src/agent/agent-handle.js";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
const authPath = `${homedir()}/.pi/agent/auth.json`;
async function authMetadata() {
  const metadata = await stat(authPath);
  const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, { expires?: number }>;
  return { mtimeMs: metadata.mtimeMs, openaiExpires: auth.openai?.expires ?? null };
}
const beforeAuth = await authMetadata();
const rt = await runtime();
const m = new AgentManager(rt);
const events: ManagerEvent[] = [];
m.subscribe((e) => events.push(e));
try {
  for (const id of ["a", "b"])
    await m.spawn({
      id,
      role: "smoke",
      route: {
        role: "smoke",
        model: "openai/gpt-6-luna",
        thinking: "off",
      },
      cwd: process.cwd(),
      tools: [],
      instructions:
        "Follow the assigned task exactly. Use report_result to finish.",
    });
  m.assign(
    "a",
    "explore",
    "Send b a NOTE with content SMOKE_SECRET_918 using send_message, then report_result kind explore summary sent.",
  );
  const a = await m.wait("a", 30000);
  m.assign(
    "b",
    "recall",
    "Report_result kind recall summary exactly the code in the NOTE you received.",
  );
  const b = await m.wait("b", 30000);
  m.assign(
    "b",
    "reuse",
    "Report_result kind reuse summary exactly the code you previously reported.",
  );
  const reuse = await m.wait("b", 30000);
  const afterAuth = await authMetadata();
  const authRefresh = { before: beforeAuth, after: afterAuth, mtimeChanged: beforeAuth.mtimeMs !== afterAuth.mtimeMs, expiryChanged: beforeAuth.openaiExpires !== afterAuth.openaiExpires };
  const data = { a, b, reuse, workers: m.list(), events, authRefresh };
  await save("foundation-smoke", data);
  console.log(JSON.stringify(data, null, 2));
  if (
    a.type !== "outcome" ||
    b.type !== "outcome" ||
    reuse.type !== "outcome" ||
    !b.outcome.result?.summary.includes("SMOKE_SECRET_918") ||
    !reuse.outcome.result?.summary.includes("SMOKE_SECRET_918")
  )
    throw new Error("Smoke behavior failed");
} finally {
  await m.dispose();
}
