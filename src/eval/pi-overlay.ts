import { mkdtemp, chmod, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runProcess } from './omp-runner.js';
import { buildStudyArm } from './arms.js';
import { benchmarkModel } from './systems.js';
import { evalRunLimits } from './limits.js';

/** Never copy global prompts/extensions/settings. Secrets live outside the solver workspace and result tree. */
export async function preparePiOverlay(timeoutSec: number, baseModel = benchmarkModel) {
  const dir = await mkdtemp(join(tmpdir(), 'bench3-pi-agent-'));
  await chmod(dir, 0o700);
  try {
    let source = 'Pi auth.json (read-only copy)';
    const auth: Record<string, unknown> = JSON.parse(await readFile(join(homedir(), '.pi/agent/auth.json'), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}'; throw error;
    }));
    if (baseModel.startsWith('openai-codex/') && !auth['openai-codex']) {
      // Python sqlite is available on the benchmark host. Read-only URI prevents even SQLite housekeeping writes.
      const code = `import sqlite3,json,sys,os\nc=sqlite3.connect('file:'+os.path.expanduser('~/.omp/agent/agent.db')+'?mode=ro',uri=True)\nrows=c.execute("SELECT data FROM auth_credentials WHERE provider='openai-codex' AND credential_type='oauth' AND disabled_cause IS NULL ORDER BY updated_at DESC,id DESC").fetchall()\nif not rows: raise RuntimeError('No enabled omp codex credential')\nd=json.loads(rows[0][0]); d['type']='oauth'\nwith open(sys.argv[1],'w') as f: json.dump({'openai-codex':d},f)\nos.chmod(sys.argv[1],0o600)`;
      const result = await runProcess('python3', ['-c', code, join(dir, 'auth.json')], { cwd: dir, timeoutMs: 10_000 });
      if (result.exitCode !== 0) throw new Error('Cannot create read-only codex OAuth overlay: ' + result.stderr);
      source = 'omp agent.db enabled OAuth (read-only SQLite copy; refresh writes overlay only)';
    } else {
      await writeFile(join(dir, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
    }
    const settings = { defaultProvider: baseModel.split('/')[0], defaultModel: baseModel.split('/').slice(1).join('/'), defaultThinkingLevel: 'high', transport: 'sse', enableInstallTelemetry: false, enableAnalytics: false };
    const config = { ...buildStudyArm('C0', baseModel).routes, mainMode: 'single', limits: evalRunLimits(timeoutSec) };
    await writeFile(join(dir, 'settings.json'), JSON.stringify(settings));
    await writeFile(join(dir, 'orche.config.json'), JSON.stringify(config));
    return { dir, settings, config, credentialSource: source, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
