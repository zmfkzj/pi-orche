// Model-identity guard for the qualification study (technical retry 1). It sits between one sandboxed Pi process and that turn's
// logging proxy (proxy.mjs, unchanged).
// First-attempt evidence (results/qualification-validation-retry1/route-diagnosis.json): between 12:42:03Z and 12:45:03Z the upstream
// answered requests for gpt-6-astra with HTTP 400 "unknown provider for model gpt-6-astra" (once: "not supported when using Codex with
// a ChatGPT account"), which ended 11 in-flight turns with stopReason "error"; the per-session catalogue caches fetched in the same window
// list bts/gpt-6-astra without gpt-6-astra, and every turn that started in that window ran on bts/gpt-6-astra (Pi's --model lookup took
// the alias when the exact id was absent). Exact-id requests succeeded before 12:41:49Z and again from 12:47:04Z.
//   - GET .../models: answered from the frozen, filtered catalogue response captured at manifest time, so the provider's per-session
//     model discovery (including its asynchronous refresh) cannot pick up a changed upstream list;
//   - POST: the JSON body's "model" must be the turn's pinned model id or a user-confirmed route alias of that same model (only
//     bts/gpt-6-astra for gpt-6-astra; user clarification relayed 2026-10-18, retry-protocol-addendum-1.md); the raw route name is
//     logged. Anything else is refused with HTTP 409 before it reaches the logging proxy or upstream (fail closed), and logged;
//   - an upstream routing rejection of the pinned model (the two observed 400 messages; no model output, no usage) is retried with the
//     byte-identical request for at most holdMs (below Pi's 300 s HTTP idle timeout); if it persists it is returned as 503 so that Pi's
//     ordinary transient-error retry applies. Every attempt is logged; no other status or body is changed;
//   - everything else is forwarded unchanged. Bodies of forwarded requests are passed through byte for byte.
//   node qualification-guard.mjs <port|0> <target url> <guard.jsonl> <model id> <models-response.json> [alias,alias]   → prints "PORT <n>"
import { appendFileSync, readFileSync } from "node:fs";
import zlib from "node:zlib";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * The request body as JSON text: Pi's Codex client may compress request bodies (same decoding as proxy.mjs). The forwarded bytes are
 * always the original ones; an undecodable body is treated as an unknown model and refused.
 * @param {string | string[] | undefined} encoding
 * @param {Buffer} body
 */
export function requestJson(encoding, body) {
  return JSON.parse(decodeBody(encoding, body).toString("utf8"));
}
/**
 * @param {string | string[] | undefined} encoding
 * @param {Buffer} body
 */
export function decodeBody(encoding, body) {
  const enc = String(encoding ?? "").trim().toLowerCase();
  return enc === "zstd" ? zlib.zstdDecompressSync(body) : enc === "gzip" ? zlib.gunzipSync(body) : enc === "br" ? zlib.brotliDecompressSync(body) : enc === "deflate" ? zlib.inflateSync(body) : body;
}
/** Upstream messages that mean "the router has no route for this model right now" (observed in the first attempt). */
export const ROUTING_REJECTION = /unknown provider for model|not supported when using Codex with a ChatGPT account/i;
/**
 * Upstream capacity outages (retry 1, 14:40:44-14:41:06Z: 21 x HTTP 503 "auth_unavailable: no auth available ... service_unavailable:
 * The server is overloaded or not ready yet"): Pi's three quick retries (2/4/8 s) ran out inside the outage and ended four cells.
 * Added mid-run (retry-protocol-addendum-2.md): such 429/5xx answers are held and the identical request is resent like a routing
 * rejection; if the outage outlasts holdMs the last upstream answer is returned unchanged (Pi's ordinary retry then applies).
 */
export const TRANSIENT_UNAVAILABLE = /auth_unavailable|no auth available|overloaded|not ready yet|service[_ ]unavailable/i;
/** @param {number} status @param {string} message */
export const holdable = (status, message) => ROUTING_REJECTION.test(message) || [429, 500, 502, 503, 504].includes(status) && TRANSIENT_UNAVAILABLE.test(message);

/**
 * Starts the guard; resolves with the listening server and its port.
 * @param {{ port?: number, target: string, log?: string, model: string, aliases?: string[], modelsBody: string | Buffer, holdMs?: number, stepMs?: number }} options
 * @returns {Promise<{ server: import("node:http").Server, port: number }>}
 */
export function startGuard({ port = 0, target, log, model, aliases = [], modelsBody, holdMs = 240_000, stepMs = 15_000 }) {
  const upstream = new URL(target);
  /** @param {Record<string, unknown>} entry */
  const record = entry => { if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); };
  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = req.url ?? "/";
      if (req.method === "GET" && /\/models(\?|$)/.test(path)) {
        record({ kind: "models", path, served: "pinned" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(modelsBody);
        return;
      }
      const modelRequest = req.method === "POST";
      /** @type {string | undefined} */
      let route;
      if (modelRequest) {
        let requested;
        try { requested = requestJson(req.headers["content-encoding"], body).model; } catch { requested = undefined; }
        if (requested !== model && !aliases.includes(requested)) {
          record({ kind: "refused", path, requested: requested ?? null, expected: model });
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "model_identity_refused", message: `experiment guard: requested ${String(requested)}, this turn is pinned to ${model}` } }));
          return;
        }
        route = requested;
      }
      const started = Date.now();
      let clientGone = false;
      res.on("close", () => { if (!res.writableFinished) clientGone = true; });
      const headers = { ...req.headers, host: upstream.host, "content-length": String(body.length) };
      delete headers["transfer-encoding"];
      /** @param {number} attempt */
      const send = attempt => {
        if (clientGone) { record({ kind: "client-gone", path, attempt }); return; }
        record(modelRequest ? { kind: "forwarded", path, model: route, normalized: model, attempt } : { kind: "passthrough", method: req.method, path });
        const outgoing = request({ hostname: upstream.hostname, port: upstream.port, path, method: req.method, headers }, incoming => {
          const status = incoming.statusCode ?? 502;
          if (!modelRequest || status < 400) { res.writeHead(status, incoming.headers); incoming.pipe(res); return; }
          /** @type {Buffer[]} */
          const parts = [];
          incoming.on("data", chunk => parts.push(chunk));
          incoming.on("end", () => {
            const errorBody = Buffer.concat(parts);
            let message = errorBody.toString("utf8");
            try { message = decodeBody(incoming.headers["content-encoding"], errorBody).toString("utf8"); } catch { /* keep the raw text */ }
            if (!holdable(status, message)) { res.writeHead(status, incoming.headers); res.end(errorBody); return; }
            const routing = ROUTING_REJECTION.test(message), elapsed = Date.now() - started, hold = elapsed + stepMs <= holdMs;
            record({ kind: routing ? "routing-rejection" : "capacity-outage", path, status, message: message.slice(0, 300), attempt, elapsedMs: elapsed, action: hold ? "hold" : routing ? "503" : "pass" });
            if (hold) { setTimeout(() => send(attempt + 1), stepMs); return; }
            if (!routing) { res.writeHead(status, incoming.headers); res.end(errorBody); return; }
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "service_unavailable", message: `503 service temporarily unavailable: upstream had no route for pinned model ${model} for ${Math.round(elapsed / 1000)} s (${message.slice(0, 200)})` } }));
          });
        });
        outgoing.on("error", error => { record({ kind: "forward-error", path, message: String(error), attempt }); if (!res.headersSent) res.writeHead(502); res.end(); });
        outgoing.end(body);
      };
      send(1);
    });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port })));
}

/**
 * Counts of one guard log: served catalogue requests, forwarded (every physical attempt) and refused model requests, routing holds.
 * @param {string} log
 */
export function guardStats(log) {
  /** @type {any[]} */
  let lines = [];
  try { lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { lines = []; }
  /** @param {string} kind */
  const count = kind => lines.filter(line => line.kind === kind).length;
  const routing = lines.filter(line => line.kind === "routing-rejection"), capacity = lines.filter(line => line.kind === "capacity-outage");
  return { models: count("models"), forwarded: count("forwarded"), routes: [...new Set(lines.filter(line => line.kind === "forwarded").map(line => line.model))], refused: count("refused"), passthrough: count("passthrough"), errors: count("forward-error"), routingRejections: routing.length, routingConverted503: routing.filter(line => line.action === "503").length, capacityHolds: capacity.filter(line => line.action === "hold").length, capacityPassed: capacity.filter(line => line.action === "pass").length, clientGone: count("client-gone"), refusedModels: [...new Set(lines.filter(line => line.kind === "refused").map(line => line.requested))] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [port, target, log, model, modelsFile, aliasList] = process.argv.slice(2);
  if (!target || !model || !modelsFile) throw new Error("usage: qualification-guard.mjs <port> <target> <log> <model> <models.json>");
  const { port: actual } = await startGuard({ port: Number(port), target, log, model, aliases: aliasList ? aliasList.split(",") : [], modelsBody: readFileSync(modelsFile) });
  console.log(`PORT ${actual}`);
}
