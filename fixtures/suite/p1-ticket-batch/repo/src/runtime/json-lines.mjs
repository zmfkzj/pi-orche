/** Streaming JSON lines codec used by the CLI, unrelated to CSV parsing. */
export async function* readJsonLines(chunks, { maxBytes = 1048576 } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let carry = '';
  let line = 0;
  function parse(text) {
    line++;
    if (!text.trim()) return undefined;
    if (Buffer.byteLength(text) > maxBytes) throw new RangeError('JSON line too large');
    try {
      return { line, value: JSON.parse(text) };
    } catch (error) {
      throw new SyntaxError('Invalid JSON on line ' + line, { cause: error });
    }
  }
  for await (const chunk of chunks) {
    carry += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = carry.indexOf('\n')) >= 0) {
      const text = carry.slice(0, newline).replace(/\r$/, '');
      carry = carry.slice(newline + 1);
      const item = parse(text);
      if (item) yield item;
    }
    if (Buffer.byteLength(carry) > maxBytes) throw new RangeError('JSON line too large');
  }
  carry += decoder.decode();
  if (carry) {
    const item = parse(carry);
    if (item) yield item;
  }
}
export async function* encodeJsonLines(values) {
  for await (const value of values) {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError('Cannot encode undefined');
    yield text + '\n';
  }
}
export async function collectJsonLines(chunks, options) {
  const values = [];
  for await (const item of readJsonLines(chunks, options)) values.push(item.value);
  return values;
}
export function stableJson(value) {
  function canonical(input) {
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(canonical);
    return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]));
  }
  return JSON.stringify(canonical(value));
}
export function jsonPointer(value, path) {
  if (path === '') return value;
  if (!path.startsWith('/')) throw new Error('Invalid JSON pointer');
  return path.slice(1).split('/').reduce((current, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return current !== null && typeof current === 'object' && Object.hasOwn(current, key)
      ? current[key] : undefined;
  }, value);
}
