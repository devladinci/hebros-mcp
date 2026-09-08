import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Run a git command in `root`; returns stdout without trailing NUL/newline runs
 *  (leading whitespace is preserved — porcelain encodes status in it),
 *  or null when git is missing / not a repo. */
export function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/[\0\n]+$/, '');
  } catch {
    return null;
  }
}

export function headSha(root: string): string | null {
  const sha = git(root, ['rev-parse', 'HEAD']);
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** NUL-delimited porcelain: safe for quotes/newlines in paths. */
export function statusPorcelainRaw(root: string): string | null {
  return git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
}

/**
 * Stable fingerprint of working-tree state. 'clean' when empty, null when no git.
 * Includes size+mtime of each listed file so that re-editing an already-dirty
 * file (or one inside an untracked dir) still changes the fingerprint.
 */
export function statusHash(root: string): string | null {
  const out = statusPorcelainRaw(root);
  if (out === null) return null;
  if (out === '') return 'clean';
  const h = createHash('sha1').update(out);
  for (const rec of out.split('\0')) {
    if (rec.length < 4) continue;
    let entry = rec.slice(3);
    try {
      const st = fs.statSync(path.join(root, entry));
      h.update(`${entry}:${st.size}:${st.mtimeMs}`);
    } catch {
      // deleted between status and stat — the porcelain bytes still hash
    }
  }
  return h.digest('hex');
}