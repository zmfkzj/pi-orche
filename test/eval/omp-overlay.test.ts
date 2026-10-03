import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareOmpOverlay } from '../../src/eval/omp-overlay.js';
import { runProcess } from '../../src/eval/omp-runner.js';

it('keeps credential/catalog mutation in private consistent SQLite snapshots, with product config retained', async () => {
  const source = await mkdtemp(join(tmpdir(),'bench3-omp-test-'));
  let overlay: Awaited<ReturnType<typeof prepareOmpOverlay>> | undefined;
  try {
    const setup = await runProcess('python3',['-c',`import sqlite3,sys,os\nfor name in ['agent.db','models.db']:\n c=sqlite3.connect(os.path.join(sys.argv[1],name)); c.execute('CREATE TABLE sentinel(value TEXT)'); c.execute("INSERT INTO sentinel VALUES ('original')"); c.commit(); c.close()`,source],{cwd:source,timeoutMs:10000});
    expect(setup.exitCode).toBe(0);
    await writeFile(join(source,'config.yml'),'defaultThinkingLevel: high\n');
    await writeFile(join(source,'APPEND_SYSTEM.md'),'Product instruction\n');
    overlay = await prepareOmpOverlay(source);
    expect((await stat(overlay.dir)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(overlay.dir,'APPEND_SYSTEM.md'),'utf8')).toBe('Product instruction\n');
    expect(overlay.publicEvidence.productFilesCopied).toContain('config.yml');
    const mutate = await runProcess('python3',['-c',`import sqlite3,sys,os\nfor name in ['agent.db','models.db']:\n c=sqlite3.connect(os.path.join(sys.argv[2],name)); c.execute("UPDATE sentinel SET value='refreshed locally'"); c.commit(); c.close()\n c=sqlite3.connect('file:'+os.path.join(sys.argv[1],name)+'?mode=ro',uri=True); print(c.execute('SELECT value FROM sentinel').fetchone()[0]); c.close()`,source,overlay.dir],{cwd:source,timeoutMs:10000});
    expect(mutate.exitCode).toBe(0); expect(mutate.stdout.trim()).toBe('original\noriginal');
    const dir = overlay.dir; await overlay.cleanup(); overlay = undefined;
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await overlay?.cleanup(); await rm(source,{recursive:true,force:true}); }
});
