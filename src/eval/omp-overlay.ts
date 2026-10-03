import { mkdtemp, chmod, cp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runProcess } from './omp-runner.js';

/** Omp validates/refreshes credentials at startup, including unused providers. Confine those writes to a private SQLite snapshot. */
export async function prepareOmpOverlay(source = join(homedir(), '.omp/agent')) {
  const dir = await mkdtemp(join(tmpdir(), 'bench3-omp-agent-'));
  await chmod(dir, 0o700);
  try {
    const code = `import sqlite3,sys,os\nfor name in ['agent.db','models.db']:\n src=sqlite3.connect('file:'+os.path.join(sys.argv[1],name)+'?mode=ro',uri=True)\n target=os.path.join(sys.argv[2],name); dst=sqlite3.connect(target)\n src.backup(dst); dst.close(); src.close(); os.chmod(target,0o600)`;
    const backup = await runProcess('python3', ['-c',code,source,dir], { cwd: dir, timeoutMs: 30_000 });
    if (backup.exitCode !== 0) throw new Error('Cannot create private omp credential/catalog snapshot: ' + backup.stderr);
    // Preserve native user product configuration/instructions. Plugin discovery remains in ~/.omp/plugins.
    const copied: string[] = [];
    for (const name of ['config.yml','models.yml','APPEND_SYSTEM.md','SYSTEM.md','AGENTS.md','mcp.json','extensions','skills']) {
      try { await stat(join(source,name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      await cp(join(source,name),join(dir,name),{recursive:true}); copied.push(name);
    }
    return { dir, publicEvidence: { credentialSource: 'Read-only SQLite backup of ~/.omp/agent/agent.db and models.db; credential validation/refresh writes only private snapshot', productFilesCopied: copied, plugins: '~/.omp/plugins (unchanged)', privateOverlay: true }, cleanup: () => rm(dir,{recursive:true,force:true}) };
  } catch (error) { await rm(dir,{recursive:true,force:true}); throw error; }
}
