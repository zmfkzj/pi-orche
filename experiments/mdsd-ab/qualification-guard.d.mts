// Type declarations for qualification-guard.mjs (the runtime file stays plain JavaScript so it can run as a separate process).
import type { Server } from "node:http";
export declare const ROUTING_REJECTION: RegExp;
export declare const TRANSIENT_UNAVAILABLE: RegExp;
export declare function holdable(status: number, message: string): boolean;
export declare function decodeBody(encoding: string | string[] | undefined, body: Buffer): Buffer;
export declare function requestJson(encoding: string | string[] | undefined, body: Buffer): any;
export declare function startGuard(options: { port?: number; target: string; log?: string; model: string; aliases?: string[]; modelsBody: string | Buffer; holdMs?: number; stepMs?: number }): Promise<{ server: Server; port: number }>;
export interface GuardStats { models: number; forwarded: number; routes: string[]; refused: number; passthrough: number; errors: number; routingRejections: number; routingConverted503: number; capacityHolds: number; capacityPassed: number; clientGone: number; refusedModels: (string | null)[] }
export declare function guardStats(log: string): GuardStats;
