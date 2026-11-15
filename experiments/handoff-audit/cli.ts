/**
 * Hand-off evidence audit CLI (docs/handoff-evidence.md). Aggregates only; message text never reaches the output.
 *
 *   npx tsx experiments/handoff-audit/cli.ts [--sessions DIR] [--records DIR] [--out FILE] [--suspects FILE] [--active-minutes N]
 *
 * --sessions: main transcripts (default ~/.pi/agent/sessions); --records: orche records with worker transcripts (default
 * ~/.pi/agent/orche/records). --out: write the JSON summary there (default: stdout only). --suspects: write the locations
 * (file, entry id; no text) of hand-offs whose newest user message is not carried verbatim, for a manual review.
 */
import { readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { auditMain, auditWorker, emptyMainAudit, emptySubWorkerAudit, originOf, readTranscript, type MainAudit, type Origin, type Suspect } from "./audit.js";

async function jsonlFiles(dir: string, accept: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let items: import("node:fs").Dirent[];
    try { items = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const path = join(current, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && item.name.endsWith(".jsonl") && accept(path)) out.push(path);
    }
  };
  await walk(dir);
  return out.sort();
}

export async function runAudit(options: { sessions: string; records: string; activeMinutes?: number; suspects?: Suspect[] }) {
  const now = Date.now();
  const activeMs = (options.activeMinutes ?? 30) * 60_000;
  const mainFiles = await jsonlFiles(options.sessions, () => true);
  // Worker transcripts: records/<session>/workers/<id>-<time>.jsonl; plan advisors (.advisor) never hand anything off.
  const workerFiles = await jsonlFiles(options.records, path => /\/workers\/[^/]+\.jsonl$/.test(path) && !basename(path).includes(".advisor-"));
  const inputs = { mainFiles: mainFiles.length, workerFiles: workerFiles.length, parseErrors: 0, filesWithParseErrors: 0, truncatedTail: 0, possiblyActive: 0, unreadable: 0 };
  const main: Record<Origin, MainAudit> = { interactive: emptyMainAudit(), automated: emptyMainAudit() };
  const sub = emptySubWorkerAudit();
  const seenMain = new Set<string>(), seenSub = new Set<string>();
  for (const [index, file] of [...mainFiles, ...workerFiles].entries()) {
    const isMain = index < mainFiles.length;
    let read;
    try {
      if (now - (await stat(file)).mtimeMs < activeMs) inputs.possiblyActive++;
      read = await readTranscript(file);
    } catch { inputs.unreadable++; continue; }
    inputs.parseErrors += read.parseErrors;
    if (read.parseErrors) inputs.filesWithParseErrors++;
    if (read.truncatedLast) inputs.truncatedTail++;
    if (isMain) auditMain(read, main[originOf(read)], seenMain, basename(file), options.suspects);
    // A worker transcript lives under its main session's records directory, named after that session (agent_workflow: "aw-…").
    else auditWorker(read, sub, seenSub, /\/aw-[^/]*\/workers\//.test(file) ? "automated" : "interactive");
  }
  return { generatedAt: new Date(now).toISOString(), inputs, main, subWorker: sub };
}

const flag = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const suspects: Suspect[] = [];
  const wantSuspects = flag("--suspects");
  try {
    const summary = await runAudit({
      sessions: flag("--sessions") ?? join(homedir(), ".pi", "agent", "sessions"),
      records: flag("--records") ?? join(homedir(), ".pi", "agent", "orche", "records"),
      ...(flag("--active-minutes") ? { activeMinutes: Number(flag("--active-minutes")) } : {}),
      ...(wantSuspects ? { suspects } : {}),
    });
    const json = JSON.stringify(summary, null, 2);
    const out = flag("--out");
    if (out) await writeFile(out, `${json}\n`);
    if (wantSuspects) await writeFile(wantSuspects, `${JSON.stringify(suspects, null, 2)}\n`);
    process.stdout.write(`${json}\n`);
  } catch (error) {
    // The error class only: a message could quote transcript text.
    process.stderr.write(`handoff-audit failed: ${error instanceof Error ? error.name : "error"}\n`);
    process.exitCode = 1;
  }
}
