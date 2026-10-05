// Configuration precedence (highest first): CLI flags > environment > config/app.json > defaults.
import { readFileSync } from 'node:fs';

const defaults = { port: 3000, host: '127.0.0.1' };

function fromCli(argv) {
  const config = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') config.port = Number(argv[++i]);
    if (argv[i] === '--host') config.host = argv[++i];
  }
  return config;
}

function fromEnv(env) {
  const config = {};
  if (env.PORT) config.port = Number(env.PORT);
  if (env.HOST) config.host = env.HOST;
  return config;
}

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const fileConfig = JSON.parse(readFileSync(new URL('../config/app.json', import.meta.url), 'utf8'));
  const cliConfig = fromCli(argv);
  const envConfig = fromEnv(env);
  return { ...defaults, ...fileConfig, ...cliConfig, ...envConfig };
}
