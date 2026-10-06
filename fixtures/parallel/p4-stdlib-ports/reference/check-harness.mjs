// Harness check (not a solution): runs hidden/test/acceptance.test.mjs against modules that forward every call to CPython
// through bridge.py. Every case must pass, which shows the documented JS shapes, the harness and the expectations agree.
// Usage: node reference/check-harness.mjs   (from fixtures/parallel/p4-stdlib-ports; about a minute)
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = dirname(here);
const work = mkdtempSync(join(tmpdir(), 'p4-harness-'));
try {
  cpSync(join(fixture, 'hidden'), work, { recursive: true });
  const bridge = (module, names, classes = '') => `import { execFileSync } from 'node:child_process';
const call = (fn, args, ctor) => { const out = JSON.parse(execFileSync('python3', [${JSON.stringify(join(here, 'bridge.py'))}, ${JSON.stringify(module)}, fn, JSON.stringify(args), ...(ctor ? [JSON.stringify(ctor)] : [])], { encoding: 'utf8' }));
  if (out.error) { const error = new Error(out.message); error.name = out.error; throw error; } return out.value; };
${names.map(name => `export const ${name} = (...args) => call(${JSON.stringify(name)}, args);`).join('\n')}
${classes}`;
  const files = {
    'src/text/textwrap.mjs': bridge('textwrap', ['wrap', 'fill', 'shorten', 'dedent', 'indent']),
    'src/text/shlex.mjs': bridge('shlex', ['split', 'quote', 'join']),
    'src/difflib/index.mjs': bridge('difflib', ['unifiedDiff', 'contextDiff', 'ndiff', 'restore', 'getCloseMatches'],
      `export class SequenceMatcher { constructor(...ctor) { this.ctor = ctor; }
${['getMatchingBlocks', 'getOpcodes', 'getGroupedOpcodes', 'ratio', 'quickRatio', 'findLongestMatch'].map(name => `  ${name}(...args) { return call('SequenceMatcher.${name}', args, this.ctor); }`).join('\n')}
}`),
    'src/urlparse/index.mjs': bridge('urlparse', ['urlsplit', 'urlunsplit', 'urlparse', 'urlunparse', 'urljoin', 'urldefrag', 'quote', 'quotePlus', 'unquote', 'unquotePlus', 'urlencode', 'parseQsl', 'parseQs']),
  };
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(work, file)), { recursive: true }); writeFileSync(join(work, file), text); }
  process.stdout.write(execFileSync(process.execPath, ['--test', 'test/acceptance.test.mjs'], { cwd: work, encoding: 'utf8' }).split('\n').filter(line => /^(# |ℹ )(tests|pass|fail) /.test(line)).join('\n') + '\n');
} finally { rmSync(work, { recursive: true, force: true }); }
