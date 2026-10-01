import { access } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { createFindToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { walkFiles } from "./walk.js";

const DOT_SEGMENT = /(^|\/)\./g;

// path.matchesGlob never lets `*` or `**` match dot-prefixed segments; fd --hidden (Pi's default) does.
const undot = (value: string) => value.replace(DOT_SEGMENT, "$1\u0001");

/**
 * Pi's `find` with an in-process directory walk instead of `fd`, which Pi would otherwise download at first use
 * (it is not installed by default and the download may be unavailable). Patterns without `/` match basenames.
 */
export function createFindTool(cwd: string): ToolDefinition {
  return {
    ...createFindToolDefinition(cwd, {
      operations: {
        exists: (path) => access(path).then(() => true, () => false),
        async glob(pattern, root, { limit }) {
          const fullPath = pattern.includes("/");
          const matcher = undot(fullPath ? pattern.replace(/^\.\//, "") : pattern);
          const found: string[] = [];
          await walkFiles(root, (path, name) => {
            if (matchesGlob(undot(fullPath ? path : name), matcher)) found.push(path);
            return found.length < limit;
          });
          return found;
        },
      },
    }),
  } as ToolDefinition;
}
