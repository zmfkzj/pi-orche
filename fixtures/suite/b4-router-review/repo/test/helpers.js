import { Readable } from 'node:stream';
export function response() {
  return {
    statusCode: 200, headers: {}, writableEnded: false, text: '',
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(value = '') { this.text = String(value); this.writableEnded = true; },
  };
}
export async function request(app, method, url, body, chunks) {
  const req = Readable.from(chunks ?? (body === undefined ? [] : [JSON.stringify(body)]));
  req.method = method; req.url = url; req.headers = { 'content-type': 'application/json' };
  const res = response();
  await app.handler(req, res);
  return { status: res.statusCode, headers: res.headers, text: res.text,
    body: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(res.text) : undefined };
}
