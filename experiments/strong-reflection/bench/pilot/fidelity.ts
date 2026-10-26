/**
 * Fidelity gate of the decision-audit pilot at the reflection point (pilot/PREREGISTRATION.md "Fidelity"): the request the
 * continuation is about to send upstream is compared with O's recorded request at the same point BEFORE anything goes live.
 *
 * Must be identical (after removing run-specific ids/times, `wire.ts normalize`): every request parameter except `prompt_cache_key`
 * and `input`, the instructions, the tools, and every input item that is not a tool output (the hand-off, helper notes, every
 * replayed model message, reasoning item and tool call). Tool outputs of re-executed commands may differ; they are counted raw,
 * after the documented tool-noise rule and ignoring line order, and kept for inspection — never silently dropped. The delivering
 * task_plan output must be O's output followed by exactly the arm's intended text (C0: nothing), and no other item may carry
 * any intervention (the arm text, the four lines, R1's reflection text).
 */
import { normalize } from "../wire.js";
import { toolNoise } from "../analyze.js";
import { AUDIT, FOUR_LINES, PILOT_HEADER, pilotText, type PilotArm } from "./protocol.js";

export interface OutputDiff { index: number; callId: string; raw: string; actual: string }
export interface FidelityReport {
  ok: boolean;
  problems: string[];
  items: number;
  /** Tool outputs that differ: raw, after the tool-noise rule, and also ignoring line order. */
  outputs: { raw: number; normalized: number; orderOnly: number; diffs: OutputDiff[] };
  delivery: { index: number; expected: string; found: boolean };
}

const R1_HEADER = "Reflection before your self-review (strong mode, single.strongReflection;";
const lineSet = (text: string): string => text.split("\n").sort().join("\n");
const textOf = (item: any): string => typeof item?.output === "string" ? item.output : JSON.stringify(item?.output ?? "");

/** Count of non-overlapping occurrences of `needle` in `text`. */
export const occurrences = (text: string, needle: string): number => needle ? text.split(needle).length - 1 : 0;

export function compareCheckpoint(actual: any, recorded: any, arm: PilotArm, node: string): FidelityReport {
  const problems: string[] = [];
  const keys = new Set([...Object.keys(actual ?? {}), ...Object.keys(recorded ?? {})]);
  for (const key of keys) {
    if (key === "input" || key === "prompt_cache_key") continue;
    const a = key === "instructions" ? normalize(String(actual?.[key] ?? "")) : JSON.stringify(actual?.[key]);
    const b = key === "instructions" ? normalize(String(recorded?.[key] ?? "")) : JSON.stringify(recorded?.[key]);
    if (a !== b) problems.push(`request parameter ${key} differs from O's`);
  }
  const ai: any[] = Array.isArray(actual?.input) ? actual.input : [], bi: any[] = Array.isArray(recorded?.input) ? recorded.input : [];
  if (ai.length !== bi.length) problems.push(`input has ${ai.length} items, O's ${bi.length}`);
  const expected = pilotText(arm, node);
  // The delivering item: the last task_plan output (the plan that started the integration node).
  const planCalls = new Set(bi.filter(item => item?.type === "function_call" && item.name === "task_plan").map(item => item.call_id));
  let deliveryIndex = -1;
  for (let i = bi.length - 1; i >= 0; i--) if (bi[i]?.type === "function_call_output" && planCalls.has(bi[i].call_id)) { deliveryIndex = i; break; }
  if (deliveryIndex < 0) problems.push("O's request has no task_plan output to carry the text");
  const outputs = { raw: 0, normalized: 0, orderOnly: 0, diffs: [] as OutputDiff[] };
  let found = false;
  for (let i = 0; i < Math.min(ai.length, bi.length); i++) {
    const a = ai[i], b = bi[i];
    if (a?.type === "function_call_output" && b?.type === "function_call_output") {
      if (a.call_id !== b.call_id) { problems.push(`item ${i}: tool output call id differs`); continue; }
      const at = textOf(a), bt = textOf(b);
      if (i === deliveryIndex) {
        const want = expected ? `${bt}\n${expected}` : bt;
        found = normalize(at) === normalize(want);
        if (!found) problems.push(`item ${i}: the delivering task_plan output is not O's output${expected ? " followed by exactly the arm's text" : ""}`);
        continue;
      }
      if (at === bt) continue;
      outputs.raw++;
      const na = toolNoise(normalize(at)), nb = toolNoise(normalize(bt));
      if (na !== nb) outputs.normalized++;
      if (lineSet(na) !== lineSet(nb)) outputs.orderOnly++;
      outputs.diffs.push({ index: i, callId: String(a.call_id), raw: bt.slice(0, 4000), actual: at.slice(0, 4000) });
      continue;
    }
    if (normalize(JSON.stringify(a)) !== normalize(JSON.stringify(b))) problems.push(`item ${i} (${a?.type ?? a?.role ?? "?"}) differs from O's`);
  }
  // No intervention outside the delivering item, and inside it exactly the arm's.
  const all = JSON.stringify(ai);
  const deliveringText = deliveryIndex >= 0 && ai[deliveryIndex] ? textOf(ai[deliveryIndex]) : "";
  const outside = JSON.stringify(ai.filter((_, i) => i !== deliveryIndex));
  const quoted = (text: string) => JSON.stringify(text).slice(1, -1);
  for (const [label, text] of [["pilot header", "Before your self-review (strong mode; integration node"], ["four lines", FOUR_LINES.split("\n")[0]!], ["audit", AUDIT.split("\n")[0]!], ["R1 reflection", R1_HEADER]] as const) {
    if (occurrences(outside, quoted(text))) problems.push(`${label} appears outside the delivering item`);
  }
  const want = { header: arm === "C0" ? 0 : 1, four: arm === "B" ? 1 : 0, audit: arm === "C0" ? 0 : 1 };
  const got = { header: occurrences(deliveringText, PILOT_HEADER(node)), four: occurrences(deliveringText, FOUR_LINES), audit: occurrences(deliveringText, AUDIT) };
  if (got.header !== want.header || got.four !== want.four || got.audit !== want.audit) problems.push(`delivered text counts header/four lines/audit ${got.header}/${got.four}/${got.audit}, expected ${want.header}/${want.four}/${want.audit}`);
  if (occurrences(all, quoted(R1_HEADER))) problems.push("R1's reflection text is present");
  return { ok: problems.length === 0, problems, items: ai.length, outputs, delivery: { index: deliveryIndex, expected, found } };
}
