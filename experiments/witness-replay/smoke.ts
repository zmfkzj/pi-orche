/**
 * Harness smoke (NOT a counted revision session; README.md "Smoke"): the full stack of a unit - unit proxy (route guard, budget,
 * key substitution, start journal), the sandbox (no network, hidden home/repository/tmp), the bridge and Pi in JSON print mode -
 * on a throwaway workspace with a trivial prompt, plus a model-free isolation probe inside the same sandbox binds.
 * With WITNESS_REPLAY_UPSTREAM pointing at experiments/ultra-ho/dry-upstream.mjs no model is called at all.
 *   node --import tsx experiments/witness-replay/cli.ts smoke <out> <scratch>    → <out>/smoke/<timestamp>/
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT, BRIDGE_MOUNT, BRIDGE_PORT, HERE, LAUNCH_MOUNT, NODE, NODE_DIR, PI_CLI, PI_MODULES, PLACEHOLDER_KEY, PROVIDER_MOUNT, REPO, SOCKET_MOUNT, UPSTREAM, writeJson } from "./env.js";
import { EFFORT, MODEL, MODEL_REF, piSettings } from "./protocol.js";
import { runSandboxed, type Bind } from "./sandbox.js";

export async function smoke(out: string, scratch: string): Promise<any> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(out, "smoke", stamp);
  const box = join(scratch, "smoke", "box"), ws = join(box, "ws"), agent = join(box, "agent"), sessions = join(box, "sessions"), home = join(box, "home"), tmp = join(box, "tmp");
  await rm(join(scratch, "smoke"), { recursive: true, force: true });
  for (const path of [dir, ws, agent, sessions, home, tmp]) await mkdir(path, { recursive: true });
  await writeFile(join(ws, "README.txt"), "smoke workspace\n");
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(AGENT, name))) copyFileSync(join(AGENT, name), join(agent, name));
  const connection = JSON.parse(readFileSync(join(AGENT, "cliproxyapi.json"), "utf8"));
  const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
  await writeFile(join(agent, "cliproxyapi.json"), JSON.stringify({ ...connection, apiKey: PLACEHOLDER_KEY, baseUrl: bridgeUrl }), { mode: 0o600 });
  await writeFile(join(agent, "settings.json"), JSON.stringify(piSettings(), null, 2));
  const harness = join(scratch, "smoke", "harness");
  await mkdir(harness, { recursive: true });
  const proxyDir = join(scratch, "smoke", "p");
  await mkdir(proxyDir, { recursive: true, mode: 0o700 });
  const socket = join(proxyDir, "s.sock"), keyFile = join(proxyDir, "key"), envelope = join(proxyDir, "envelope.json");
  await writeFile(keyFile, String(connection.apiKey ?? ""), { mode: 0o600 });
  const catalog = JSON.parse(readFileSync(join(AGENT, "cliproxyapi-models.json"), "utf8"));
  const entries: any[] = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.models) ? catalog.models : Object.values(catalog ?? {});
  await writeJson(envelope, { route: { model: MODEL.id, effort: EFFORT }, maxRequests: 3, placeholderKey: PLACEHOLDER_KEY, prices: { [MODEL.id]: entries.find(item => item?.id === MODEL.id)?.cost } });
  const wire = join(dir, "wire.jsonl");
  const proxy = spawn(NODE, [join(HERE, "proxy.mjs"), "--listen", socket, "--target", UPSTREAM, "--log", wire, "--envelope", envelope, "--key-file", keyFile], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`proxy did not start: ${text}`)), 15_000);
    proxy.stdout!.on("data", chunk => { text += String(chunk); if (/LISTENING/.test(text)) { clearTimeout(timer); resolve(); } });
    proxy.stderr!.on("data", chunk => { text += String(chunk); });
  });
  await rm(keyFile, { force: true });
  const launch = join(harness, "launch.sh");
  await writeFile(launch, ["#!/bin/sh", `"$WR_NODE" ${BRIDGE_MOUNT} ${BRIDGE_PORT} ${SOCKET_MOUNT} "$WR_BRIDGE_READY" &`, 'i=0; while [ ! -s "$WR_BRIDGE_READY" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done', 'exec "$WR_NODE" "$@"', ""].join("\n"));
  await chmod(launch, 0o555);
  const frozenProvider = existsSync(join(out, "frozen/provider/extensions/index.ts")) ? join(out, "frozen/provider") : join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
  const binds: Bind[] = [
    { from: NODE_DIR }, { from: PI_MODULES }, { from: box, rw: true }, { from: frozenProvider, to: PROVIDER_MOUNT }, { from: join(HERE, "bridge.mjs"), to: BRIDGE_MOUNT },
    { from: launch, to: LAUNCH_MOUNT }, { from: socket, to: SOCKET_MOUNT, rw: true },
  ];
  const env = {
    PATH: `${NODE_DIR}/bin:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", TERM: "dumb", PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions, PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0", PI_OFFLINE: "1", CLIPROXYAPI_BASE_URL: bridgeUrl, CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0", WR_NODE: NODE, WR_BRIDGE_READY: join(tmp, ".bridge-ready"),
  };
  // Model-free isolation probe inside the same binds.
  const probe = await runSandboxed({ binds, env, cwd: ws, command: ["/bin/sh", "-c", [
    `test -e ${REPO} && echo "REPO visible" || echo "repo hidden"`,
    `test -e ${join(AGENT, "cliproxyapi.json")} && echo "user agent dir visible" || echo "user agent dir hidden"`,
    "ls /tmp | tr '\\n' ' '; echo",
    `"$WR_NODE" -e "const s=require('net').connect(80,'1.1.1.1');s.on('connect',()=>{console.log('NETWORK OPEN');process.exit(0)});s.on('error',e=>{console.log('network closed: '+e.code);process.exit(0)})"`,
    "grep -c placeholder-key " + join(agent, "cliproxyapi.json"),
  ].join("; ")] }, { guardMs: 30_000 });
  const run = await runSandboxed({ binds, env, cwd: ws, command: ["/bin/sh", LAUNCH_MOUNT, PI_CLI, "--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--offline", "--no-tools",
    "-e", `${PROVIDER_MOUNT}/extensions/index.ts`, "--model", MODEL_REF, "--thinking", EFFORT, "--session-dir", sessions, "--session-id", "wr-smoke", "--", "Reply with exactly the word OK and nothing else."] }, { guardMs: 5 * 60_000, stdout: join(dir, "events.jsonl"), stderr: join(dir, "stderr.txt") });
  // Continuation: a second invocation with the same --session-id must see the first turn (arm T continues this way).
  const again = await runSandboxed({ binds, env, cwd: ws, command: ["/bin/sh", LAUNCH_MOUNT, PI_CLI, "--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--offline", "--no-tools",
    "-e", `${PROVIDER_MOUNT}/extensions/index.ts`, "--model", MODEL_REF, "--thinking", EFFORT, "--session-dir", sessions, "--session-id", "wr-smoke", "--", "Repeat exactly the word you replied with in your previous answer, then the word AGAIN."] }, { guardMs: 5 * 60_000, stdout: join(dir, "events-again.jsonl"), stderr: join(dir, "stderr-again.txt") });
  proxy.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 300));
  const againEvents = existsSync(join(dir, "events-again.jsonl")) ? readFileSync(join(dir, "events-again.jsonl"), "utf8") : "";
  const againLast = againEvents.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(event => event?.type === "message_end" && event.message?.role === "assistant").at(-1);
  const totals = existsSync(`${wire}.totals.json`) ? JSON.parse(readFileSync(`${wire}.totals.json`, "utf8")) : {};
  const events = existsSync(join(dir, "events.jsonl")) ? readFileSync(join(dir, "events.jsonl"), "utf8") : "";
  const last = events.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(event => event?.type === "message_end" && event.message?.role === "assistant").at(-1);
  const result = { at: stamp, upstream: UPSTREAM, probe: probe.text.trim().split("\n"), pi: { exit: run.code, ms: run.ms, stopReason: last?.message?.stopReason, text: JSON.stringify(last?.message?.content ?? "").slice(0, 300), errorMessage: last?.message?.errorMessage }, continuation: { exit: again.code, stopReason: againLast?.message?.stopReason, text: JSON.stringify(againLast?.message?.content ?? "").slice(0, 300) }, totals };
  await writeJson(join(dir, "smoke.json"), result);
  console.log(JSON.stringify(result, null, 2));
  return result;
}
