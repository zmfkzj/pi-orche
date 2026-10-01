import { expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceAudit } from "../../src/orchestration/workspace.js";
import { workspaceDiff } from "../../src/advisor/context.js";
it("cancels only owned stalled Git children (workspace and advisor) and reaps them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orche-git-cancel-"));
  const oldPath = process.env.PATH;
  const pidFile = join(dir, "pid");
  await writeFile(join(dir, "git"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  await chmod(join(dir, "git"), 0o755);
  process.env.PATH = dir;
  try {
    for (const start of [(signal: AbortSignal) => WorkspaceAudit.open(dir, signal), (signal: AbortSignal) => workspaceDiff(dir, 100, signal)]) {
      await rm(pidFile, { force: true });
      const controller = new AbortController(); const pending = start(controller.signal);
      let pid = 0;
      const until = Date.now() + 2000;
      while (!pid && Date.now() < until) { pid = Number(await readFile(pidFile, "utf8").catch(() => "0")); if (!pid) await new Promise(r => setTimeout(r, 5)); }
      expect(pid).toBeGreaterThan(0);
      controller.abort(); await pending;
      while (Date.now() < until) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 5)); } catch { break; } }
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally { process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true }); }
});
