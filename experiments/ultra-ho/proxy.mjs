// @ts-nocheck -- plain untyped ESM run directly by node (no build step); tested in test/experiments/mdsd-ab.test.ts
// Logging and budget proxy in front of CLIProxyAPI for one run of the MDSD comparison (experiments/mdsd-ab, docs/mdsd-ab-bench.md).
// Based on experiments/ultra-ab/proxy.mjs. Per model request it logs the requested model, the request-level reasoning effort and the
// efforts of the request's configuration_update input items (how the provider carries a mid-conversation effort; in order), the
// requested output limit, prompt_cache_key (the Pi session id: the key that attributes a request to a session, never a prompt scan),
// HTTP status, the model, normalized usage plus the original usage numbers the provider reported in its response stream, a sanitized
// provider error (type, code, clipped message) when there is one, and timing; never headers, credentials or bodies. It also enforces
// the run's experiment envelope: every request of the Pi process (main, orche workers, sub-workers, compaction, helpers through this
// provider) is priced from the reported usage with the catalog's list prices; once the envelope is spent, further requests are refused
// (HTTP 403, logged); what requests already in flight add beyond the cap is reported as overshootUSD. A request without a final usage
// event is counted as unknown, never as zero.
//   node proxy.mjs <port|0> <target url> <wire.jsonl> <envelope.json>   → prints "PORT <n>" once listening
// envelope.json: { "capUSD": 40, "prices": { "<model id>": { "input": 2, "output": 10, "cacheRead": 0.1, "cacheWrite": 2.5, "tiers": [{ "inputTokensAbove": 272000, ... }] } },
//                  "route": { "model": "<model id>", "effort": "high" } }
// route (optional, the pinned route): a model request for another model, another request effort or another configuration_update
// effort is refused (HTTP 400, logged with refused "route") before it reaches the upstream, so an off-route request never runs.
// The running totals are rewritten to <wire.jsonl>.totals.json after every request.
import http from "node:http";
import zlib from "node:zlib";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1));
const [port, target, log, envelopeFile] = main ? [Number(process.argv[2]), new URL(process.argv[3]), process.argv[4], process.argv[5]] : [0, undefined, undefined, undefined];
const envelope = envelopeFile ? JSON.parse(readFileSync(envelopeFile, "utf8")) : { capUSD: Infinity, prices: {} };
// No capUSD (or a non-number such as JSON's null for Infinity): no envelope, nothing is refused; every request is still logged and priced.
if (typeof envelope.capUSD !== "number") envelope.capUSD = Infinity;
const totals = { requests: 0, refused: 0, unknownUsage: 0, providerErrors: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, costUSD: 0, byModel: {}, byEffort: {}, byUpdateEffort: {}, byStatus: {}, maxOutput: {} };
let seq = 0;
const decode = (enc, buf) => enc === "zstd" ? zlib.zstdDecompressSync(buf) : enc === "gzip" ? zlib.gunzipSync(buf) : enc === "br" ? zlib.brotliDecompressSync(buf) : enc === "deflate" ? zlib.inflateSync(buf) : buf;
/** Uncompressed streams: the first 64 KiB (model) and the last 8 MiB (final event). Compressed streams are decoded whole (bounded). */
const HEAD = 65536, TAIL = 8 * 1024 * 1024, WHOLE = 64 * 1024 * 1024;

/** The numbers of a usage object (nested details included) as the provider sent them; nothing else of the response. */
export function numbersOf(value, depth = 0) {
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) { const number = numbersOf(item, depth + 1); if (number !== undefined) out[key] = number; }
  return Object.keys(out).length ? out : undefined;
}

/** Usage of a Responses API SSE stream (final response.completed / incomplete / failed event): normalized counts plus the original numbers. */
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
        output: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
        final: event.type, respModel: event.response?.model, raw: numbersOf(usage),
        ...(event.response?.incomplete_details ? { incomplete: String(event.response.incomplete_details.reason ?? JSON.stringify(event.response.incomplete_details)).slice(0, 120) } : {}),
      };
    } catch { /* cut line */ }
  }
  return found;
}

/** A provider error of a response (SSE error / response.failed event, or a JSON error body): type, code and a clipped message only. */
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

/** Efforts of the request's configuration_update input items, in order (the provider's mid-conversation effort). */
export function updateEffortsOf(body) {
  return (Array.isArray(body?.input) ? body.input : []).filter(item => item?.type === "configuration_update").map(item => String(item?.reasoning?.effort ?? "?"));
}

/** List-price cost of one response (USD); undefined without a price for the model. Cache writes are priced when the provider reports them. */
export function costOf(prices, model, usage) {
  const base = prices?.[model];
  if (!base || !usage) return undefined;
  const tier = (base.tiers ?? []).filter(item => usage.input > (item.inputTokensAbove ?? Infinity)).at(-1);
  const p = tier ? { ...base, ...tier } : base;
  const cacheWrite = usage.cacheWrite ?? 0;
  return ((usage.input - usage.cached - cacheWrite) * p.input + usage.cached * (p.cacheRead ?? p.input) + cacheWrite * (p.cacheWrite ?? p.input) + usage.output * p.output) / 1e6;
}

const save = () => { try { writeFileSync(`${log}.totals.json`, JSON.stringify({ ...totals, capUSD: envelope.capUSD, costUSD: Math.round(totals.costUSD * 1e6) / 1e6, overshootUSD: Math.max(0, Math.round((totals.costUSD - envelope.capUSD) * 1e6) / 1e6) }, null, 2)); } catch { /* best effort */ } };
const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const entry = { id: ++seq, at: new Date().toISOString(), method: req.method, path: req.url };
    try {
      if (body.length) {
        const j = JSON.parse(decode(req.headers["content-encoding"], body).toString("utf8"));
        const text = JSON.stringify(j);
        const updates = updateEffortsOf(j);
        Object.assign(entry, {
          model: j.model, effort: j.reasoning?.effort ?? j.reasoning_effort, ...(updates.length ? { updateEfforts: updates } : {}),
          maxOutput: j.max_output_tokens ?? j.max_tokens ?? j.max_completion_tokens, session: j.prompt_cache_key,
          worker: text.includes("persistent coding worker"), subWorker: /You are sub-worker W\d+\.\d+/.test(text), bytes: body.length,
        });
      }
    } catch (e) { entry.unparsed = body.length; entry.parseError = String(e).slice(0, 120); }
    let done = false;
    const finish = () => { if (done) return; done = true; appendFileSync(log, JSON.stringify(entry) + "\n"); save(); };
    if (req.method === "POST" && entry.model) {
      totals.requests++; count(totals.byModel, String(entry.model)); count(totals.byEffort, String(entry.effort)); count(totals.maxOutput, String(entry.maxOutput));
      for (const effort of entry.updateEfforts ?? []) count(totals.byUpdateEffort, effort);
      const route = envelope.route;
      const offRoute = route ? [entry.model !== route.model && `model ${entry.model}`, route.effort && entry.effort !== route.effort && `effort ${entry.effort}`, ...(route.effort ? (entry.updateEfforts ?? []).filter(effort => effort !== route.effort).map(effort => `configuration_update effort ${effort}`) : [])].filter(Boolean) : [];
      if (offRoute.length) {
        totals.refused++; entry.refused = "route"; entry.status = 400; count(totals.byStatus, "400");
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "route_refused", message: `pinned route: only ${route.model} at effort ${route.effort} may be requested (${offRoute.join(", ")})` } }));
        finish();
        return;
      }
      if (totals.costUSD >= envelope.capUSD) {
        totals.refused++; entry.refused = "envelope"; entry.status = 403; count(totals.byStatus, "403");
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "envelope_exhausted", message: `experiment envelope of $${envelope.capUSD} for this run is spent ($${totals.costUSD.toFixed(2)}); no further model requests` } }));
        finish();
        return;
      }
    }
    const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, upRes => {
      entry.status = upRes.statusCode;
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      const enc = upRes.headers["content-encoding"];
      let bytes = 0; const head = []; const tailChunks = []; let tailBytes = 0; const whole = []; let wholeBytes = 0;
      upRes.on("data", c => {
        bytes += c.length;
        if (enc) { if (wholeBytes < WHOLE) { whole.push(c); wholeBytes += c.length; } else entry.truncated = true; }
        else {
          if (bytes - c.length < HEAD) head.push(c);
          tailChunks.push(c); tailBytes += c.length;
          while (tailChunks.length > 1 && tailBytes - tailChunks[0].length >= TAIL) tailBytes -= tailChunks.shift().length;
        }
        res.write(c);
      });
      upRes.on("error", e => { entry.upstreamError = String(e).slice(0, 200); });
      upRes.on("close", () => {
        entry.respBytes = bytes; entry.endAt = new Date().toISOString();
        if (req.method === "POST" && entry.model) {
          count(totals.byStatus, String(entry.status));
          try {
            const decoded = enc ? decode(enc, Buffer.concat(whole)).toString("utf8") : undefined;
            const first = decoded ?? Buffer.concat(head).toString("utf8");
            const last = decoded ?? Buffer.concat(tailChunks).toString("utf8");
            const m = /"model"\s*:\s*"([^"]+)"/.exec(first); if (m) entry.respModel = m[1];
            const usage = usageFrom(last);
            if (usage) {
              const { final, respModel, raw, incomplete, ...counts } = usage; entry.usage = counts; entry.final = final; if (respModel) entry.finalModel = respModel;
              if (raw) entry.rawUsage = raw; if (incomplete) entry.incomplete = incomplete;
              totals.input += counts.input; totals.cached += counts.cached; totals.cacheWrite += counts.cacheWrite; totals.output += counts.output; totals.reasoning += counts.reasoning;
              const cost = costOf(envelope.prices, String(entry.model), counts);
              if (cost === undefined) { entry.unpriced = true; totals.unknownUsage++; } else { entry.costUSD = Math.round(cost * 1e6) / 1e6; totals.costUSD += cost; }
            } else { entry.noFinalEvent = true; totals.unknownUsage++; }
            if (/"type"\s*:\s*"(response\.failed|error)"/.test(last)) entry.errorEvent = true;
            if (entry.errorEvent || (entry.status ?? 0) >= 400) {
              entry.providerError = errorOf(last) ?? errorOf(first) ?? { body: first.replace(/\s+/g, " ").slice(0, 300) };
              totals.providerErrors++;
            }
          } catch (e) { entry.respParseError = String(e).slice(0, 80); totals.unknownUsage++; }
        }
        finish(); res.end();
      });
    });
    up.on("error", e => { entry.error = String(e).slice(0, 200); finish(); if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on("aborted", () => { entry.clientAborted = true; });
    res.on("close", () => { if (!res.writableFinished) { entry.clientClosed = true; up.destroy(); } });
    up.end(body);
  });
});
// WebSocket transport is refused so the client uses SSE, which this proxy can log and price.
server.on("upgrade", (req, socket) => {
  appendFileSync(log, JSON.stringify({ id: ++seq, at: new Date().toISOString(), method: req.method, path: req.url, upgrade: true, refused: 426 }) + "\n");
  socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});
if (main) {
  save();
  server.listen(port, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
}
