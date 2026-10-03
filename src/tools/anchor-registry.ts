import { createHash } from "node:crypto";
import { anchorMatches, isBlankLine, lineHash, parseFileText, type Anchor } from "./anchors.js";

/** Zero-based half-open old ranges and the number of replacement lines. */
export interface LineChange { start: number; end: number; lines: readonly string[] }
type ShowingKind = "read" | "non-read";
interface Showing { digest: string | null; read: boolean }
interface Version {
  hash: string;
  shown: Map<number, Showing>;
  pendingEcho?: boolean;
  changes?: readonly { start: number; end: number; count: number }[];
}
const textHash = (text: string): string => createHash("sha256").update(text).digest("hex");
const MAX_VERSIONS = 16;
const MAX_FILES = 64;
const MAX_SHOWN = 20_000;

/** Per-tool-set history; only lines actually printed may be rebased. */
export class AnchorRegistry {
  private readonly files = new Map<string, Version[]>();

  private touch(path: string): Version[] | undefined {
    const versions = this.files.get(path);
    if (versions) {
      this.files.delete(path);
      this.files.set(path, versions);
    }
    return versions;
  }

  private current(path: string, text: string): Version[] {
    const hash = textHash(text);
    let versions = this.touch(path);
    // A new externally-written snapshot has no map to earlier snapshots.
    if (versions?.at(-1)?.hash !== hash) {
      versions = [{ hash, shown: new Map() }];
      this.files.set(path, versions);
    }
    while (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value!);
    return versions!;
  }

  recordShown(path: string, text: string, lines: readonly string[], numbers: Iterable<number>, kind?: ShowingKind): void {
    const versions = this.current(path, text);
    const version = versions.at(-1)!;
    const shown = version.shown;
    // Existing tool protocol: recordEdit is synchronously followed by its echo;
    // stale-error excerpts pass a Set, while normal and symbol reads pass arrays.
    // Explicit kinds also let registry clients avoid relying on that protocol.
    const read = (kind ?? (version.pendingEcho || numbers instanceof Set ? "non-read" : "read")) === "read";
    version.pendingEcho = false;
    for (const n of numbers) {
      const line = lines[n - 1];
      if (line !== undefined) shown.set(n, {
        digest: isBlankLine(line) ? null : lineHash(line), read: read || shown.get(n)?.read === true,
      });
    }
    this.trim(versions);
  }

  recordEdit(path: string, before: string, after: string, changes: readonly LineChange[]): void {
    const versions = this.current(path, before);
    // Maps need only boundaries/deltas, not the entire replacement contents.
    versions.push({ hash: textHash(after), shown: new Map(), pendingEcho: true, changes: changes.map(c => ({
      start: c.start, end: c.end, count: c.lines.length,
    })) });
    this.trim(versions);
  }

  private trim(versions: Version[]): void {
    let entries = versions.reduce((n, v) => n + v.shown.size, 0);
    while (versions.length > MAX_VERSIONS || (entries > MAX_SHOWN && versions.length > 1)) {
      entries -= versions.shift()!.shown.size;
    }
    const shown = versions[0]!.shown;
    while (entries > MAX_SHOWN) {
      shown.delete(shown.keys().next().value!);
      entries--;
    }
  }

  resolve(path: string, text: string, anchor: Anchor): { line: number; changed?: boolean } {
    return this.resolver(path, text)(anchor);
  }

  /** Hash once per edit call, before resolving any anchors against its snapshot. */
  resolver(path: string, text: string): (anchor: Anchor) => { line: number; changed?: boolean } {
    const versions = this.touch(path);
    if (!versions || versions.at(-1)!.hash !== textHash(text)) return anchor => ({ line: anchor.line });
    const currentLines = parseFileText(text).lines;
    return anchor => {
      const matches = (showing: Showing | undefined): boolean => showing !== undefined
        && (anchor.tag === undefined ? showing.digest === null : showing.digest !== null && showing.digest.startsWith(anchor.tag));
      const latest = versions.at(-1)!.shown.get(anchor.line);
      // A current read/symbol view resolves echo ambiguity, including bare blanks.
      if (latest?.read && matches(latest) && currentLines[anchor.line - 1] !== undefined
        && anchorMatches(anchor, currentLines[anchor.line - 1]!)) return { line: anchor.line };
      const targets = new Set<number>();
      let matched = false;
      for (let i = 0; i < versions.length; i++) {
        const shown = versions[i]!.shown;
        if (!shown.has(anchor.line)) continue;
        if (!matches(shown.get(anchor.line))) continue;
        matched = true;
        let index: number | undefined = anchor.line - 1;
        for (let j = i + 1; j < versions.length && index !== undefined; j++) {
          let delta = 0;
          for (const c of versions[j]!.changes ?? []) {
            if (index >= c.start && index < c.end) { index = undefined; break; }
            if (c.end <= index) delta += c.count - (c.end - c.start);
          }
          if (index !== undefined) index += delta;
        }
        if (index !== undefined && currentLines[index] !== undefined && anchorMatches(anchor, currentLines[index]!)) targets.add(index + 1);
      }
      if (targets.size > 1) {
        const lines = [...targets].sort((a, b) => a - b);
        throw new Error(`line ${anchor.line}${anchor.tag === undefined ? "" : `#${anchor.tag}`} matches lines ${lines.join(" and ")} after your edits; re-read the lines you want to change`);
      }
      if (targets.size) return { line: targets.values().next().value! };
      return matched ? { line: anchor.line, changed: true } : { line: anchor.line };
    };
  }
}
