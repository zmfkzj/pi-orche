/**
 * Contamination scan of one verifier transcript (PREREGISTRATION.md §5): the tool calls whose arguments reach the study's own files
 * (harness, cases, results, hidden checks) or any absolute path outside the workspace. Counts and flags only.
 */
import { readFile } from "node:fs/promises";

const STUDY = /verifier-original-ab|cases\.ts|hidden\.test|\/results\/|meta\.json|PREREGISTRATION|\/frozen\//i;
const ABSOLUTE = /(?:^|[\s"'=:(])(\/(?:home|var|tmp|root|etc|opt|srv|mnt)\/[^\s"'`;|&)]*)/g;

export interface Scan { scanned: true; toolCalls: number; outsidePaths: number; studyAccess: string[] }

export function scanEntries(lines: readonly string[], workspace: string): Scan {
  let toolCalls = 0, outsidePaths = 0;
  const studyAccess: string[] = [];
  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const part of content) {
      if (part?.type !== "toolCall") continue;
      toolCalls++;
      const args = JSON.stringify(part.arguments ?? {});
      if (STUDY.test(args)) studyAccess.push(`${part.name}`);
      for (const match of args.matchAll(ABSOLUTE)) if (!match[1]!.startsWith(workspace)) outsidePaths++;
    }
  }
  return { scanned: true, toolCalls, outsidePaths, studyAccess };
}

export async function scanTranscript(file: string, workspace: string): Promise<Scan> {
  return scanEntries((await readFile(file, "utf8")).split("\n"), workspace);
}
