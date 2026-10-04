/** Explicit local command registry; package loading is never dynamic or remote. */
export function createRegistry() {
  const commands = new Map();
  let sealed = false;
  return {
    register(name, definition) {
      if (sealed) throw new Error('Registry is sealed');
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new TypeError('Invalid command name');
      if (commands.has(name)) throw new Error('Duplicate command: ' + name);
      if (typeof definition.run !== 'function') throw new TypeError('Command run required');
      commands.set(name, {
        run: definition.run,
        description: String(definition.description || ''),
        options: structuredClone(definition.options || {}),
      });
      return this;
    },
    seal() {
      sealed = true;
      return this;
    },
    has(name) {
      return commands.has(name);
    },
    describe() {
      return [...commands].map(([name, definition]) => ({
        name,
        description: definition.description,
        options: structuredClone(definition.options),
      })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async execute(name, input, context = {}) {
      const definition = commands.get(name);
      if (!definition) throw Object.assign(new Error('Unknown command'), { code: 'COMMAND_UNKNOWN' });
      return definition.run(input, context);
    },
  };
}
export function formatHelp(registry) {
  const commands = registry.describe();
  const width = Math.max(0, ...commands.map(command => command.name.length));
  return commands.map(command => command.name.padEnd(width) + '  ' + command.description).join('\n');
}
export function createDispatcher(registry, logger) {
  let sequence = 0;
  return async function execute(name, input) {
    const requestId = 'local-' + ++sequence;
    const child = logger.child({ requestId, command: name });
    child.info('command.started');
    try {
      const value = await registry.execute(name, input, { requestId, logger: child });
      child.info('command.completed');
      return { requestId, ok: true, value };
    } catch (error) {
      child.warn('command.failed', { code: error?.code || 'INTERNAL' });
      return { requestId, ok: false, error: { code: error?.code || 'INTERNAL' } };
    }
  };
}
