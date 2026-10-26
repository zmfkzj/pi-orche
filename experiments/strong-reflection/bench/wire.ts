/**
 * Record/replay proxy of the strong-reflection bench (docs/strong-reflection.md, "Hard-task bench"). It sits between the in-process
 * orche stack and the real CLIProxyAPI (Codex Responses API over SSE) of ONE arm process.
 *
 * - record (arm O): every model request is forwarded and stored whole (request JSON, decoded SSE response, timing) in wire.jsonl.
 *   `markCheckpoint` (called by the observe-only reflection hook) fixes the reflection point: the ordinal C of the top worker's next
 *   request and the global sequence at that moment.
 * - replay (arms R0, R1): a request of a session that maps to a recorded session gets the recorded response (after the recorded latency,
 *   so asynchronous helper notes land where they landed) while it lies before the reflection point: the top worker's ordinals < C,
 *   other sessions' requests recorded before the checkpoint. From the top worker's request C on, every request goes live. Each replayed
 *   request is checked against its recording (the call ids of its input); a mismatch is a divergence and that session goes live.
 *
 * Sessions are the request's `prompt_cache_key` (Pi's session id); a replay session maps to the recorded session with the same
 * normalized first-request signature (instructions + first input items), else to the first unmapped recorded session of its class.
 */
import http from "node:http";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

export interface WireRecord {
  seq: number;
  session: string;
  ordinal: number;
  top: boolean;
  start: number;
  end: number;
  status: number;
  /** live: forwarded upstream; replay: served from the recording; refused: answered 503 by this proxy, never forwarded. */
  mode: "live" | "replay" | "refused";
  /** replay: seq of the recorded request served. */
  recordedSeq?: number;
  path: string;
  request: any;
  response: string;
  contentType?: string;
  usage?: Usage;
  error?: string;
}
export interface Usage { input: number; cached: number; output: number; reasoning: number }
export interface Checkpoint { kind: "integrate" | "report"; node?: string; ordinal: number; seq: number; at: number }
export interface ReplayEvent { at: number; type: "map" | "divergence" | "extra" | "switch" | "unmapped" | "late" | "refused" | "offline-models"; detail: string }
/** Meta of one proxied request. */
export interface RequestMeta { seq: number; session: string; ordinal: number; top: boolean }
/**
 * A pre-forward gate (the decision-audit pilot: model/effort and budget): consulted before ANY request reaches the upstream. A refusal
 * answers 503 without contacting it; an accepted request is settled once its response ended (usage, status; undefined usage when the
 * stream had none, e.g. an interrupted one).
 */
export type ForwardGate = (request: any, meta: RequestMeta) => { ok: true; settle: (usage: Usage | undefined, status: number) => void } | { ok: false; reason: string };

const decode = (enc: string | undefined, buf: Buffer): Buffer => enc === "zstd" ? (zlib as any).zstdDecompressSync(buf) : enc === "gzip" ? zlib.gunzipSync(buf) : enc === "br" ? zlib.brotliDecompressSync(buf) : enc === "deflate" ? zlib.inflateSync(buf) : buf;

/** Usage of a Responses SSE stream (its final response.completed / incomplete / failed event). */
export function usageOf(text: string): Usage | undefined {
  let found: Usage | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || !/"response\.(completed|incomplete|failed)"/.test(line)) continue;
    try {
      const usage = JSON.parse(line.slice(6)).response?.usage;
      if (usage && typeof usage.output_tokens === "number") found = { input: usage.input_tokens ?? 0, cached: usage.input_tokens_details?.cached_tokens ?? 0, output: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0 };
    } catch { /* cut line */ }
  }
  return found;
}

/** Function-call ids of a request's input, in order: the replay alignment key. */
export function callIds(request: any): string[] {
  const input = Array.isArray(request?.input) ? request.input : [];
  return input.flatMap((item: any) => item && item.type === "function_call" && typeof item.call_id === "string" ? [item.call_id] : []);
}

const textOf = (item: any): string => typeof item?.content === "string" ? item.content : Array.isArray(item?.content) ? item.content.map((part: any) => part?.text ?? "").join("") : typeof item?.output === "string" ? item.output : "";
/** Run-specific noise removed before comparing texts: UUIDs, ISO times, epoch ms, base36 artifact ids. */
export const normalize = (text: string): string => text
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}(?:[.-]\d+)?Z?/g, "<time>")
  .replace(/\b1[0-9]{12}\b/g, "<ms>")
  .replace(/-m[a-z0-9]{7}-[0-9a-f]{6}\b/g, "-<artifact>")
  .replace(/task-[0-9a-f]{8}/g, "task-<id>");

/** Signature of a session's first request. */
export function signature(request: any): string {
  const input = Array.isArray(request?.input) ? request.input : [];
  return createHash("sha256").update(normalize(String(request?.instructions ?? ""))).update("\0").update(normalize(input.slice(0, 2).map(textOf).join("\0"))).digest("hex");
}
export const classOf = (request: any): string => { const text = String(request?.instructions ?? ""); return text.includes("read-only advisor of a coding agent") ? "advisor" : text.includes("persistent coding worker") ? "worker" : "other"; };

/** Every string inside `value` with `from` replaced by `to` (a deep copy). */
export function deepReplace<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return value.split(from).join(to) as T;
  if (Array.isArray(value)) return value.map(item => deepReplace(item, from, to)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepReplace(item, from, to)])) as T;
  return value;
}

/**
 * A recorded SSE response with `from` replaced by `to` (equal lengths: a moved live path). Whole events are replaced in every string;
 * streamed `*.delta` fragments are rewritten per stream (same type, item, output/content/summary index) so that their concatenation
 * is the replaced text with the original fragment boundaries — a path split across fragments is replaced too. Lines that do not
 * change are kept byte for byte.
 */
export function rewriteSse(text: string, from: string, to: string): string {
  if (from.length !== to.length) throw new Error("rewriteSse needs equal-length strings");
  if (!from || from === to) return text;
  const lines = text.split("\n");
  const parsed = lines.map(line => { if (!line.startsWith("data: ")) return undefined; try { return JSON.parse(line.slice(6)); } catch { return undefined; } });
  const key = (event: any) => `${event.type}|${event.item_id ?? ""}|${event.output_index ?? ""}|${event.content_index ?? ""}|${event.summary_index ?? ""}`;
  const streams = new Map<string, string>();
  const spans = new Map<number, { stream: string; offset: number; length: number }>();
  parsed.forEach((event, index) => {
    if (!event || typeof event.type !== "string" || !event.type.endsWith(".delta") || typeof event.delta !== "string") return;
    const stream = key(event), before = streams.get(stream) ?? "";
    spans.set(index, { stream, offset: before.length, length: event.delta.length });
    streams.set(stream, before + event.delta);
  });
  const replaced = new Map([...streams].map(([stream, value]) => [stream, value.split(from).join(to)]));
  return lines.map((line, index) => {
    const event = parsed[index];
    if (!event) return line;
    const span = spans.get(index);
    if (span) {
      const delta = replaced.get(span.stream)!.slice(span.offset, span.offset + span.length);
      return delta === event.delta ? line : `data: ${JSON.stringify({ ...event, delta })}`;
    }
    return JSON.stringify(event).includes(from) ? `data: ${JSON.stringify(deepReplace(event, from, to))}` : line;
  }).join("\n");
}

export interface WireOptions {
  mode: "record" | "replay";
  upstream: string;
  wireFile: string;
  /** replay: the recording and its checkpoint. */
  recording?: WireRecord[];
  checkpoint?: Checkpoint;
  /**
   * Called with the top worker's request at the reflection point (record: ordinal C; replay: the switch to live). Returning false
   * (a fidelity gate) refuses that request instead of forwarding it, and the proxy refuses everything after it.
   */
  onCheckpointRequest?: (request: any, ordinal: number) => unknown;
  /** Replay latency factor (1 = recorded latency). */
  speed?: number;
  /** Never contact the upstream: every request that would be forwarded is refused (a dry replay up to the reflection point). */
  offline?: boolean;
  /** Offline: the provider's model-list GET (`/v1/models…`, no model call) is answered from this snapshot instead of being refused. */
  offlineModels?: { contentType: string; body: string };
  /**
   * Replay: a request that would create new history before the reflection point (a divergence, an unmapped session, a request with no
   * recording) is refused instead of going live; so is a request other than a JSON POST or a GET. Helper requests recorded after the
   * checkpoint (`late`) still go live: they belong to the continuation.
   */
  strictPrefix?: boolean;
  /** Consulted before every forward (see ForwardGate). */
  gate?: ForwardGate;
  /**
   * Replay at a moved live path: every replayed response has `from` replaced by `to` (equal length, `rewriteSse`), and recorded
   * first requests are matched with it applied. Opaque encrypted reasoning cannot be rewritten.
   */
  pathMap?: { from: string; to: string };
}

export function loadWire(file: string): WireRecord[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

export class WireProxy {
  private server?: http.Server;
  private seq = 0;
  private sessions = new Map<string, { ordinal: number; recorded?: string; top: boolean; live: boolean }>();
  private topSession?: string;
  private recorded = new Map<string, WireRecord[]>();
  private recordedFirst = new Map<string, WireRecord>();
  private mapped = new Set<string>();
  private recordedTop?: string;
  checkpoint?: Checkpoint;
  switched = false;
  readonly events: ReplayEvent[] = [];
  private checkpointCaptured = false;
  /** Set by the first refusal (offline, strict prefix, fidelity or forward gate): every later request is refused too. */
  halted?: string;

  constructor(private readonly options: WireOptions) {
    if (options.mode === "replay") {
      if (!options.recording || !options.checkpoint) throw new Error("replay needs a recording and its checkpoint");
      this.checkpoint = options.checkpoint;
      for (const record of [...options.recording].sort((a, b) => a.seq - b.seq)) {
        if (!this.recorded.has(record.session)) { this.recorded.set(record.session, []); this.recordedFirst.set(record.session, record); }
        this.recorded.get(record.session)!.push(record);
        if (record.top) this.recordedTop = record.session;
      }
    }
  }

  async listen(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  close(): Promise<void> { return new Promise(resolve => this.server ? this.server.close(() => resolve()) : resolve()); }

  /** Record mode: the observe-only reflection hook fired (once). */
  markCheckpoint(kind: Checkpoint["kind"], node?: string): void {
    if (this.checkpoint) return;
    const top = this.topSession ? this.sessions.get(this.topSession) : undefined;
    this.checkpoint = { kind, node, ordinal: top?.ordinal ?? 0, seq: this.seq, at: Date.now() };
  }

  private event(type: ReplayEvent["type"], detail: string): void { this.events.push({ at: Date.now(), type, detail }); }

  private session(key: string, request: any) {
    let state = this.sessions.get(key);
    if (state) return state;
    const top = this.sessions.size === 0;
    state = { ordinal: 0, top, live: false };
    if (top) this.topSession = key;
    if (this.options.mode === "replay") {
      let recorded: string | undefined;
      if (top) recorded = this.recordedTop;
      else {
        const sig = signature(request);
        const map = this.options.pathMap;
        const recordedSig = (first: WireRecord) => signature(map ? deepReplace(first.request, map.from, map.to) : first.request);
        recorded = [...this.recordedFirst.entries()].find(([session, first]) => !this.mapped.has(session) && !first.top && recordedSig(first) === sig)?.[0];
        if (!recorded) {
          const cls = classOf(request);
          recorded = [...this.recordedFirst.entries()].find(([session, first]) => !this.mapped.has(session) && !first.top && classOf(first.request) === cls)?.[0];
          this.event(recorded ? "map" : "unmapped", `${key.slice(-8)} → ${recorded?.slice(-8) ?? "none"} by class ${cls}`);
        } else this.event("map", `${key.slice(-8)} → ${recorded.slice(-8)} by signature`);
      }
      if (recorded) { this.mapped.add(recorded); state.recorded = recorded; } else state.live = true;
    }
    this.sessions.set(key, state);
    return state;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let request: any;
      try { request = raw.length ? JSON.parse(decode(req.headers["content-encoding"] as string | undefined, raw).toString("utf8")) : undefined; } catch { request = undefined; }
      if (this.halted) return this.refuse(res, undefined, undefined, `halted (${this.halted})`, false);
      if (req.method !== "POST" || !request) {
        if (this.options.offline && this.options.offlineModels && req.method === "GET" && (req.url ?? "").startsWith("/v1/models")) {
          this.event("offline-models", `${req.url ?? ""} answered from the snapshot`);
          res.writeHead(200, { "content-type": this.options.offlineModels.contentType });
          return void res.end(this.options.offlineModels.body);
        }
        // Offline refusals never halt: nothing can be forwarded anyway, and a dry replay must reach its reflection point.
        if (this.options.offline) return this.refuse(res, undefined, undefined, `offline: ${req.method} ${req.url ?? ""} not forwarded`, false);
        if ((this.options.strictPrefix || this.options.gate) && req.method !== "GET" && req.method !== "HEAD") return this.refuse(res, undefined, undefined, `${req.method} ${req.url ?? ""} without a JSON body`);
        return this.forward(req, res, raw, undefined, undefined);
      }
      const key = String(request.prompt_cache_key ?? "no-key");
      const state = this.session(key, request);
      const ordinal = state.ordinal++;
      const seq = ++this.seq;
      const meta = { seq, session: key, ordinal, top: state.top };
      if (this.options.mode === "record") {
        if (state.top && this.checkpoint && ordinal === this.checkpoint.ordinal && !this.checkpointCaptured) { this.checkpointCaptured = true; this.options.onCheckpointRequest?.(request, ordinal); }
        return this.forward(req, res, raw, request, meta);
      }
      const cp = this.checkpoint!;
      const list = state.recorded ? this.recorded.get(state.recorded)! : [];
      const rec = list[ordinal];
      let live = this.switched || state.live || !rec;
      // A request that would add history before the reflection point: no recorded response to serve, or a diverged/unmapped session.
      let escape = !this.switched && (state.live || !rec);
      if (!live && state.top && ordinal >= cp.ordinal) {
        live = true;
        this.switched = true;
        this.event("switch", `top worker request ${ordinal} (seq ${seq}) goes live`);
        if (!this.checkpointCaptured) {
          this.checkpointCaptured = true;
          if (this.options.onCheckpointRequest?.(request, ordinal) === false) return this.refuse(res, request, meta, "fidelity gate at the reflection point");
        }
      }
      if (!live && !state.top && rec!.seq > cp.seq) { live = true; this.event("late", `${key.slice(-8)}#${ordinal}: recorded after the checkpoint (seq ${rec!.seq}); live`); }
      if (!live && rec && JSON.stringify(callIds(request)) !== JSON.stringify(callIds(rec.request))) {
        live = true; state.live = true; escape = true;
        this.event("divergence", `${state.top ? "TOP " : ""}${key.slice(-8)}#${ordinal}: call ids differ from the recording (${callIds(request).length} vs ${callIds(rec.request).length}); live from here`);
      }
      if (!rec && !this.switched) this.event("extra", `${key.slice(-8)}#${ordinal}: no recorded request; live`);
      if (live && escape && this.options.strictPrefix) return this.refuse(res, request, meta, "strict prefix: a request before the reflection point without a recorded response");
      if (live) return this.forward(req, res, raw, request, meta);
      return this.serve(res, request, meta, rec!);
    });
  }

  private write(entry: WireRecord): void { appendFileSync(this.options.wireFile, `${JSON.stringify(entry)}\n`); }

  /** Answers 503 without contacting the upstream; halts the proxy (every later request is refused) unless `halt` is false. */
  private refuse(res: http.ServerResponse, request: any, meta: RequestMeta | undefined, reason: string, halt = true): void {
    if (halt && !this.halted) this.halted = reason;
    this.event("refused", `${meta ? `${meta.top ? "TOP " : ""}${meta.session.slice(-8)}#${meta.ordinal}` : "request"}: ${reason}`);
    if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `refused by the bench proxy: ${reason}`, type: "bench_proxy_refusal" } }));
    const now = Date.now();
    if (meta) this.write({ ...meta, start: now, end: now, status: 503, mode: "refused", path: "", request: { model: request?.model, reasoning: request?.reasoning, items: Array.isArray(request?.input) ? request.input.length : undefined }, response: "", error: reason });
  }

  private serve(res: http.ServerResponse, request: any, meta: { seq: number; session: string; ordinal: number; top: boolean }, rec: WireRecord): void {
    const start = Date.now();
    res.writeHead(rec.status, { "content-type": rec.contentType ?? "text/event-stream", "cache-control": "no-cache" });
    const delay = Math.max(0, (rec.end - rec.start) * (this.options.speed ?? 1));
    const keepalive = setInterval(() => { try { res.write(": replay\n\n"); } catch { /* closed */ } }, 10_000);
    let closed = false;
    res.on("close", () => { closed = true; clearInterval(keepalive); });
    setTimeout(() => {
      clearInterval(keepalive);
      if (!closed) { const map = this.options.pathMap; res.write(map ? rewriteSse(rec.response, map.from, map.to) : rec.response); res.end(); }
      this.write({ ...meta, start, end: Date.now(), status: rec.status, mode: "replay", recordedSeq: rec.seq, path: rec.path, request, response: "", contentType: rec.contentType, usage: rec.usage, ...(closed ? { error: "client closed before the replayed response" } : {}) });
    }, delay);
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer, request: any, meta?: RequestMeta): void {
    if (this.options.offline) return this.refuse(res, request, meta, "offline: nothing is forwarded", false);
    let settle: ((usage: Usage | undefined, status: number) => void) | undefined;
    if (this.options.gate && meta) {
      const verdict = this.options.gate(request, meta);
      if (!verdict.ok) return this.refuse(res, request, meta, verdict.reason);
      let settled = false;
      settle = (usage, status) => { if (!settled) { settled = true; verdict.settle(usage, status); } };
    }
    let responded = false;
    const target = new URL(this.options.upstream);
    const start = Date.now();
    const headers = { ...req.headers, host: target.host };
    delete headers["accept-encoding"];
    const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers }, upRes => {
      responded = true;
      const out: Buffer[] = [];
      const responseHeaders = { ...upRes.headers };
      res.writeHead(upRes.statusCode ?? 502, responseHeaders);
      upRes.on("data", chunk => { out.push(chunk); res.write(chunk); });
      upRes.on("error", () => { /* recorded at close */ });
      upRes.on("close", () => {
        res.end();
        if (!meta) return;
        let text = "";
        try { text = decode(upRes.headers["content-encoding"] as string | undefined, Buffer.concat(out)).toString("utf8"); } catch (error) { text = `<undecodable: ${String(error).slice(0, 100)}>`; }
        const usage = usageOf(text);
        settle?.(usage, upRes.statusCode ?? 0);
        this.write({ ...meta, start, end: Date.now(), status: upRes.statusCode ?? 0, mode: "live", path: req.url ?? "", request, response: text, contentType: String(upRes.headers["content-type"] ?? ""), usage });
      });
    });
    up.on("error", error => {
      // A response that had started may have generated tokens: settle it at its reservation (no usage, status 200).
      settle?.(undefined, responded ? 200 : 502);
      if (!res.headersSent) res.writeHead(502);
      res.end();
      if (meta) this.write({ ...meta, start, end: Date.now(), status: 502, mode: "live", path: req.url ?? "", request, response: "", error: String(error).slice(0, 200) });
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    up.end(raw);
  }
}
