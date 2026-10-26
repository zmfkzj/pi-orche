// @ts-nocheck -- plain ESM run by node INSIDE the sandbox (experiments/witness-replay/README.md "Isolation").
// The sandbox has its own network namespace (loopback only); its one way out is the unit proxy's unix socket bound into it. This
// bridge listens on the sandbox's 127.0.0.1:<port> and pipes every connection to that socket, then writes <ready file>.
//   node bridge.mjs <port> <unix socket path> <ready file>
import net from "node:net";
import { writeFileSync } from "node:fs";

const [port, socketPath, ready] = process.argv.slice(2);
const server = net.createServer(client => {
  const upstream = net.createConnection(socketPath);
  client.pipe(upstream); upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close); upstream.on("error", close); client.on("close", close); upstream.on("close", close);
});
server.listen(Number(port), "127.0.0.1", () => { if (ready) writeFileSync(ready, String(process.pid)); });
