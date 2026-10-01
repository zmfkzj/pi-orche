import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const files = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter(f => /\.(?:[cm]?js)$/.test(f));
const source = new Map(files.map(f => [path.join(root, 'src', f), fs.readFileSync(path.join(root, 'src', f), 'utf8')]));
// Rate ownership is independent of variable names and file names.
const owners = [...source].filter(([, text]) => /\bUS\b/.test(text) && /\bGB\b/.test(text) && /\bCA\b/.test(text) && /(?:0?\.0?7\b|\b7\b|\b700\b)/.test(text) && /(?:0?\.(?:19|2)\b|\b19\b|\b20\b|\b1900\b|\b2000\b)/.test(text));
const reaches = (file, target, seen = new Set()) => {
  if (file === target) return true;
  if (seen.has(file)) return false;
  seen.add(file);
  const text = source.get(file) ?? '';
  const imports = [...text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map(m => path.resolve(path.dirname(file), m[1]));
  return imports.some(next => reaches(next, target, seen));
};
const passed = owners.length === 1 && ['cart.js', 'estimate.js', 'invoice.js'].every(f => reaches(path.join(root, 'src', f), owners[0][0]));
console.log(JSON.stringify({ passed, details: { rateOwners: owners.map(([f]) => path.relative(root, f)), sharedByAllPaths: passed } }));
process.exitCode = passed ? 0 : 1;
