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
let tagline; try { tagline = JSON.parse(text('store/tagline.json') ?? ''); } catch { failures.push('store/tagline.json missing or invalid JSON'); }
if (tagline) {
  check(typeof tagline.en === 'string' && tagline.en.length > 0 && tagline.en.length <= 60, 'en missing or longer than 60');
  check(typeof tagline.ko === 'string' && tagline.ko.length > 0 && [...tagline.ko].length <= 30, 'ko missing or longer than 30');
  check(!/\b(epic|ultimate)\b/i.test(tagline.en ?? '') && !/에픽|궁극/.test(tagline.ko ?? ''), 'banned word used');
}

if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log('hard constraints met');
