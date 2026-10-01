import { runtime, raw, bounded, text, save } from "./raw-sdk.js";
const rt = await runtime();
const routes = [
  "openai/gpt-6-luna",
  "google/gemini-3.5-flash",
  "deepseek/deepseek-flash",
];
const results = [];
for (const [index, route] of routes.entries()) {
  const s = await raw(rt, route);
  const secret = `PRIVATE_${index}_orchid_81`;
  const turns = [];
  for (const prompt of [
    `Remember my private code ${secret}. Reply SAVED.`,
    "What private code did I give you? Reply exactly the code.",
    "Did I give you PRIVATE_0_orchid_81? Answer yes or no.",
  ]) {
    await bounded(s, prompt);
    turns.push({ prompt, answer: text(s) });
  }
  results.push({
    id: `A${index + 1}`,
    route,
    secret,
    turns,
    messages: s.messages,
  });
  s.dispose();
}
await save("exp1-persistence", results);
console.log(
  results.map((x) => ({ id: x.id, answers: x.turns.map((t) => t.answer) })),
);
