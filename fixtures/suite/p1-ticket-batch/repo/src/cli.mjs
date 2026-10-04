import { createMaintenance as create0, registerMaintenance as register0 } from './csv/maintenance.mjs';
import { createMaintenance as create1, registerMaintenance as register1 } from './ratelimit/maintenance.mjs';
import { createMaintenance as create2, registerMaintenance as register2 } from './cache/maintenance.mjs';
import { createMaintenance as create3, registerMaintenance as register3 } from './semver/maintenance.mjs';
import { createRegistry, formatHelp, createDispatcher } from './runtime/registry.mjs';
import { createLogger } from './runtime/diagnostics.mjs';
import { loadConfig } from './runtime/config.mjs';
import { parseArguments, formatUsage } from './runtime/arguments.mjs';
import { collectJsonLines } from './runtime/json-lines.mjs';
import { pathToFileURL } from 'node:url';

const flags = {
  help: { type: 'boolean', alias: 'h', description: 'Show local commands' },
  command: { type: 'string', alias: 'c', description: 'Administration command' },
  output: { type: 'string', default: 'json', choices: ['json', 'ndjson'], description: 'Output encoding' },
};
export function createApplication({ now = () => 0, sink = () => {}, config = {} } = {}) {
  const settings = loadConfig(config);
  const registry = createRegistry();
  register0(registry, create0({ now }));
  register1(registry, create1({ now }));
  register2(registry, create2({ now }));
  register3(registry, create3({ now }));
  registry.seal();
  const logger = createLogger({ now, sink, level: settings.logLevel, context: { service: settings.service } });
  return {
    commands: () => registry.describe(),
    help: () => formatHelp(registry),
    execute: createDispatcher(registry, logger),
  };
}
export async function runCli(argv, { input, output, diagnostics }) {
  const { options } = parseArguments(argv, flags);
  const app = createApplication({ sink: diagnostics });
  if (options.help || !options.command) {
    output(formatUsage('toolkit', flags) + '\n\n' + app.help() + '\n');
    return 0;
  }
  const values = await collectJsonLines(input);
  const results = [];
  for (const value of values.length ? values : [{}]) {
    results.push(await app.execute(options.command, value));
  }
  if (options.output === 'ndjson') {
    for (const result of results) output(JSON.stringify(result) + '\n');
  } else output(JSON.stringify(results, null, 2) + '\n');
  return results.every(result => result.ok) ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      input: process.stdin,
      output: text => process.stdout.write(text),
      diagnostics: text => process.stderr.write(text + '\n'),
    });
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.code || 'CLI_INPUT' }) + '\n');
    process.exitCode = 1;
  }
}
