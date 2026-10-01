import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseLogs, parseInstant } from './parser.js';
import { aggregate } from './aggregate.js';
import { renderSummary, renderCSV } from './report.js';

const USAGE = 'Usage: logtool [--help] [--csv <file>] <input.jsonl>';

/** Parse argv without reading files, so usage errors cannot create output. */
export function parseArgs(argv) {
  const options = { input: null, help: false, csv: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--csv') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing --csv file');
      options.csv = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.input !== null) {
      throw new Error('Only one input file is supported');
    } else {
      options.input = arg;
    }
  }
  if (!options.help && options.input === null) throw new Error('Missing input file');
  return options;
}

/**
 * Returns an exit code rather than terminating the hosting process.
 * io accepts readFile/writeFile async functions and stdout/stderr callbacks.
 * The executable wrapper below is the only place that sets process.exitCode.
 */
export async function main(argv, io = {}) {
  const ports = {
    readFile: io.readFile ?? readFile,
    writeFile: io.writeFile ?? writeFile,
    stdout: io.stdout ?? (text => process.stdout.write(text)),
    stderr: io.stderr ?? (text => process.stderr.write(text)),
  };
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    ports.stderr(`logtool: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    ports.stdout(USAGE + '\n');
    return 0;
  }
  try {
    const text = await ports.readFile(options.input, 'utf8');
    const parsed = parseLogs(text);
    const result = aggregate(parsed.records);
    if (options.csv !== null) await ports.writeFile(options.csv, renderCSV(result), 'utf8');
    ports.stdout(renderSummary(result, parsed.skipped));
    return 0;
  } catch (error) {
    ports.stderr(`logtool: ${error.message}\n`);
    return 1;
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) process.exitCode = await main(process.argv.slice(2));
