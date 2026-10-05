import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const sharp = require('sharp');
const dir = process.argv[2];
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
async function image(path, width, height) {
  const file = join(dir, path);
  if (!existsSync(file)) { failures.push(`${path} missing`); return undefined; }
  const meta = await sharp(file).metadata().catch(() => undefined);
  if (!meta) { failures.push(`${path} is not a readable image`); return undefined; }
  check(meta.format === 'png', `${path} is ${meta.format}, not png`);
  if (width) check(meta.width === width && meta.height === height, `${path} is ${meta.width}x${meta.height}, not ${width}x${height}`);
  return { file, meta };
}
async function alphaRegion(file, left, top, width, height) {
  const { data, info } = await sharp(file).ensureAlpha().extract({ left, top, width, height }).raw().toBuffer({ resolveWithObject: true });
  let clear = 0; for (let i = 3; i < data.length; i += info.channels) if (data[i] <= 16) clear++;
  return clear / (width * height);
}
const text = path => existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : undefined;
const template = text('themes/_template.css') ?? '';
const theme = text('themes/night-market.css');
check(theme !== undefined, 'themes/night-market.css missing');
const names = [...template.matchAll(/(--[a-z-]+)\s*:/g)].map(match => match[1]);
const values = Object.fromEntries([...(theme ?? '').matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)].map(match => [match[1], match[2]]));
for (const name of names) check(values[name], `${name} missing or not a hex colour`);
const lum = hex => { let h = hex.slice(1); if (h.length === 3) h = [...h].map(c => c + c).join(''); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
if (values['--text'] && values['--bg']) { const [a, b] = [lum(values['--text']), lum(values['--bg'])].sort((x, y) => y - x); check((a + 0.05) / (b + 0.05) >= 4.5, 'contrast of --text on --bg below 4.5'); }
check(/night market/i.test(text('docs/themes.md') ?? ''), 'docs/themes.md has no night market section');

if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log('hard constraints met');
