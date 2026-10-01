import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { NoteMessage } from "../messaging/message.js";
export class SessionAdapter {
  constructor(readonly session: AgentSession) {}
  run(prompt: string): Promise<void> {
    return this.session.prompt(prompt);
  }
  note(message: NoteMessage): Promise<void> {
    const signal = message.signal;
    const summary = signal
      ? `\nSignal: ${signal.kind}${signal.cause ? `; cause: ${signal.cause}` : ""}${signal.confidence !== undefined ? `; confidence: ${signal.confidence}` : ""}`
      : "";
    return this.session.sendCustomMessage(
      {
        customType: "pi-orche.note",
        content: `[pi-orche NOTE from ${message.from} · id ${message.id}; informational, not a new assignment]\n${message.content}${summary}`,
        display: true,
        details: message,
      },
      { triggerTurn: false },
    );
  }
  /** Runtime notice from pi-orche itself (e.g. a request-budget warning), delivered like a NOTE. */
  notice(text: string): Promise<void> {
    return this.session.sendCustomMessage(
      { customType: "pi-orche.notice", content: `[pi-orche notice] ${text}`, display: true, details: { text } },
      { triggerTurn: false },
    );
  }
  abort(): Promise<void> {
    return this.session.abort();
  }
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    return this.session.subscribe(listener);
  }
  get running(): boolean {
    return this.session.isStreaming;
  }
  get lastText(): string {
    const m = this.session.messages
      .filter((m) => m.role === "assistant")
      .at(-1);
    return (
      m?.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("") ?? ""
    );
  }
  dispose(): void {
    this.session.dispose();
  }
}
