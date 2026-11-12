/**
 * Model-free audit of orche's bash output reductions in real transcripts (change #6): for every tool result that orche reduced
 * ("[Output filtered: <reason> …. Full output saved to <artifact>"), the command that produced it, whether that command runs a test
 * runner, and whether the same session read the saved full output (the artifact) afterwards. A read of the artifact right after a
 * reduction is the reread the reduction should make unnecessary.
 *
 *   npx tsx experiments/stage-eval/reduction-audit.ts <out.json> --sample <n> <seed> <records dir>   |   <out.json> <transcript.jsonl> ...
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { rng, shuffle } from "./protocol.js";

export const RUNNER = /\b(?:vitest|jest|mocha|pytest|tox|nox)\b|\bnode\b[^\n]{0,500}--test\b|\b(?:go|cargo)\s{1,40}test\b|\bnpm\s+(?:run\s+)?test\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b/;
const NOTICE = /\[Output filtered: ([^.(\]]+)[^\]]*Full output saved to (\.orche\/artifacts\/[^\s;]+?)(?:;|\s)/;

export interface ReductionCase { file: string; reason: string; runner: boolean; command: string; reread: boolean; within: number | null }

export async function auditTranscript(file: string): Promise<ReductionCase[]> {
  const calls = new Map<string, { name: string; args: any }>();
  const pending: { artifact: string; index: number; case: ReductionCase }[] = [];
  const cases: ReductionCase[] = [];
  let index = 0;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"type":"message"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall") continue;
        index++;
        calls.set(part.id, { name: part.name, args: part.arguments });
        const text = JSON.stringify(part.arguments ?? {});
        for (const item of pending) if (!item.case.reread && text.includes(item.artifact)) { item.case.reread = true; item.case.within = index - item.index; }
      }
    } else if (message?.role === "toolResult" && Array.isArray(message.content)) {
      const text = message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
      const match = NOTICE.exec(text);
      if (!match) continue;
      const call = calls.get(message.toolCallId);
      const command = call?.name === "bash" ? String(call.args?.command ?? "") : call?.name ?? "";
      const item: ReductionCase = { file, reason: match[1]!.trim(), runner: call?.name === "bash" && RUNNER.test(command), command: command.slice(0, 300), reread: false, within: null };
      cases.push(item);
      pending.push({ artifact: match[2]!, index, case: item });
    }
  }
  return cases;
}

export function sample(root: string, count: number, seed: string): string[] {
  const files: string[] = [];
  for (const session of readdirSync(root)) {
    let names: string[] = [];
    try { names = readdirSync(join(root, session, "workers")); } catch { continue; }
    for (const name of names) if (/^W\d+-.*\.jsonl$/.test(name) && statSync(join(root, session, "workers", name)).size > 20_000) files.push(join(root, session, "workers", name));
  }
  return shuffle(files.sort(), rng(seed)).slice(0, count);
}

export function summarize(cases: readonly ReductionCase[]) {
  const groups: Record<string, { cases: number; reread: number; rereadWithin3: number }> = {};
  for (const item of cases) {
    const key = `${item.reason} | ${item.runner ? "test-runner command" : "other command"}`;
    const group = groups[key] ??= { cases: 0, reread: 0, rereadWithin3: 0 };
    group.cases++;
    if (item.reread) group.reread++;
    if (item.reread && (item.within ?? 99) <= 3) group.rereadWithin3++;
  }
  return groups;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const out = args.shift()!;
  const files = args[0] === "--sample" ? sample(args[3]!, Number(args[1]), args[2]!) : args;
  const cases: ReductionCase[] = [];
  for (const file of files) cases.push(...await auditTranscript(file));
  const groups = summarize(cases);
  await writeFile(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), transcripts: files.length, groups, cases }, null, 2)}\n`);
  console.log(JSON.stringify({ transcripts: files.length, groups }, null, 1));
}
