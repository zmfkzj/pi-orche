// @ts-nocheck -- plain ESM run directly by node.
// Model-free dry-run upstream for the ultra-ho harness (experiments/ultra-ho/README.md "Dry run"): GET requests (the provider's model
// listing) are forwarded to the real CLIProxyAPI; every POST (a model request) is answered 503 without reaching any model. Launch the
// driver with ULTRA_HO_UPSTREAM=http://127.0.0.1:<port> to check the plumbing (Pi start, model registration through the run's proxy,
// the one-shot command, main's first request: model, effort, prompt_cache_key on the wire) at no model cost.
//   node experiments/ultra-ho/dry-upstream.mjs <port|0> [target, default http://127.0.0.1:8317]   → prints "PORT <n>"
import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const target = new URL(process.argv[3] ?? "http://127.0.0.1:8317");
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    if (req.method !== "GET") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "dry_run", message: "ultra-ho dry run: model requests are refused (no model is called)" } }));
      return;
    }
    const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: "GET", headers: { ...req.headers, host: target.host } }, upRes => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); });
    up.on("error", error => { if (!res.headersSent) res.writeHead(502); res.end(String(error)); });
    up.end();
  });
});
server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
server.listen(port, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
