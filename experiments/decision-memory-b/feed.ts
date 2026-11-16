/**
 * The carrier decision feed of one run (project.ts §1.6 of the generated SPEC), served by the harness on 127.0.0.1 OUTSIDE the
 * workspace: the first GET /v1/decisions returns the whole decision log, every later one "no new decisions" (a cursor). Every request
 * is recorded, so the analysis knows when the worker fetched and re-fetched.
 */
import { createServer, type Server } from "node:http";
import { FEED_EMPTY, feedText, type Instance } from "./project.js";

export interface Feed { url: string; requests: { at: number; path: string; delivered: boolean }[]; close(): Promise<void> }

export function startFeed(inst: Instance): Promise<Feed> {
  const requests: Feed["requests"] = [];
  let delivered = false;
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    if (req.method === "GET" && path.split("?")[0] === "/v1/decisions") {
      const body = delivered ? FEED_EMPTY : feedText(inst);
      requests.push({ at: Date.now(), path, delivered: !delivered });
      delivered = true;
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(body);
      return;
    }
    requests.push({ at: Date.now(), path, delivered: false });
    res.writeHead(404).end("not found\n");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(done => server.close(() => done())) });
    });
  });
}
