function fail(code) {
  throw Object.assign(new Error(code), { code });
}
const numeric = /^(0|[1-9]\d*)$/;
function parse(text, partial = false) {
  if (typeof text !== 'string') fail(partial ? 'SEMVER_RANGE' : 'SEMVER_VERSION');
  const match = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(text);
  const bad = () => fail(partial ? 'SEMVER_RANGE' : 'SEMVER_VERSION');
  if (!match) bad();
  const parts = match.slice(1, 4);
  let wildcard = false;
  const nums = [];
  for (const part of parts) {
    if (part === undefined || /^[xX*]$/.test(part)) wildcard = true;
    else {
      if (wildcard || !numeric.test(part) || !Number.isSafeInteger(Number(part))) bad();
      nums.push(Number(part));
    }
  }
  if (!partial && nums.length !== 3) bad();
  if (match[4] && nums.length !== 3) bad();
  const pre = match[4] ? match[4].split('.') : [];
  for (const item of pre) {
    if (!item || (/^\d+$/.test(item) && !numeric.test(item))) bad();
  }
  if (match[5] && match[5].split('.').some(item => !item)) bad();
  return { nums: [...nums, ...Array(3 - nums.length).fill(0)], count: nums.length, pre };
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
const release = nums => ({ nums, count: 3, pre: [] });
function upper(p, kind) {
  const n = [...p.nums];
  let index;
  if (kind === '^') {
    index = n.findIndex(value => value !== 0);
    if (index < 0) index = Math.max(0, p.count - 1);
    index = Math.min(index, Math.max(0, p.count - 1));
  } else index = kind === '~' ? (p.count < 2 ? 0 : 1) : Math.max(0, p.count - 1);
  n[index]++;
  for (let i = index + 1; i < 3; i++) n[i] = 0;
  return release(n);
}
function compile(clause) {
  const checks = [];
  const anchors = [];
  function add(op, p) {
    if (p.pre.length) anchors.push(p);
    checks.push(v => {
      const c = compare(v, p);
      return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
    });
  }
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(clause);
  if (hyphen) {
    const low = parse(hyphen[1], true), high = parse(hyphen[2], true);
    if (low.count) add('>=', low);
    if (high.count) add(high.count === 3 ? '<=' : '<', high.count === 3 ? high : upper(high));
  } else {
    for (const token of clause.split(/\s+/)) {
      const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
      if (!m) fail('SEMVER_RANGE');
      const op = m[1] || '', p = parse(m[2], true);
      if (['>=', '<=', '>', '<'].includes(op)) {
        if (p.count !== 3) fail('SEMVER_RANGE');
        add(op, p);
      } else if (op === '^' || op === '~') {
        if (p.count) {
          add('>=', p);
          add('<', upper(p, op));
        }
      } else if (p.count === 3) add('=', p);
      else if (p.count) {
        add('>=', p);
        add('<', upper(p));
      }
    }
  }
  return v => checks.every(fn => fn(v)) && (!v.pre.length || anchors.some(p => p.nums.every((n, i) => n === v.nums[i])));
}
export function satisfies(version, range) {
  const v = parse(version);
  if (typeof range !== 'string' || !range.trim()) fail('SEMVER_RANGE');
  const clauses = range.split('||').map(s => s.trim());
  if (clauses.some(s => !s)) fail('SEMVER_RANGE');
  const matchers = clauses.map(compile);
  return matchers.some(fn => fn(v));
}
