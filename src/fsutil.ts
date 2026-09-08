import fs from 'node:fs';
import path from 'node:path';

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
]);

export const CODE_EXTS = new Set(['.ts', '.tsx']);

export function isCodeFile(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  if (!CODE_EXTS.has(ext)) return false;
  const base = path.basename(relPath);
  return !/(\.test|\.spec|\.stories)\.[jt]sx?$/.test(base) && base !== 'vite.config.ts';
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = path.relative(root, path.join(dir, e.name));
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile() && isCodeFile(rel)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}