// Logging reverse proxy in front of the real CLIProxyAPI for one run (experiments/stage-eval; derived from experiments/ultra-ab). Per model request it logs the
// requested model, reasoning effort, prompt_cache_key (Pi session), whether the request is an orche worker's (prompt marker), the
// HTTP status, the model and usage the provider reported in its response stream, stream errors and timing. It never logs headers,
// credentials or bodies.
//   node proxy.mjs <port|0> <target url> <wire.jsonl>   → prints "PORT <n>" once listening
import http from "node:http";
import zlib from "node:zlib";
import { appendFileSync } from "node:fs";

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1));
const [port, target, log] = main ? [Number(process.argv[2]), new URL(process.argv[3]), process.argv[4]] : [0, undefined, undefined];
let seq = 0;
const decode = (enc, buf) => enc === "zstd" ? zlib.zstdDecompressSync(buf) : enc === "gzip" ? zlib.gunzipSync(buf) : enc === "br" ? zlib.brotliDecompressSync(buf) : enc === "deflate" ? zlib.inflateSync(buf) : buf;
const HEAD = 65536, TAIL = 8 * 1024 * 1024;

/**
 * Usage of a Responses API SSE stream: the `response.usage` of its final `response.completed` / `response.incomplete` /
 * `response.failed` event (top-level counts; the nested per-item attribution is ignored). Chat-completions style `usage` as fallback.
 */
export function usageFrom(text, head = "") {
  const anthropic = anthropicUsage(head, text);
  if (anthropic) return anthropic;
  let found;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || !/"response\.(completed|incomplete|failed)"/.test(line)) continue;
    try {
      const event = JSON.parse(line.slice(6));
      const usage = event.response?.usage;
      if (usage && typeof usage.output_tokens === "number") found = { input: usage.input_tokens, cached: usage.input_tokens_details?.cached_tokens ?? 0, output: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0, final: event.type, respModel: event.response?.model };
    } catch { /* cut line */ }
  }
  return found;
}

/**
 * Usage of an Anthropic Messages SSE stream (CLIProxyAPI /v1/messages; the bundled provider routes Claude models there since
 * 2026-11-12): `message_start` (in the stream's head) carries input, cache-read and cache-creation tokens; the last
 * `message_delta` carries the output tokens (and may restate the cache counts); `message_stop` marks a complete response.
 * `input` is reported INCLUDING cache reads and writes, as for the Responses API, so uncached = input − cached − cacheWrite.
 */
export function anthropicUsage(head, tail) {
  let start, delta, stopped = false, model;
  for (const line of `${head}\n${tail}`.split("\n")) {
    if (!line.startsWith("data: ") || !/"type"\s*:\s*"message_(start|delta|stop)"/.test(line)) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === "message_start" && event.message?.usage) { start = event.message.usage; model = event.message.model; }
      else if (event.type === "message_delta" && event.usage) delta = event.usage;
      else if (event.type === "message_stop") stopped = true;
    } catch { /* cut line */ }
  }
  if (!start && !delta) return undefined;
  const pick = key => delta?.[key] ?? start?.[key] ?? 0;
  const input = pick("input_tokens"), cached = pick("cache_read_input_tokens"), cacheWrite = pick("cache_creation_input_tokens");
  return { input: input + cached + cacheWrite, cached, cacheWrite, output: delta?.output_tokens ?? start?.output_tokens ?? 0, reasoning: 0, final: stopped ? "message_stop" : "message_incomplete", ...(model ? { respModel: model } : {}) };
}

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
        Object.assign(entry, {
          model: j.model, effort: j.reasoning?.effort ?? j.reasoning_effort ?? j.output_config?.effort, session: j.prompt_cache_key ?? j.metadata?.user_id,
          worker: text.includes("persistent coding worker"), bytes: body.length,
          // Isolation evidence without bodies: the offered tool NAMES, whether any orche text reached the request, the size of
          // the instructions (system prompt) and how many input items the request carried.
          tools: Array.isArray(j.tools) ? j.tools.map(t => t?.name ?? t?.function?.name ?? t?.type).filter(Boolean) : [],
          orcheMarker: /orche_task|task_plan|persistent coding worker|report_result/.test(text),
          instructionsChars: typeof j.instructions === "string" ? j.instructions.length : 0,
          inputItems: Array.isArray(j.input) ? j.input.length : 0,
        });
      }
    } catch (e) { entry.unparsed = body.length; entry.parseError = String(e).slice(0, 120); }
    let done = false;
    const finish = () => { if (done) return; done = true; appendFileSync(log, JSON.stringify(entry) + "\n"); };
    const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, upRes => {
      entry.status = upRes.statusCode;
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      let bytes = 0; const head = []; const tailChunks = []; let tailBytes = 0;
      upRes.on("data", c => {
        bytes += c.length; if (bytes - c.length < HEAD) head.push(c);
        tailChunks.push(c); tailBytes += c.length;
        while (tailChunks.length > 1 && tailBytes - tailChunks[0].length >= TAIL) tailBytes -= tailChunks.shift().length;
        res.write(c);
      });
      // After the final event Pi closes its side and the upstream socket is destroyed ("aborted"): recorded, not an error by itself.
      upRes.on("error", e => { entry.upstreamError = String(e).slice(0, 200); });
      upRes.on("close", () => {
        entry.respBytes = bytes; entry.endAt = new Date().toISOString();
        if (req.method === "POST") {
          try {
            const enc = upRes.headers["content-encoding"];
            const first = decode(enc, Buffer.concat(head)).toString("utf8");
            const m = /"model"\s*:\s*"([^"]+)"/.exec(first); if (m) entry.respModel = m[1];
            const last = enc ? first : Buffer.concat(tailChunks).toString("utf8");
            if (process.env.PROXY_DUMP_DIR) appendFileSync(`${process.env.PROXY_DUMP_DIR}/tail-${entry.id}.txt`, last.slice(-20000));
            const usage = usageFrom(last, first);
            if (usage) { const { final, respModel, ...counts } = usage; entry.usage = counts; entry.final = final; if (respModel) entry.finalModel = respModel; }
            else entry.noFinalEvent = true;
            if (/"type"\s*:\s*"(response\.failed|error)"/.test(last)) entry.errorEvent = true;
          } catch (e) { entry.respParseError = String(e).slice(0, 80); }
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
// WebSocket transport is refused so the client uses SSE, which this proxy can log.
server.on("upgrade", (req, socket) => {
  appendFileSync(log, JSON.stringify({ id: ++seq, at: new Date().toISOString(), method: req.method, path: req.url, upgrade: true, refused: 426 }) + "\n");
  socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});
if (main) {
  server.listen(port, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
}
