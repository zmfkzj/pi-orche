function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}
/** LCS ties delete from base before inserting variant lines. */
function edits(base, variant) {
  const n = base.length, m = variant.length;
  const table = Array.from({length:n + 1},() => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = base[i] === variant[j] ? 1 + table[i+1][j+1] : Math.max(table[i+1][j],table[i][j+1]);
    }
  }
  const result = [];
  let i = 0, j = 0, current = null;
  const close = () => {
    if (current) result.push(current);
    current = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === variant[j]) {
      close(); i++; j++;
    } else {
      if (!current) current = { start:i, end:i, replacement:[] };
      if (i < n && (j === m || table[i+1][j] >= table[i][j+1])) {
        i++; current.end = i;
      } else {
        current.replacement.push(variant[j++]);
      }
    }
  }
  close();
  return result;
}
function overlaps(a,b) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return Math.max(a.start,b.start) < Math.min(a.end,b.end);
}
function apply(base,start,end,changes) {
  let cursor = start;
  const output = [];
  for (const change of changes.sort((a,b) => a.start - b.start || a.end - b.end)) {
    output.push(...base.slice(cursor,change.start), ...change.replacement);
    cursor = change.end;
  }
  output.push(...base.slice(cursor,end));
  return output.join('');
}
const terminated = text => !text || text.endsWith('\n') ? text : text + '\n';

export function merge3(base,ours,theirs) {
  if ([base,ours,theirs].some(text => typeof text !== 'string')) {
    throw Object.assign(new Error('Expected text'),{code:'MERGE_INPUT'});
  }
  if (ours === theirs) return {text:ours,conflicts:0};
  if (ours === base) return {text:theirs,conflicts:0};
  if (theirs === base) return {text:ours,conflicts:0};
  const original = lines(base);
  const all = [
    ...edits(original,lines(ours)).map(edit => ({...edit,side:'ours'})),
    ...edits(original,lines(theirs)).map(edit => ({...edit,side:'theirs'})),
  ];
  // Connected components of cross-side overlaps, rather than one huge conflict.
  const unused = new Set(all);
  const components = [];
  while (unused.size) {
    const group = [unused.values().next().value];
    unused.delete(group[0]);
    for (let i = 0; i < group.length; i++) {
      for (const item of unused) {
        if (group[i].side !== item.side && overlaps(group[i],item)) {
          group.push(item); unused.delete(item);
        }
      }
    }
    components.push(group);
  }
  components.sort((a,b) => Math.min(...a.map(e=>e.start)) - Math.min(...b.map(e=>e.start)) ||
    Math.max(...a.map(e=>e.end)) - Math.max(...b.map(e=>e.end)));
  let cursor = 0, text = '', conflicts = 0;
  for (const group of components) {
    const start = Math.min(...group.map(e=>e.start));
    const end = Math.max(...group.map(e=>e.end));
    text += original.slice(cursor,start).join('');
    const a = group.filter(e=>e.side === 'ours'), b = group.filter(e=>e.side === 'theirs');
    if (!a.length || !b.length) text += apply(original,start,end,group);
    else {
      const left = apply(original,start,end,a), right = apply(original,start,end,b);
      if (left === right) text += left;
      else {
        if (text && !text.endsWith('\n')) text += '\n';
        text += '<<<<<<< OURS\n' + terminated(left) +
          '||||||| BASE\n' + terminated(original.slice(start,end).join('')) +
          '=======\n' + terminated(right) + '>>>>>>> THEIRS\n';
        conflicts++;
      }
    }
    cursor = end;
  }
  text += original.slice(cursor).join('');
  return {text,conflicts};
}
