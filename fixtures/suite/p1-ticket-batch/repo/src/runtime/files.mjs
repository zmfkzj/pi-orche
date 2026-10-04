import { readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
export function resolveInside(root, name) {
  const path = resolve(root, name);
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith('..' + '/') || isAbsolute(rel)) {
    throw Object.assign(new Error('Path outside root'), { code: 'PATH_ESCAPE' });
  }
  return path;
}
export async function readJson(path, { maxBytes = 1048576 } = {}) {
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new RangeError('File exceeds limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyntaxError('Invalid JSON file', { cause: error });
  }
}
/** Temporary name is supplied by the caller rather than using random state. */
export async function writeJsonAtomic(path, value, temporary) {
  if (path === temporary) throw new Error('Temporary path must differ');
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    // Do not unlink another writer's preexisting temporary file.
    throw error;
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function listFiles(root, extension) {
  const result = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) {
        result.push(relative(root, path));
      }
    }
  }
  await walk(root);
  return result;
}
export function fileExtension(name) {
  const base = name.split('/').at(-1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}
export function safeFileName(name) {
  return name.normalize('NFC').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '') || 'untitled';
}
