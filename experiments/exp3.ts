import { runtime, raw, bounded, text, save } from "./raw-sdk.js";
const rt = await runtime();
const records = [];
for (const mode of ["soft", "hard"]) {
  const s = await raw(rt, "deepseek/deepseek-flash", ["bash"]);
  const events: unknown[] = [];
  let switchAt = 0;
  let redirect: Promise<unknown> | undefined;
  const start = performance.now();
  s.subscribe((e) => {
    events.push({
      type: e.type,
      ms: performance.now() - start,
      ...(e.type === "tool_execution_end"
        ? { result: e.result, isError: e.isError }
        : {}),
    });
    if (e.type === "tool_execution_start" && !switchAt) {
      switchAt = performance.now();
      if (mode === "soft")
        redirect = s.steer(
          "New goal: do not explore. Reply only NEW_GOAL_ADOPTED.",
        );
      else
        redirect = (async () => {
          await s.abort();
          await bounded(
            s,
            "New goal: do not explore. Reply only NEW_GOAL_ADOPTED.",
          );
        })();
    }
  });
  await bounded(
    s,
    'Call bash with command "sleep 10 && echo OLD_GOAL" then describe its result.',
  );
  await redirect;
  records.push({
    mode,
    timeToSwitchMs: performance.now() - switchAt,
    answer: text(s),
    events,
    messages: s.messages,
    stats: s.getSessionStats(),
  });
  s.dispose();
  console.log(mode, records.at(-1)?.timeToSwitchMs);
}
await save("exp3-redirect", records);
