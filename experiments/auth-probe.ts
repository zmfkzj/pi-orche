import { runtime, raw, bounded, text, save } from "./raw-sdk.js";
const rt = await runtime();
const results = [];
for (const route of [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-5-5",
  "openai/gpt-6-luna",
  "openai/gpt-6-sol",
  "google/gemini-3.5-flash",
  "deepseek/deepseek-flash",
]) {
  const start = performance.now();
  let s;
  try {
    s = await raw(rt, route);
    await bounded(s, "Reply only OK.", 45000);
    const last = s.messages.filter((m) => m.role === "assistant").at(-1);
    results.push({
      route,
      latencyMs: performance.now() - start,
      authenticated:
        last?.stopReason !== "error" && last?.stopReason !== "aborted",
      answer: text(s),
      error: last?.errorMessage,
    });
  } catch (error) {
    results.push({
      route,
      latencyMs: performance.now() - start,
      authenticated: false,
      error: String(error),
    });
  } finally {
    s?.dispose();
  }
  console.log(results.at(-1));
}
await save("auth-probe", results);
