// Type declarations for delivery-render.mjs (the runtime file stays plain JavaScript so the measured sandbox can run it as render.mjs).
export type Decision = "include" | "uncertain" | "correct" | "duplicate" | "exclude";
export interface LedgerEntry { id: string; decision: Decision; required: string; statement: string; sourceStance: string; support: string; relevance: string; conditions: string[]; note: string; duplicateOf: string | null; locations: string[]; quote: string; evidence: string; taskLink: string }
export interface Ledger { ledger: string; entries: LedgerEntry[] }
export interface Heading { text?: string; error?: string }
export interface RenderMapEntry { region: "main" | "section" | "appendix" | "unplaced"; section: number | null; heading: string; startLine: number; endLine: number }
export interface Rendering { text: string; map: Record<string, RenderMapEntry>; fallbacks: string[]; headings: { region: string; index: number | null; heading: string; source: string }[]; proposals: { recorded: number; unapproved: any[]; rendered: 0 } }
export interface DeliveryCheck { errors: string[]; notes: string[]; arrangementErrors: string[]; fallbacks: string[]; headings: Rendering["headings"]; proposals: { recorded: number; rendered: 0 }; stats: { entries: number; approved: number; blocksOnce: number; conditionsRendered: number; notesRendered: number; tags: number; excludedOrDuplicate: number; collisions: number; placement: Record<string, number>; hiddenRanges: number; chars: number; lines: number } }
export interface TextScan { chars: number; words: number; lines: number; headings: number; listItems: number; idMentions: number; hidden: { comments: number; details: number; fences: number }; approvedVerbatim: number; approved: number; otherVerbatim: string[]; repeated8gramShare: number }
export declare const CLASSES: Decision[];
export declare const APPROVED: Decision[];
export declare const LABELS: string[];
export declare const MAIN_MAX: number;
export declare const SPAN_MAX_WORDS: number;
export declare const TITLE: string;
export declare const HEAD: { main: string; appendix: string; unplaced: string; accounting: string };
export declare function uncertainKind(e: Pick<LedgerEntry, "support">): string;
export declare function requiredOf(e: Pick<LedgerEntry, "decision" | "support" | "duplicateOf">): string;
export declare function tagOf(e: Pick<LedgerEntry, "decision" | "support" | "relevance">): string;
export declare function blockOf(e: LedgerEntry): string;
export declare function headingOf(section: any, byId: Map<string, LedgerEntry>): Heading;
export declare function validateArrangement(ledger: Ledger, arrangement: any): { errors: string[]; headings: Heading[] };
export declare function proposalsOf(arrangement: any): { recorded: number; unapproved: any[]; rendered: 0 };
export declare function render(ledger: Ledger, arrangement: any): Rendering;
export declare function hiddenRanges(text: string): [number, number][];
export declare function check(ledger: Ledger, arrangement: any, text: string): DeliveryCheck;
export declare function scanText(ledger: Ledger, text: string): TextScan;
