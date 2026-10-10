// Logging reverse proxy in front of the real CLIProxyAPI for one run (experiments/ultra-ab). Per model request it logs the
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
export function usageFrom(text) {
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
          model: j.model, effort: j.reasoning?.effort ?? j.reasoning_effort, session: j.prompt_cache_key,
          worker: text.includes("persistent coding worker"), bytes: body.length,
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
            const usage = usageFrom(last);
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
