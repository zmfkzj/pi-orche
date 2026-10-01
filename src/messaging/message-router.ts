import type { DeliveryReceipt, OrcheMessage } from "./message.js";
/** Advisors are not agents: they may only author NOTES, as `advisor:<name>`. */
const advisorSender = /^advisor:[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export class MessageRouter {
  private readonly accepted = new Map<string, Promise<DeliveryReceipt>>();
  constructor(
    private readonly known: (id: string) => boolean,
    private readonly deliver: (
      message: OrcheMessage,
    ) => Promise<DeliveryReceipt>,
  ) {}
  async send(message: OrcheMessage): Promise<DeliveryReceipt> {
    const mode =
      message.type === "note"
        ? message.to === "main"
          ? "inbox"
          : "context"
        : message.type === "redirect"
          ? "abort-prompt"
          : "abort";
    if (message.from === message.to)
      return { id: message.id, status: "rejected", mode, reason: "self-addressed" };
    if (this.accepted.has(message.id)) {
      const previous = await this.accepted.get(message.id)!;
      return { ...previous, status: "duplicate" };
    }
    if (
      !(this.known(message.from) || (message.type === "note" && advisorSender.test(message.from))) ||
      !this.known(message.to) ||
      (message.type !== "note" && message.from !== "main") ||
      (message.type !== "note" && message.to === "main")
    )
      return {
        id: message.id,
        status: "rejected",
        mode,
        reason: "Unknown sender/recipient or coordinator-only operation",
      };
    const pending = Promise.resolve().then(() => this.deliver(message));
    this.accepted.set(message.id, pending);
    return pending;
  }
}
