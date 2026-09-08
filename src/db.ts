import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, type IndexData } from './types.js';

/**
 * Index files live OUTSIDE the indexed repo, in a per-repo cache dir keyed by
 * the repo's realpath. Keeps the repo clean (no .hebros/ noise in git status,
 * which the refresh logic itself greps) and lets one install serve many repos.
 * HEBROS_CACHE overrides the cache root (used by tests).
 */
export function cacheDir(root: string): string {
  const base = process.env.HEBROS_CACHE ?? path.join(os.homedir(), '.cache', 'hebros');
  const key = createHash('sha1').update(fs.realpathSync(root)).digest('hex').slice(0, 12);
  return path.join(base, key);
}

export function indexFile(root: string): string {
  return path.join(cacheDir(root), 'index.json');
}

export function saveIndex(root: string, data: IndexData): string {
  const dir = cacheDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.json');
  const payload = JSON.stringify({ ...data, meta: { ...data.meta, schemaVersion: SCHEMA_VERSION } });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, file); // atomic even with concurrent readers
  return file;
}

export function loadIndex(root: string): IndexData | null {
  try {
    const data = JSON.parse(fs.readFileSync(indexFile(root), 'utf8')) as IndexData;
    // Schema mismatch (e.g. old cache without endLine) -> discard, caller rebuilds.
    if (data.meta.schemaVersion !== SCHEMA_VERSION) return null;
    return data;
  } catch {
    return null; // missing or corrupt -> caller rebuilds from scratch
  }
}