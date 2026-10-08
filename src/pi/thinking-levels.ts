/** Pi's thinking level names, lowest first (shared by thinking-state.ts and effort-mapping.ts). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = typeof THINKING_LEVELS[number];
