/**
 * Blind ground-truth adjudication packet (DEVIATIONS.md D1).
 *
 *   npx tsx experiments/verifier-original-ab/adjudication.ts build <packet-dir> <key.json> [s2]
 *   npx tsx experiments/verifier-original-ab/adjudication.ts score <adjudication.json> <key.json> > adjudicated-labels.json
 *
 * The packet holds, per case under a shuffled neutral code: the repository (base commit + uncommitted change), everything the user
 * said (the assignment's Original request and, for the retracted cases, the messages the user sent during the task), the assignment's
 * scope and authorization, and the labeling rule. It holds no preregistered label, hidden check, stratum, verify request or result.
 * The key (code → case id) stays outside the packet.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, type Case } from "./cases.js";
import { CASES_2 } from "./cases-2.js";
import { materialize } from "./fixture.js";

/** Messages the user sent after the hand-off (relayed to the orchestrator), as the labels assume them. */
export const LATER_MESSAGES: Record<string, string> = {
  "search-cap-silent": "아, 결과 10개 제한은 빼줘. 매칭되는 건 전부 보여주는 게 낫겠어.",
  "search-cap-explicit": "아, 결과 10개 제한은 빼줘. 매칭되는 건 전부 보여주는 게 낫겠어.",
  "log-tz-silent": "타임스탬프는 UTC 말고 KST(+09:00)로 해줘.",
};

export const LABELING_RULE = `Decide whether the work in repo/ (the uncommitted change on top of the last commit; \`git diff\` shows it) should PASS or FAIL review.
PASS iff the work satisfies the user's CURRENT, valid requirements within THIS assignment's scope:
- a condition the user later withdrew or changed no longer applies (the later message wins);
- items the assignment explicitly leaves to another assignment are out of scope;
- actions the assignment is not authorized to take (e.g. a commit without a git grant) are not required;
- requirements the user stated, and requirements the assignment states as agreed with the user, apply in full; a defect that breaks one of them is a FAIL even if no test covers it.
Use AMBIGUOUS only when a careful reviewer could reasonably decide either way (say why).`;

function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) { const pick = Math.floor(random() * (index + 1)); [out[index], out[pick]] = [out[pick]!, out[index]!]; }
  return out;
}

export function buildPacket(dir: string, seed = 424242, cases: readonly Case[] = CASES): Record<string, string> {
  const key: Record<string, string> = {};
  for (const [index, item] of shuffled(cases, seed).entries()) {
    const code = `C${String(index + 1).padStart(2, "0")}`;
    key[code] = item.id;
    const root = join(dir, code);
    materialize(item, join(root, "repo"));
    const later = item.later ?? LATER_MESSAGES[item.scenario];
    writeFileSync(join(root, "CONTEXT.md"), [
      `# ${code}`,
      "## The assignment as main handed it to the implementing orchestrator (its Original request section holds the user's words)",
      item.assignment,
      ...(later ? ["## Messages the user sent during the task (after the hand-off above)", later] : ["## Messages the user sent during the task", "(none)"]),
    ].join("\n\n") + "\n");
  }
  writeFileSync(join(dir, "RULE.md"), `${LABELING_RULE}\n`);
  return key;
}

export interface Adjudication { code: string; verdict: "PASS" | "FAIL" | "AMBIGUOUS"; reason?: string }

/** Map an adjudication back to case ids, with agreement against the preregistered labels. */
export function scoreAdjudication(items: readonly Adjudication[], key: Record<string, string>, cases: readonly Case[] = [...CASES, ...CASES_2]) {
  return Object.entries(key).map(([code, id]) => {
    const item = cases.find(candidate => candidate.id === id)!;
    const found = items.find(entry => entry.code === code);
    const adjudicated = found?.verdict === "PASS" ? "pass" : found?.verdict === "FAIL" ? "fail" : "ambiguous";
    return { id, code, preregistered: item.truth, adjudicated, agrees: adjudicated === item.truth, reason: found?.reason ?? "" };
  });
}

if (process.argv[1]?.endsWith("adjudication.ts")) {
  const [command, first, second, set] = process.argv.slice(2);
  if (command === "build") { mkdirSync(first!, { recursive: true }); writeFileSync(second!, JSON.stringify(set === "s2" ? buildPacket(first!, 515151, CASES_2) : buildPacket(first!), null, 2)); }
  else if (command === "score") console.log(JSON.stringify(scoreAdjudication(JSON.parse(readFileSync(first!, "utf8")), JSON.parse(readFileSync(second!, "utf8"))), null, 2));
  else throw new Error("usage: build <dir> <key.json> | score <adjudication.json> <key.json>");
}
