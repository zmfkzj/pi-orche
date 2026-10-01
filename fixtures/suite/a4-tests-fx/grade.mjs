import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const workspace = path.resolve(process.argv[2]);
const here = path.dirname(fileURLToPath(import.meta.url));
const original = path.join(here, 'repo');
const read = f => fs.readFileSync(f, 'utf8');
const production = fs.readdirSync(path.join(original, 'src'), { recursive: true }).filter(f => f.endsWith('.js'));
const unchanged = production.every(f => fs.existsSync(path.join(workspace, 'src', f)) && read(path.join(workspace, 'src', f)) === read(path.join(original, 'src', f)));
const tests = fs.readdirSync(path.join(workspace, 'test'), { recursive: true }).filter(f => /\.(?:[cm]?js)$/.test(f) && (!fs.existsSync(path.join(original, 'test', f)) || read(path.join(workspace, 'test', f)) !== read(path.join(original, 'test', f))));
const run = dir => {
  const r = spawnSync(process.execPath, ['--test', ...tests.map(f => path.join('test', f))], { cwd: dir, timeout: 4000, encoding: 'utf8' });
  return { ok: r.status === 0 && !r.error, timeout: r.error?.code === 'ETIMEDOUT' };
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-fx-grade-'));
const details = { unchanged, tests, correctPass: false, mutants: {} };
try {
  if (unchanged && tests.length) {
    const correct = path.join(temp, 'correct');
    fs.cpSync(workspace, correct, { recursive: true });
    details.correctPass = run(correct).ok;
    for (const mutant of fs.readdirSync(path.join(here, 'hidden', 'mutants'))) {
      const dir = path.join(temp, mutant);
      fs.cpSync(workspace, dir, { recursive: true });
      fs.cpSync(path.join(here, 'hidden', 'mutants', mutant), dir, { recursive: true });
      const result = run(dir);
      details.mutants[mutant] = !result.ok && !result.timeout;
    }
  }
  const passed = unchanged && tests.length > 0 && details.correctPass && Object.keys(details.mutants).length === 6 && Object.values(details.mutants).every(Boolean);
  console.log(JSON.stringify({ passed, details }));
  process.exitCode = passed ? 0 : 1;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
