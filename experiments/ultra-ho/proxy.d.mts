// Type declarations for proxy.mjs: a byte-identical copy of experiments/mdsd-ab/proxy.mjs (logging and pricing proxy; run without a
// cap by this harness: envelope.json `capUSD: null`). The runtime file stays plain JavaScript run directly by node.
export interface ProxyUsage { input: number; cached: number; cacheWrite: number; output: number; reasoning: number; final: string; respModel?: string; raw?: Record<string, unknown>; incomplete?: string }
export declare function numbersOf(value: unknown, depth?: number): unknown;
export declare function usageFrom(text: string): ProxyUsage | undefined;
export declare function errorOf(text: string): { type?: string; code?: string; message?: string } | undefined;
export declare function updateEffortsOf(body: unknown): string[];
export declare function costOf(prices: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number; tiers?: Record<string, number>[] }> | undefined, model: string, usage: { input: number; cached: number; cacheWrite?: number; output: number } | undefined): number | undefined;
