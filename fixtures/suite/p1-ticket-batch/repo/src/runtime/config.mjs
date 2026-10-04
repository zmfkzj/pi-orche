/** Configuration parsing for the local process; never reads environment implicitly. */
const defaults = Object.freeze({
  service: 'toolkit',
  logLevel: 'info',
  output: 'json',
  batchSize: 50,
  maxInputBytes: 1048576,
  strict: true,
});
const levels = new Set(['debug', 'info', 'warn', 'error', 'silent']);
const formats = new Set(['json', 'table', 'ndjson']);
function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError('Configuration integer is out of range');
  }
  return value;
}
function boolean(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new TypeError('Configuration boolean must be true or false');
}
export function loadConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Configuration must be an object');
  }
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(defaults, key));
  if (unknown.length) throw new Error('Unknown configuration: ' + unknown.join(', '));
  const service = input.service ?? defaults.service;
  if (typeof service !== 'string' || !/^[a-z][a-z0-9-]*$/.test(service)) {
    throw new TypeError('Invalid service name');
  }
  const logLevel = input.logLevel ?? defaults.logLevel;
  const output = input.output ?? defaults.output;
  if (!levels.has(logLevel)) throw new Error('Unknown log level');
  if (!formats.has(output)) throw new Error('Unknown output format');
  return Object.freeze({
    service,
    logLevel,
    output,
    batchSize: integer(input.batchSize, defaults.batchSize, 1, 10000),
    maxInputBytes: integer(input.maxInputBytes, defaults.maxInputBytes, 1, 67108864),
    strict: boolean(input.strict, defaults.strict),
  });
}
export function configFromEnvironment(env) {
  const input = {};
  const mapping = {
    TOOLKIT_SERVICE: 'service',
    TOOLKIT_LOG_LEVEL: 'logLevel',
    TOOLKIT_OUTPUT: 'output',
    TOOLKIT_BATCH_SIZE: 'batchSize',
    TOOLKIT_MAX_BYTES: 'maxInputBytes',
    TOOLKIT_STRICT: 'strict',
  };
  for (const [source, target] of Object.entries(mapping)) {
    if (env[source] !== undefined) input[target] = env[source];
  }
  return loadConfig(input);
}
export function describeConfig() {
  return Object.entries(defaults).map(([name, value]) => ({
    name,
    type: typeof value,
    default: value,
  }));
}
export function withConfig(base, patch) {
  return loadConfig({ ...base, ...patch });
}
