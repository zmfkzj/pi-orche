/** Small deterministic CLI argument parser. No process globals are consulted. */
export function parseArguments(argv, specification) {
  const options = {};
  const positional = [];
  const aliases = new Map();
  for (const [name, spec] of Object.entries(specification)) {
    if (spec.alias) aliases.set(spec.alias, name);
    if (spec.default !== undefined) options[name] = structuredClone(spec.default);
  }
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== 'string') throw new TypeError('Arguments must be strings');
    if (literal || !token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    const long = token.startsWith('--');
    const raw = token.slice(long ? 2 : 1);
    const equal = raw.indexOf('=');
    const key = equal < 0 ? raw : raw.slice(0, equal);
    const name = long ? key : aliases.get(key);
    if (!name || !Object.hasOwn(specification, name)) throw new Error('Unknown flag: ' + token);
    const spec = specification[name];
    let value = equal < 0 ? undefined : raw.slice(equal + 1);
    if (spec.type === 'boolean') {
      if (value !== undefined) throw new Error('Boolean flag does not take a value');
      value = true;
    } else {
      if (value === undefined) value = argv[++i];
      if (value === undefined) throw new Error('Missing flag value: ' + name);
      if (spec.type === 'integer') {
        if (!/^-?\d+$/.test(value)) throw new TypeError('Expected integer: ' + name);
        value = Number(value);
        if (!Number.isSafeInteger(value)) throw new RangeError('Unsafe integer: ' + name);
      }
      if (spec.choices && !spec.choices.includes(value)) throw new Error('Invalid choice: ' + name);
    }
    if (spec.repeat) {
      if (!Array.isArray(options[name])) options[name] = [];
      options[name].push(value);
    } else options[name] = value;
  }
  for (const [name, spec] of Object.entries(specification)) {
    if (spec.required && options[name] === undefined) throw new Error('Required flag: ' + name);
  }
  return { options, positional };
}
export function formatUsage(command, specification) {
  const rows = Object.entries(specification).map(([name, spec]) => {
    const alias = spec.alias ? '-' + spec.alias + ', ' : '    ';
    const value = spec.type === 'boolean' ? '' : ' <' + spec.type + '>';
    return { flag: alias + '--' + name + value, description: spec.description || '' };
  });
  const width = Math.max(0, ...rows.map(row => row.flag.length));
  return [
    'Usage: ' + command + ' [options]',
    '',
    ...rows.map(row => '  ' + row.flag.padEnd(width) + '  ' + row.description),
  ].join('\n');
}
export function splitCommand(argv) {
  if (!argv.length) return { command: 'help', args: [] };
  return { command: argv[0], args: argv.slice(1) };
}
