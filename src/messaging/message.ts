export interface MessageBase {
  id: string;
  from: string;
  to: string;
}
export interface NoteMessage extends MessageBase {
  type: "note";
  content: string;
  signal?: {
    kind: string;
    cause?: string;
    evidence?: unknown;
    confidence?: number;
    data?: unknown;
  };
}
export interface RedirectMessage extends MessageBase {
  type: "redirect";
  kind: string;
  prompt: string;
}
export interface StopMessage extends MessageBase {
  type: "stop";
}
export type OrcheMessage = NoteMessage | RedirectMessage | StopMessage;
export interface DeliveryReceipt {
  id: string;
  status: "delivered" | "duplicate" | "rejected";
  mode: "context" | "inbox" | "abort-prompt" | "abort";
  reason?: string;
}
