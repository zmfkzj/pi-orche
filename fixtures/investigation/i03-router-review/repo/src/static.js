import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { error } from './response.js';

const types = { '.html': 'text/html', '.txt': 'text/plain', '.css': 'text/css' };

/** Serve paths under /static/ from the configured public directory. */
export async function serveStatic(req, res, publicDir) {
  if (req.method !== 'GET' || !req.url.split('?')[0].startsWith('/static/')) return false;
  let relative;
  try {
    relative = decodeURIComponent(req.url.split('?')[0].slice('/static/'.length));
  } catch {
    error(res, 400, 'invalid path');
    return true;
  }
  const root = resolve(publicDir);
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(root + sep)) {
    error(res, 403, 'forbidden');
    return true;
  }
  try {
    const content = await readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    res.end(content);
  } catch {
    error(res, 404, 'file not found');
  }
  return true;
}
