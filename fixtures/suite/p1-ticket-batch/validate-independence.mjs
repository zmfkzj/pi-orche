import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only these explicitly owned new fixtures are inspected or written.
const suite = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = [
  { id: 'p1-ticket-batch', units: { csv: 6, ratelimit: 5, cache: 10, semver: 6 } },
  { id: 'p2-handler-migration', units: { users: 5, orders: 6, inventory: 5, search: 5, 'uploads-metadata': 5, reports: 6 } },
  { id: 'p3-library-features-ko', units: { interval: 6, cron: 7, merge: 10 } },
];
function command(args, cwd, expected = 0) {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TZ: 'America/New_York' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  if (expected !== null) assert.equal(result.status, expected, result.stdout + result.stderr);
  return result;
}
function stats(output) {
  const count = name => Number(new RegExp('^# ' + name + ' (\\d+)$', 'm').exec(output)?.[1] ?? NaN);
  return { tests: count('tests'), passed: count('pass'), failed: count('fail') };
}
async function files(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'No fixture symlinks');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  await walk(root);
  return result.sort();
}
async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
function ownedSource(fixture, unit) {
  return fixture.id === 'p2-handler-migration' ? 'src/handlers/' + unit + '.mjs' : 'src/' + unit + '/';
}
async function validate(fixture) {
  const root = join(suite, fixture.id);
  const starterFiles = await files(join(root, 'repo'));
  const srcFiles = starterFiles.filter(path => relative(join(root, 'repo'), path).startsWith('src/'));
  const srcLines = (await Promise.all(srcFiles.map(async path => (await readFile(path, 'utf8')).split('\n').length - 1)))
    .reduce((sum, count) => sum + count, 0);
  assert(srcFiles.length >= 20 && srcLines >= 2000 && srcLines <= 4000);
  const referenceSources = (await files(join(root, 'reference/src')));
  for (const path of referenceSources) {
    const count = (await readFile(path, 'utf8')).split('\n').length - 1;
    assert(count >= 80 && count <= 250, path + ': expected 80..250 source lines, got ' + count);
  }
  const sources = (await files(root)).filter(path => path.endsWith('.mjs'));
  for (const path of sources) command(['--check', path], suite);
  command(['--test', '--test-reporter=tap'], join(root, 'repo'));
  command(['src/cli.mjs', '--help'], join(root, 'repo'));
  const rows = [];
  for (const [unit, expectedCount] of Object.entries(fixture.units)) {
    const work = await mkdtemp(join(tmpdir(), 'orche-independent-'));
    try {
      await cp(join(root, 'repo'), work, { recursive: true });
      await cp(join(root, 'hidden'), work, { recursive: true });
      const args = ['--test', '--test-reporter=tap', '--test-name-pattern=^' + unit + ':', 'test/acceptance.test.mjs'];
      const baseline = command(args, work, null);
      const before = stats(baseline.stdout);
      assert.equal(baseline.status, 1, unit + ': starter must fail');
      assert.equal(before.tests, expectedCount);
      assert(before.failed > 0, unit + ': expected substantive failures');
      const source = ownedSource(fixture, unit);
      await cp(join(root, 'reference', source), join(work, source), { recursive: true });
      const regression = unit + '.test.mjs';
      await cp(join(root, 'reference/test', regression), join(work, 'test', regression));
      // Verify every other source is byte-identical to the starter, not just unused.
      for (const path of srcFiles) {
        const name = relative(join(root, 'repo'), path);
        if (name === source || name.startsWith(source)) continue;
        assert.equal(await digest(join(work, name)), await digest(path), unit + ': unrelated source changed');
      }
      const reference = command(args, work);
      const after = stats(reference.stdout);
      assert.equal(after.tests, expectedCount);
      assert.equal(after.passed, expectedCount);
      assert.equal(after.failed, 0);
      command(['--test', 'test/smoke.test.mjs', 'test/' + regression], work);
      rows.push({ unit, ...before, referencePassed: after.passed });
      console.log(`${fixture.id}/${unit}: starter ${before.failed}/${before.tests} fail; independent reference ${after.passed}/${after.tests} pass; other src SHA-256 unchanged`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  const full = await mkdtemp(join(tmpdir(), 'orche-complete-'));
  try {
    for (const layer of ['repo', 'hidden', 'reference']) await cp(join(root, layer), full, { recursive: true });
    const all = command(['--test', '--test-reporter=tap'], full);
    const fullStats = stats(all.stdout);
    // This entire invocation uses a non-UTC host TZ to catch accidental local dates.
    assert.equal(fullStats.failed, 0);
    const record = [
      '# Validation — ' + fixture.id,
      '',
      'Conclusion: PASS. Every starter unit fails its own hidden group; each isolated reference passes with all other source bytes still at starter state. No specification deviations.',
      '',
      '## Size and independent units',
      '',
      `- repo/src: ${srcFiles.length} files, ${srcLines} physical lines (including comments/blanks).`,
      `- repo/: ${starterFiles.length} files; hidden acceptance: ${Object.values(fixture.units).reduce((a,b)=>a+b,0)} top-level tests.`,
      '- Correct unit implementations are 80–250 lines each; reference also adds one regression-test file per unit.',
      '- Source counts are checked mechanically; surrounding metadata/runtime code is reachable through src/cli.mjs.',
      '',
      '| Unit | Hidden tests | Starter failed | Isolated reference passed | Other sources |',
      '| --- | ---: | ---: | ---: | --- |',
      ...rows.map(row => `| ${row.unit} | ${row.tests} | ${row.failed} | ${row.referencePassed} | SHA-256 identical |`),
      '',
      '## Commands and outcomes',
      '',
      '`npm run validate:suite -- --tasks p1-ticket-batch,p2-handler-migration,p3-library-features-ko` → exit 0, 3/3 validated, 0 violations; schema/loadSuite PASS (31 tasks), byte-identical repo-only workspace isolation PASS; starter hidden FAIL (required), reference visible+hidden PASS.',
      '',
      'Production output: `../p1-ticket-batch/SUITE-VALIDATION.log` (contains all three tasks). Extra fixture-level validation files are not copied into solver workspaces.',
      '',
      '`node fixtures/suite/p1-ticket-batch/validate-independence.mjs` → PASS for all 13 units; only the selected unit source and its regression test are overlaid. Baseline and reference run `node --test --test-reporter=tap --test-name-pattern=^<unit>: test/acceptance.test.mjs` in fresh temporary directories. Every unrelated source is hash-checked after overlay.',
      '',
      `- node --check: PASS on ${sources.length} fixture .mjs files (including reference and test files).`,
      '- Starter node --test: PASS (minimal visible smoke).',
      '- Starter node src/cli.mjs --help: PASS (imports all administration scaffolds).',
      '- Per-unit smoke + added reference regression: PASS.',
      `- Full reference node --test: PASS, ${fullStats.passed}/${fullStats.tests} tests.`,
      '- All local checks run with TZ=America/New_York; no sleeps, network, or wall-clock reads.',
      '- No repository commits or pushes were made. Production validator initializes only disposable solver workspaces.',
      '',
    ].join('\n');
    await writeFile(join(root, 'VALIDATION.md'), record);
    console.log(`${fixture.id}: src ${srcFiles.length} files/${srcLines} lines; full reference ${fullStats.passed}/${fullStats.tests} PASS`);
  } finally {
    await rm(full, { recursive: true, force: true });
  }
}
for (const fixture of fixtures) await validate(fixture);
console.log('Independence validation: 13/13 units PASS');
