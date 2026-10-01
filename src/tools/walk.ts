import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const SKIPPED_DIRS = [".git", "node_modules", ".orche"];
const MAX_VISITED = 100_000;

/** Depth-first, name-sorted file walk (skips VCS/dependency/artifact dirs). `visit` returns false to stop. */
export async function walkFiles(
  root: string,
  visit: (relativePath: string, name: string) => boolean | void,
): Promise<void> {
  const info = await stat(root);
  if (!info.isDirectory()) {
    visit("", root.slice(root.lastIndexOf("/") + 1));
    return;
  }
  let visited = 0;
  let stopped = false;
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (stopped || ++visited > MAX_VISITED) return;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.includes(entry.name)) await walk(path);
      } else if (visit(path, entry.name) === false) {
        stopped = true;
        return;
      }
    }
  };
  await walk("");
}
