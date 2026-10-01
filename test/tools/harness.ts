import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage as reply,
  fauxToolCall as call,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";

export interface ToolOutcome {
  name: string;
  text: string;
  isError: boolean;
}
export type Step = (previous: ToolOutcome | undefined, all: ToolOutcome[]) => { name: string; args: Record<string, unknown> };

const dirs: string[] = [];
export async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orche-tools-"));
  dirs.push(dir);
  return dir;
}
export async function cleanupWorkspaces(): Promise<void> {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

function outcomes(messages: readonly unknown[]): ToolOutcome[] {
  return (messages as Array<{ role: string; toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> }>)
    .filter((m) => m.role === "toolResult")
    .map((m) => ({
      name: m.toolName ?? "",
      isError: m.isError === true,
      text: (m.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n"),
    }));
}

/** Drives a real AgentSession: each step is a tool call built from the previous tool result. */
export async function runToolScript(cwd: string, tools: string[], steps: Step[]) {
  const faux = await fauxRuntime();
  const script: FauxResponseStep[] = steps.map((step, i) => (context) => {
    const all = outcomes(context.messages);
    const next = step(all.at(-1), all);
    return reply([call(next.name, next.args as never, { id: `call-${i}` })], { stopReason: "toolUse" });
  });
  script.push(reply("done"));
  faux.faux.setResponses(script);
  const session = await createSession({
    route: faux.route,
    cwd,
    tools,
    instructions: "test",
    modelRuntime: faux.runtime,
  });
  try {
    await session.prompt("go");
    return outcomes(session.messages);
  } finally {
    session.dispose();
  }
}
