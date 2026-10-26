// Type declarations for proxy.mjs (the witness-replay unit proxy; the runtime file stays plain JavaScript run directly by node).
import type { Server } from "node:http";

export interface Envelope { route?: { model: string; effort: string }; maxRequests?: number; placeholderKey?: string; prices?: Record<string, unknown> }
export interface AdmitFacts { model?: string; effort?: string; updateEfforts?: string[]; maxOutput?: number; session?: string; bytes?: number }
export type Admission = { forward: true; facts: AdmitFacts } | { forward: false; status: number; refused: "method" | "unverifiable" | "route" | "budget"; message: string; facts?: AdmitFacts };
export declare function admit(envelope: Envelope, request: { method?: string; encoding?: string; body: Buffer }, forwarded: number): Admission;
export declare function substituteKey(headers: Record<string, unknown>, placeholder: string | undefined, key: string | undefined): Record<string, unknown>;
export declare function usageFrom(text: string): { input: number; cached: number; cacheWrite: number; output: number; reasoning: number; final: string; respModel?: string } | undefined;
export declare function errorOf(text: string): { type?: string; code?: string; message?: string } | undefined;
export declare function costOf(prices: Record<string, unknown> | undefined, model: string, usage: { input: number; cached: number; cacheWrite?: number; output: number } | undefined): number | undefined;
export declare function startProxy(options: { listen: string | number; target: URL; log: string; envelope: Envelope; key?: string }): Promise<{ server: Server; totals: Record<string, any>; address: string }>;
