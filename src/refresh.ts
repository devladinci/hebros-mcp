import fs from 'node:fs';
import path from 'node:path';
import { analyze, detectLang } from './analyze.js';
import { buildIndex } from './builder.js';
import { loadIndex, saveIndex } from './db.js';
import { git, headSha, statusHash, statusPorcelainRaw } from './gitinfo.js';
import { listFiles } from './fsutil.js';
import { initParser, parseFile } from './parser.js';
import type { IndexData } from './types.js';

/** Paths changed between two commits (NUL-delimited: safe with quotes/UTF-8). null when the diff fails (e.g. unreachable SHA). */
export function diffPaths(root: string, prevSha: string, currSha: string): string[] | null {
  const out = git(root, ['diff', '--name-only', '-z', prevSha, currSha]);
  if (out === null) return null;
  return out ? out.split('\0').filter(Boolean) : [];
}

/** True when `sha` resolves to a commit reachable in this repo. */
export function commitExists(root: string, sha: string): boolean {
  return git(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

/**
 * Working-tree changes from `git status --porcelain -z` (NUL-delimited records:
 * XY<SP>path\0; rename/copy records are two consecutive NUL fields: to, then from).
 * Robust against spaces, quotes, newlines and non-ASCII in paths.
 */
export function porcelainPaths(root: string): { changed: string[]; removed: string[] } {
  const raw = statusPorcelainRaw(root);
  const changed: string[] = [];
  const removed: string[] = [];
  if (!raw) return { changed, removed };

  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!;
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const entry = rec.slice(3);
    if (!entry) continue;
    if (status.includes('R') || status.includes('C')) {
      // field i is the new path, field i+1 the original
      const from = fields[i + 1] ?? '';
      if (from) removed.push(from);
      changed.push(entry);
      i++;
      continue;
    }
    if (status.includes('D')) removed.push(entry);
    else changed.push(entry);
  }
  return { changed, removed };
}

/**
 * Incremental refresh, git-based:
 *  1. commits since stored headSha -> git diff --name-only prev..HEAD
 *  2. working-tree changes         -> git status --porcelain (also catches new files)
 *  3. untracked files deleted from disk are invisible to git -> sync file list vs disk
 *  4. no git / no index / history rewritten (stored HEAD unreachable)
 *                                    -> full rebuild (correct fallback)
 */
export async function refreshIndex(
  root: string,
): Promise<{ data: IndexData; rebuilt: boolean; note: string }> {
  const existing = loadIndex(root);
  if (!existing) {
    const { data } = await buildIndex(root);
    return { data, rebuilt: true, note: 'no index — full build' };
  }

  const prevSha = existing.meta.headSha;
  const currSha = headSha(root);
  const currStatus = statusHash(root);
  const started = Date.now();

  if (prevSha === currSha && existing.meta.statusHash === currStatus) {
    return { data: existing, rebuilt: false, note: 'git state unchanged — index already fresh' };
  }

  // History rewrite (rebase/amend/filter-branch) makes the stored HEAD SHA
  // unreachable: git diff fails and an incremental diff would silently keep
  // every stale symbol. Verify the base commit, fall back to a full build.
  if (prevSha && !commitExists(root, prevSha)) {
    const { data } = await buildIndex(root);
    return { data, rebuilt: true, note: 'stored HEAD unreachable (history rewritten?) — full rebuild' };
  }

  const dirty = new Set<string>();
  const removed = new Set<string>();

  if (prevSha && currSha && prevSha !== currSha) {
    const diffs = diffPaths(root, prevSha, currSha);
    if (diffs === null) {
      // diff failed for an unexpected reason — do not trust a partial update
      const { data } = await buildIndex(root);
      return { data, rebuilt: true, note: 'git diff failed — full rebuild' };
    }
    for (const p of diffs) {
      if (fs.existsSync(path.join(root, p))) dirty.add(p);
      else removed.add(p);
    }
  }
  const work = porcelainPaths(root);
  for (const f of work.changed) if (fs.existsSync(path.join(root, f))) dirty.add(f);
  for (const f of work.removed) removed.add(f);

  // Deleted untracked files leave no porcelain trace — sync against disk.
  for (const f of Object.keys(existing.files)) {
    if (!fs.existsSync(path.join(root, f))) removed.add(f);
  }
  for (const f of removed) dirty.delete(f);

  await initParser();

  const filesMeta = { ...existing.files };
  for (const f of removed) delete filesMeta[f];

  const keep = (file: string): boolean => !removed.has(file) && !dirty.has(file);
  const symbols = existing.symbols.filter((s) => keep(s.file));
  const imports = existing.imports.filter((i) => keep(i.file));
  const calls = existing.calls.filter((c) => keep(c.file));

  let parsed = 0;
  for (const f of dirty) {
    const lang = detectLang(f);
    if (!lang) {
      delete filesMeta[f]; // changed to a non-code file (or deleted) — drop it
      continue;
    }
    let code: string;
    try {
      code = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      delete filesMeta[f];
      continue;
    }
    const tree = parseFile(code, lang);
    const res = analyze(f, tree);
    tree.delete();
    symbols.push(...res.symbols);
    imports.push(...res.imports);
    calls.push(...res.calls);
    filesMeta[f] = { loc: code.split('\n').length, bytes: Buffer.byteLength(code) };
    parsed++;
  }

  const data: IndexData = {
    meta: {
      root: existing.meta.root,
      builtAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      headSha: currSha ?? prevSha,
      statusHash: currStatus ?? existing.meta.statusHash,
    },
    files: filesMeta,
    symbols,
    imports,
    calls,
  };
  saveIndex(root, data);
  return { data, rebuilt: false, note: `${parsed} file(s) re-parsed, ${removed.size} removed` };
}