// @ts-nocheck -- plain ESM run directly by node; tested in test/experiments/witness-replay.test.ts
// The unit proxy of the witness-replay pilot (experiments/witness-replay/README.md "Route guard"): every model request of one unit
// (all Pi invocations of its session) passes here, outside the sandbox. Derived from experiments/ultra-ho/proxy.mjs (logging, usage
// and list prices unchanged in spirit) and hardened:
//   - FAIL CLOSED: a POST is forwarded only when its body parses and names the pinned model and the pinned effort (request-level
//     reasoning.effort / reasoning_effort, which must agree when both are present, and every configuration_update effort). A POST
//     that cannot be verified (unparseable, compressed with an unknown encoding, no model, no effort, conflicting efforts) is refused
//     before it reaches the gateway (HTTP 400, refused "unverifiable"); an off-route one likewise (refused "route"). Methods other
//     than GET/POST are refused (405). WebSocket upgrades are refused (426) so the stream is SSE and readable.
//   - The unit's request budget: once `maxRequests` model requests were forwarded, the next is refused (HTTP 403, refused "budget").
//   - A start record is appended (and the totals rewritten) BEFORE a request is forwarded, an end record when it completes, so an
//     interrupted request is still counted (started without end = unknown usage, never zero).
//   - Credentials: the sandbox only knows a placeholder key; this proxy substitutes the real key (read from --key-file, outside the
//     sandbox) in the request headers. Headers, credentials and bodies are never logged.
//   - The response model of every stream (head and final event) is recorded; one that is not the pinned model counts as an off-route
//     response (offRouteResponses), which makes the attempt invalid.
//   node proxy.mjs --listen <unix socket path | port> --target <url> --log <wire.jsonl> --envelope <envelope.json> [--key-file <file>]
//   → prints "LISTENING <address>" once listening.
// envelope.json: { "route": { "model": "gpt-6.1-sol", "effort": "high" }, "maxRequests": 60, "placeholderKey": "…", "prices": { … } }
import http from "node:http";
import zlib from "node:zlib";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HEAD = 65536, TAIL = 8 * 1024 * 1024, WHOLE = 64 * 1024 * 1024;
const decode = (enc, buf) => !enc || enc === "identity" ? buf : enc === "zstd" ? zlib.zstdDecompressSync(buf) : enc === "gzip" ? zlib.gunzipSync(buf) : enc === "br" ? zlib.brotliDecompressSync(buf) : enc === "deflate" ? zlib.inflateSync(buf) : (() => { throw new Error(`unknown content-encoding ${enc}`); })();

/** The numbers of a usage object (nested details included) as the provider sent them. */
export function numbersOf(value, depth = 0) {
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) { const number = numbersOf(item, depth + 1); if (number !== undefined) out[key] = number; }
  return Object.keys(out).length ? out : undefined;
}

/** Usage of a Responses API SSE stream (its final response.completed / incomplete / failed event). */
export function usageFrom(text) {
  let found;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || !/"response\.(completed|incomplete|failed)"/.test(line)) continue;
    try {
      const event = JSON.parse(line.slice(6));
      const usage = event.response?.usage;
      if (!usage || typeof usage.output_tokens !== "number") continue;
      const details = usage.input_tokens_details ?? {};
      found = {
        input: usage.input_tokens, cached: details.cached_tokens ?? 0, cacheWrite: details.cache_creation_tokens ?? details.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0,
        output: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0, final: event.type, respModel: event.response?.model, raw: numbersOf(usage),
      };
    } catch { /* cut line */ }
  }
  return found;
}

/** A provider error of a response (SSE error / response.failed event, or a JSON error body): type, code, clipped message. */
export function errorOf(text) {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const payload = line.startsWith("data: ") ? line.slice(6) : line.startsWith("{") ? line : undefined;
    if (!payload) continue;
    try {
      const event = JSON.parse(payload);
      const error = event?.type === "response.failed" ? event.response?.error : event?.type === "error" ? (event.error ?? event) : event?.error;
      if (typeof error === "string") return { message: error.slice(0, 400) };
      if (!error || typeof error !== "object") continue;
      return { ...(error.type ?? event.type ? { type: String(error.type ?? event.type).slice(0, 80) } : {}), ...(error.code !== undefined && error.code !== null ? { code: String(error.code).slice(0, 80) } : {}), ...(error.message ? { message: String(error.message).slice(0, 400) } : {}) };
    } catch { /* not JSON */ }
  }
  return undefined;
}

/** List-price cost of one response (USD); undefined without a price for the model. */
export function costOf(prices, model, usage) {
  const base = prices?.[model];
  if (!base || !usage) return undefined;
  const tier = (base.tiers ?? []).filter(item => usage.input > (item.inputTokensAbove ?? Infinity)).at(-1);
  const p = tier ? { ...base, ...tier } : base;
  const cacheWrite = usage.cacheWrite ?? 0;
  return ((usage.input - usage.cached - cacheWrite) * p.input + usage.cached * (p.cacheRead ?? p.input) + cacheWrite * (p.cacheWrite ?? p.input) + usage.output * p.output) / 1e6;
}

/**
 * The verdict on one POST before anything is forwarded (pure): forward with the parsed facts, or refuse with a reason.
 * `forwarded` is how many model requests this unit already sent upstream.
 */
export function admit(envelope, { method, encoding, body }, forwarded) {
  if (method === "GET") return { forward: true, facts: {} };
  if (method !== "POST") return { forward: false, status: 405, refused: "method", message: `method ${method} is not allowed` };
  let j;
  try { j = JSON.parse(decode(encoding, body).toString("utf8")); } catch (error) { return { forward: false, status: 400, refused: "unverifiable", message: `request body cannot be verified: ${String(error).slice(0, 120)}` }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { forward: false, status: 400, refused: "unverifiable", message: "request body is not a JSON object" };
  const requestEfforts = [j.reasoning?.effort, j.reasoning_effort].filter(value => value !== undefined && value !== null).map(String);
  const updates = (Array.isArray(j.input) ? j.input : []).filter(item => item?.type === "configuration_update").map(item => String(item?.reasoning?.effort ?? "?"));
  const facts = { model: j.model === undefined ? undefined : String(j.model), effort: requestEfforts[0], ...(updates.length ? { updateEfforts: updates } : {}), maxOutput: j.max_output_tokens ?? j.max_tokens ?? j.max_completion_tokens, session: j.prompt_cache_key, bytes: body.length };
  const route = envelope.route;
  if (!route?.model || !route?.effort) return { forward: false, status: 400, refused: "unverifiable", message: "the proxy has no pinned route", facts };
  const problems = [];
  if (facts.model === undefined) problems.push("no model");
  else if (facts.model !== route.model) problems.push(`model ${facts.model}`);
  if (!requestEfforts.length) problems.push("no effort");
  if (new Set(requestEfforts).size > 1) problems.push(`conflicting efforts ${requestEfforts.join("/")}`);
  else if (requestEfforts.length && requestEfforts[0] !== route.effort) problems.push(`effort ${requestEfforts[0]}`);
  for (const effort of updates) if (effort !== route.effort) problems.push(`configuration_update effort ${effort}`);
  if (problems.length) {
    const unverifiable = problems.some(problem => problem === "no model" || problem === "no effort" || problem.startsWith("conflicting"));
    return { forward: false, status: 400, refused: unverifiable ? "unverifiable" : "route", message: `pinned route: only ${route.model} at effort ${route.effort} may be requested (${problems.join(", ")})`, facts };
  }
  if (typeof envelope.maxRequests === "number" && forwarded >= envelope.maxRequests) return { forward: false, status: 403, refused: "budget", message: `request budget of ${envelope.maxRequests} model requests for this session is spent; no further model requests`, facts };
  return { forward: true, facts };
}

/** Request headers with the placeholder key replaced by the real one (no other change). */
export function substituteKey(headers, placeholder, key) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name] = placeholder && key && typeof value === "string" && value.includes(placeholder) ? value.split(placeholder).join(key) : value;
  return out;
}

function argOf(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }

/** Start a proxy (also used by the tests with a fake upstream). Resolves with the server once it listens. */
export function startProxy({ listen, target, log, envelope, key }) {
  const totals = { received: 0, forwarded: 0, completed: 0, refused: { route: 0, unverifiable: 0, budget: 0, method: 0, upgrade: 0 }, providerErrors: 0, unknownUsage: 0, offRouteResponses: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, costUSD: 0, byModel: {}, byEffort: {}, byStatus: {} };
  let seq = 0;
  const save = () => { try { writeFileSync(`${log}.totals.json`, JSON.stringify({ ...totals, maxRequests: envelope.maxRequests, costUSD: Math.round(totals.costUSD * 1e6) / 1e6, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best effort */ } };
  const count = (map, k) => { map[k] = (map[k] ?? 0) + 1; };
  const record = entry => { appendFileSync(log, JSON.stringify(entry) + "\n"); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const entry = { id: ++seq, at: new Date().toISOString(), method: req.method, path: req.url };
      totals.received++;
      const verdict = admit(envelope, { method: req.method, encoding: req.headers["content-encoding"], body }, totals.forwarded);
      Object.assign(entry, verdict.facts ?? {});
      if (!verdict.forward) {
        totals.refused[verdict.refused] = (totals.refused[verdict.refused] ?? 0) + 1; count(totals.byStatus, String(verdict.status));
        record({ phase: "refused", ...entry, status: verdict.status, refused: verdict.refused, reason: verdict.message.slice(0, 300) }); save();
        res.writeHead(verdict.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: `witness_replay_${verdict.refused}`, message: verdict.message } }));
        return;
      }
      const model = req.method === "POST";
      if (model) { totals.forwarded++; count(totals.byModel, String(entry.model)); count(totals.byEffort, String(entry.effort)); }
      record({ phase: "start", ...entry }); save();
      let done = false;
      const finish = extra => { if (done) return; done = true; Object.assign(entry, extra ?? {}); entry.endAt = new Date().toISOString(); if (model) totals.completed++; record({ phase: "end", ...entry }); save(); };
      const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: substituteKey({ ...req.headers, host: target.host }, envelope.placeholderKey, key) }, upRes => {
        entry.status = upRes.statusCode;
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        const enc = upRes.headers["content-encoding"];
        let bytes = 0; const head = []; const tailChunks = []; let tailBytes = 0; const whole = []; let wholeBytes = 0;
        upRes.on("data", c => {
          bytes += c.length;
          if (enc) { if (wholeBytes < WHOLE) { whole.push(c); wholeBytes += c.length; } else entry.truncated = true; }
          else { if (bytes - c.length < HEAD) head.push(c); tailChunks.push(c); tailBytes += c.length; while (tailChunks.length > 1 && tailBytes - tailChunks[0].length >= TAIL) tailBytes -= tailChunks.shift().length; }
          res.write(c);
        });
        upRes.on("error", e => { entry.upstreamError = String(e).slice(0, 200); });
        upRes.on("close", () => {
          entry.respBytes = bytes;
          if (model) {
            count(totals.byStatus, String(entry.status));
            try {
              const decoded = enc ? decode(enc, Buffer.concat(whole)).toString("utf8") : undefined;
              const first = decoded ?? Buffer.concat(head).toString("utf8");
              const last = decoded ?? Buffer.concat(tailChunks).toString("utf8");
              const m = /"model"\s*:\s*"([^"]+)"/.exec(first); if (m) entry.respModel = m[1];
              const usage = usageFrom(last);
              if (usage) {
                const { final, respModel, raw, ...counts } = usage; entry.usage = counts; entry.final = final; if (respModel) entry.finalModel = respModel; if (raw) entry.rawUsage = raw;
                totals.input += counts.input; totals.cached += counts.cached; totals.cacheWrite += counts.cacheWrite; totals.output += counts.output; totals.reasoning += counts.reasoning;
                const cost = costOf(envelope.prices, String(entry.model), counts);
                if (cost === undefined) { entry.unpriced = true; totals.unknownUsage++; } else { entry.costUSD = Math.round(cost * 1e6) / 1e6; totals.costUSD += cost; }
              } else { entry.noFinalEvent = true; totals.unknownUsage++; }
              const responseModels = [entry.respModel, entry.finalModel].filter(Boolean);
              if (responseModels.some(name => name !== envelope.route.model) || (entry.status === 200 && !responseModels.length)) { entry.offRouteResponse = true; totals.offRouteResponses++; }
              if (/"type"\s*:\s*"(response\.failed|error)"/.test(last)) entry.errorEvent = true;
              if (entry.errorEvent || (entry.status ?? 0) >= 400) { entry.providerError = errorOf(last) ?? errorOf(first) ?? { body: first.replace(/\s+/g, " ").slice(0, 300) }; totals.providerErrors++; }
            } catch (e) { entry.respParseError = String(e).slice(0, 80); totals.unknownUsage++; }
          }
          finish(); res.end();
        });
      });
      up.on("error", e => { if (model) totals.providerErrors++; finish({ error: String(e).slice(0, 200) }); if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on("aborted", () => { entry.clientAborted = true; });
      res.on("close", () => { if (!res.writableFinished) { entry.clientClosed = true; up.destroy(); } });
      up.end(body);
    });
  });
  server.on("upgrade", (req, socket) => {
    totals.received++; totals.refused.upgrade++;
    record({ phase: "refused", id: ++seq, at: new Date().toISOString(), method: req.method, path: req.url, refused: "upgrade", status: 426 }); save();
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  save();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (/^\d+$/.test(String(listen))) server.listen(Number(listen), "127.0.0.1", () => resolve({ server, totals, address: `127.0.0.1:${server.address().port}` }));
    else { if (existsSync(listen)) rmSync(listen); server.listen(listen, () => resolve({ server, totals, address: listen })); }
  });
}

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1));
if (main) {
  const argv = process.argv.slice(2);
  const envelope = JSON.parse(readFileSync(argOf(argv, "--envelope"), "utf8"));
  const keyFile = argOf(argv, "--key-file");
  const key = keyFile ? readFileSync(keyFile, "utf8").trim() : undefined;
  const { address } = await startProxy({ listen: argOf(argv, "--listen"), target: new URL(argOf(argv, "--target")), log: argOf(argv, "--log"), envelope, key });
  console.log(`LISTENING ${address}`);
}
