import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS } from './fsutil.js';
import type { Edge, ImportRow } from './types.js';

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const DIR_INDEX = ['/index.ts', '/index.tsx', '/index.js'];

function existsRel(root: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

function resolveAsFile(root: string, rel: string): string | null {
  // specifier may already carry an extension (`@/lib/utils.ts`) — try it as-is
  if (/\.[a-z]+$/.test(rel) && existsRel(root, rel)) return rel;
  for (const ext of TS_EXTS) {
    if (existsRel(root, rel + ext)) return rel + ext;
  }
  // TypeScript ESM style: `./x.js` written in source, `x.ts` on disk.
  const swapped = rel.replace(/\.(js|mjs|cjs|jsx)$/, '.ts');
  if (swapped !== rel && existsRel(root, swapped)) return swapped;
  const swappedX = rel.replace(/\.(js|jsx)$/, '.tsx');
  if (swappedX !== rel && existsRel(root, swappedX)) return swappedX;
  return null;
}

function resolveAsDirIndex(root: string, rel: string): string | null {
  for (const idx of DIR_INDEX) {
    if (existsRel(root, rel + idx)) return rel + idx;
  }
  return null;
}

function resolveRelative(fromFile: string, spec: string, root: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return resolveAsFile(root, base) ?? resolveAsDirIndex(root, base);
}

/* ------------------------------------------------------------------ */
/* tsconfig discovery                                                  */
/* ------------------------------------------------------------------ */

/**
 * One tsconfig's `paths` entry. `scope` is the repo-relative directory the
 * config lives in: its aliases apply only to files under that directory
 * (a root-level tsconfig has scope '' and applies repo-wide). Targets are
 * repo-relative with the `*` kept.
 */
export interface AliasConfig {
  scope: string;
  patterns: Record<string, string[]>;
}

const MAX_EXTENDS = 10;

/** Tolerant single-string field extraction ("extends", "baseUrl") from JSONC-ish tsconfig text. */
function stringField(cfg: string, field: string): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`).exec(cfg);
  return m ? m[1]! : null;
}

/**
 * Extract `paths` as `{ pattern: [targets...] }`, brace-balanced (tsconfig may
 * contain comments; `paths` values are flat string arrays so balancing suffices).
 */
function pathsOf(cfg: string): Record<string, string[]> | null {
  const open = /"paths"\s*:\s*\{/.exec(cfg);
  if (!open) return null;
  let depth = 0;
  let end = -1;
  for (let i = open.index + open[0].length - 1; i < cfg.length; i++) {
    if (cfg[i] === '{') depth++;
    else if (cfg[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = cfg.slice(open.index + open[0].length, end);
  const patterns: Record<string, string[]> = {};
  for (const m of body.matchAll(/"([^"]+\*?)"\s*:\s*\[([^\]]*)\]/g)) {
    const targets = [...m[2]!.matchAll(/"([^"]+)"/g)].map((t) => t[1]!);
    if (targets.length) patterns[m[1]!] = targets;
  }
  return Object.keys(patterns).length ? patterns : null;
}

interface RawConfig {
  paths: Record<string, string[]> | null;
  pathsDir: string; // dir (repo-relative) of the config that defined paths
  baseUrlDir: string | null; // dir of the config that defined baseUrl (absolute-resolved later)
  dir: string; // dir of this config file
}

/**
 * Read one tsconfig, following `extends` upward (child wins per field, as in
 * TypeScript). Relative extends targets resolve against the extending file's
 * directory; npm-package extends targets are skipped (tolerated, not followed).
 */
function readConfigChain(root: string, relPath: string): RawConfig | null {
  const seen = new Set<string>();
  let cur = relPath;
  let base: RawConfig | null = null;
  for (let i = 0; i < MAX_EXTENDS && cur; i++) {
    if (seen.has(cur)) break; // extends cycle
    seen.add(cur);
    let cfg: string;
    try {
      cfg = fs.readFileSync(path.join(root, cur), 'utf8');
    } catch {
      break;
    }
    const dir = path.posix.dirname(cur);
    if (!base) base = { paths: null, pathsDir: dir, baseUrlDir: null, dir };
    if (base.paths === null) {
      const p = pathsOf(cfg);
      if (p) {
        base.paths = p;
        base.pathsDir = dir;
      }
    }
    if (base.baseUrlDir === null) {
      const b = stringField(cfg, 'baseUrl');
      if (b) base.baseUrlDir = path.posix.normalize(path.posix.join(dir, b));
    }
    const ext = stringField(cfg, 'extends');
    if (!ext || ext.startsWith('@')) break; // missing or npm-package extends: stop
    cur = path.posix.normalize(path.posix.join(dir, ext));
    if (!cur.endsWith('.json')) cur += '.json';
  }
  return base;
}

/** Find every tsconfig*.json in the repo (ignored dirs and dotdirs skipped). */
function findTsconfigs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && /^tsconfig[^/]*\.json$/.test(e.name)) {
        out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(root, 0);
  // at equal scope, tsconfig.json outranks tsconfig.*.json (base configs are
  // meant to be overridden); sort key keeps that deterministic
  const rank = (rel: string): number => {
    const base = path.posix.basename(rel);
    return base === 'tsconfig.json' ? 0 : base === 'tsconfig.base.json' ? 1 : 2;
  };
  return out.sort((a, b) => path.posix.dirname(a).length - path.posix.dirname(b).length || rank(a) - rank(b) || a.localeCompare(b));
}

const toRepoRel = (dir: string, target: string): string => {
  const joined = target.startsWith('/') ? target : path.posix.join(dir, target);
  return path.posix.normalize(joined).replace(/^\.\//, '');
};

/**
 * All alias definitions in the repo. One entry per tsconfig that defines
 * `paths`; configs at the same scope merge (first definition wins per pattern).
 */
export function loadAliasConfigs(root: string): AliasConfig[] {
  const byScope = new Map<string, AliasConfig>();
  for (const rel of findTsconfigs(root)) {
    const chain = readConfigChain(root, rel);
    if (!chain?.paths) continue;
    const baseDir = chain.baseUrlDir ?? chain.pathsDir;
    const patterns: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(chain.paths)) {
      patterns[pattern] = targets.map((t) => toRepoRel(baseDir, t));
    }
    const existing = byScope.get(chain.pathsDir);
    if (existing) {
      for (const [p, t] of Object.entries(patterns)) {
        if (existing.patterns[p] === undefined) existing.patterns[p] = t;
      }
    } else {
      const scope = chain.pathsDir === '.' ? '' : chain.pathsDir;
      byScope.set(chain.pathsDir, { scope, patterns });
    }
  }
  return [...byScope.values()].sort((a, b) => b.scope.length - a.scope.length);
}

/** Specifier prefixes that can never be npm packages: failed aliases in disguise. */
const NON_NPM_PREFIXES = ['@/', '~/', '#'];

function aliasMatches(pattern: string, spec: string): boolean {
  if (pattern.endsWith('*')) return spec.startsWith(pattern.slice(0, -1));
  return spec === pattern;
}

/**
 * Resolve aliases applicable to `fromFile` (deepest tsconfig scope first).
 * `claimed` is true when some applicable tsconfig had a matching pattern —
 * even when no target exists on disk. A claimed-but-unresolved specifier is an
 * alias failure, never an npm package.
 */
function resolveAlias(
  fromFile: string,
  spec: string,
  root: string,
  configs: AliasConfig[],
): { target: string | null; claimed: boolean } {
  const fromDir = path.posix.dirname(fromFile) === '.' ? '' : path.posix.dirname(fromFile);
  for (const cfg of configs) {
    if (cfg.scope && fromDir !== cfg.scope && !fromDir.startsWith(cfg.scope + '/')) continue;
    for (const [pattern, targets] of Object.entries(cfg.patterns)) {
      if (!aliasMatches(pattern, spec)) continue;
      const prefix = pattern.replace(/\*$/, '');
      const rest = pattern.endsWith('*')
        ? spec.slice(prefix.length)
        : '';
      for (const target of targets) {
        const base = path.posix.normalize(path.posix.join(target.replace(/\*$/, ''), rest));
        const resolved = resolveAsFile(root, base) ?? resolveAsDirIndex(root, base);
        if (resolved) return { target: resolved, claimed: true };
      }
      return { target: null, claimed: true }; // nearest tsconfig claimed it and missed
    }
  }
  return { target: null, claimed: false };
}

/**
 * Split a bare specifier into its package part and subpath:
 * `@scope/name/deep/x` -> base `@scope/name`, rest `deep/x`.
 * The split is positional, so a scope and a name of differing lengths cannot
 * shift it.
 */
function splitSpec(spec: string): { base: string; rest: string } {
  const m = /^(@[^/]+\/[^/]+|[^./][^/]*)(?:\/(.*))?$/.exec(spec);
  if (!m) return { base: spec, rest: '' };
  return { base: m[1]!, rest: m[2] ?? '' };
}

/* ------------------------------------------------------------------ */
/* workspace package discovery                                         */
/* ------------------------------------------------------------------ */

/** Declared package name -> repo-relative dir, plus the workspace root dirs. */
export interface WorkspaceMap {
  byName: Map<string, string>;
  roots: string[];
}

/** Used when the repo declares no workspaces: the conventional monorepo layout. */
const DEFAULT_WORKSPACE_GLOBS = ['packages/*', 'apps/*'];
const MAX_GLOB_DEPTH = 6;

function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Workspace patterns the repo declares: pnpm-workspace.yaml `packages:` or
 * package.json `workspaces` (array or `{ packages: [...] }`). Falls back to
 * the conventional layout so a repo declaring neither still resolves.
 */
function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  try {
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const key = /^packages:\s*$/m.exec(yaml);
    if (key) {
      for (const line of yaml.slice(key.index + key[0].length).split('\n')) {
        const item = /^\s*-\s*(.+?)\s*$/.exec(line);
        if (item) globs.push(unquote(item[1]!));
        else if (line.trim() && !/^\s/.test(line)) break; // next top-level key
      }
    }
  } catch {
    /* no pnpm-workspace.yaml */
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (ws) globs.push(...ws.filter((w) => typeof w === 'string'));
  } catch {
    /* no package.json, or no workspaces field */
  }
  return globs.length ? globs : DEFAULT_WORKSPACE_GLOBS;
}

/** Expand one workspace glob to repo-relative dirs holding a package.json. */
function expandGlob(root: string, pattern: string): string[] {
  const segments = path.posix.normalize(pattern).split('/').filter((s) => s && s !== '.');
  const out: string[] = [];
  const walk = (dir: string, i: number, depth: number): void => {
    if (depth > MAX_GLOB_DEPTH) return;
    if (i === segments.length) {
      if (existsRel(root, path.posix.join(dir, 'package.json'))) out.push(dir);
      return;
    }
    const seg = segments[i]!;
    if (seg !== '*' && seg !== '**') {
      walk(path.posix.join(dir, seg), i + 1, depth + 1);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const next = path.posix.join(dir, e.name);
      walk(next, i + 1, depth + 1);
      if (seg === '**') walk(next, i, depth + 1); // ** also spans deeper levels
    }
  };
  walk('', 0, 0);
  return out;
}

/**
 * Every workspace package in the repo, keyed by the name it declares in its
 * package.json — so a package resolves from wherever it lives (apps/, tools/,
 * a nested dir), not only from a hardcoded `packages/`.
 */
export function loadWorkspacePackages(root: string): WorkspaceMap {
  const byName = new Map<string, string>();
  const roots = new Set<string>();
  for (const glob of workspaceGlobs(root)) {
    const first = glob.split('/')[0];
    if (first && first !== '*' && first !== '**') roots.add(first);
    for (const dir of expandGlob(root, glob)) {
      try {
        const raw = fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8');
        const name = (JSON.parse(raw) as { name?: string }).name;
        if (name && !byName.has(name)) byName.set(name, dir);
      } catch {
        /* unreadable or non-JSON package.json */
      }
    }
  }
  return { byName, roots: [...roots] };
}

/**
 * Resolve one import specifier.
 * Order: relative -> tsconfig alias -> workspace package -> npm package.
 * A matched-but-unresolvable alias is NOT npm: it returns pkg=null so it stays
 * visible as (unresolved:...) — a visible unknown beats a confident mislabel.
 */
export function resolveImport(
  fromFile: string,
  spec: string,
  root: string,
  aliases: AliasConfig[],
  workspaces?: WorkspaceMap,
): { target: string | null; pkg: string | null } {
  if (spec.startsWith('.')) {
    return { target: resolveRelative(fromFile, spec, root), pkg: null };
  }

  const aliased = resolveAlias(fromFile, spec, root, aliases);
  if (aliased.target) return { target: aliased.target, pkg: null };
  if (aliased.claimed || NON_NPM_PREFIXES.some((p) => spec.startsWith(p))) {
    return { target: null, pkg: null };
  }

  const ws = workspaces ?? loadWorkspacePackages(root);
  const { base, rest: subpath } = splitSpec(spec);

  // the package this specifier names, by its declared name (longest match wins,
  // so a deep import into a package never loses to a shorter sibling)
  let pkgDir = ws.byName.get(base) ?? null;
  let rest = pkgDir ? subpath : '';
  if (!pkgDir) {
    let best = '';
    for (const name of ws.byName.keys()) {
      if ((spec === name || spec.startsWith(name + '/')) && name.length > best.length) best = name;
    }
    if (best) {
      pkgDir = ws.byName.get(best)!;
      rest = spec.slice(best.length).replace(/^\//, '');
    }
  }
  // a dir named like the package but declaring no matching name still counts
  if (!pkgDir) {
    const short = base.includes('/') ? base.slice(base.indexOf('/') + 1) : base;
    for (const wsRoot of ws.roots) {
      if (fs.existsSync(path.join(root, wsRoot, short))) {
        pkgDir = `${wsRoot}/${short}`;
        rest = subpath;
        break;
      }
    }
  }
  if (!pkgDir) return { target: null, pkg: spec };

  if (rest) {
    const deepBase = path.posix.normalize(`${pkgDir}/${rest}`);
    const deep =
      resolveAsFile(root, deepBase) ??
      resolveAsDirIndex(root, deepBase) ??
      resolveAsFile(root, `${pkgDir}/src/${rest}`) ??
      resolveAsDirIndex(root, `${pkgDir}/src/${rest}`);
    if (deep) return { target: deep, pkg: null };
  }
  const idx = resolveAsDirIndex(root, `${pkgDir}/src`) ?? resolveAsDirIndex(root, pkgDir);
  return { target: idx ?? pkgDir, pkg: null };
}

/** Turn raw import rows into edges (file->file, file->npm:<pkg>, unresolved kept visible). */
export function buildEdges(imports: ImportRow[], root: string, aliases: AliasConfig[]): Edge[] {
  const workspaces = loadWorkspacePackages(root); // one disk scan per rebuild, not per import
  const edges: Edge[] = [];
  for (const imp of imports) {
    const { target, pkg } = resolveImport(imp.file, imp.source, root, aliases, workspaces);
    if (target) {
      edges.push({ from: imp.file, to: target, names: imp.names, kind: imp.kind, line: imp.line });
    } else if (pkg) {
      edges.push({ from: imp.file, to: `npm:${pkg}`, names: imp.names, kind: imp.kind, line: imp.line });
    } else {
      edges.push({ from: imp.file, to: `(unresolved:${imp.source})`, names: imp.names, kind: imp.kind, line: imp.line });
    }
  }
  return edges;
}