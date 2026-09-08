import fs from 'node:fs';
import path from 'node:path';
import { buildEdges, loadAliasConfigs, type AliasConfig } from './imports.js';
import { refreshIndex } from './refresh.js';
import { headSha, statusHash } from './gitinfo.js';
import type { Edge, IndexData, SymbolRow } from './types.js';

const MAX_OUTPUT = 6000; // hard cap per tool response, in characters
const SOFT_LIMIT = 5200; // builders degrade/summarize before this; header + hints fit inside the cap

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

const clip = (s: string): string => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…(truncated)' : s);

const rel = (root: string, p: string): string =>
  path.isAbsolute(p) ? path.relative(root, p).split(path.sep).join('/') : p;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Minimal glob -> RegExp: `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** One cache record per root: index + lazily-computed derivations, keyed by git state. */
interface RootRecord {
  key: string; // `${headSha}|${statusHash}` fingerprint
  data: IndexData;
  aliases?: AliasConfig[];
  edges?: Edge[];
}

const rootCache = new Map<string, RootRecord>();

const cachedState = async (root: string): Promise<string> => `${headSha(root) ?? '-'}|${statusHash(root) ?? '-'}`;

/** Everything a tool implementation needs; expensive lookups memoized per root record. */
export class Ctx {
  readonly root: string;
  readonly data: IndexData;
  private readonly rec: RootRecord;

  constructor(root: string, data: IndexData, rec?: RootRecord) {
    this.root = root;
    this.data = data;
    this.rec = rec ?? { key: '', data };
  }

  private get aliases(): AliasConfig[] {
    if (!this.rec.aliases) this.rec.aliases = loadAliasConfigs(this.data.meta.root);
    return this.rec.aliases;
  }

  /** Resolved import edges, memoized (the single most repeated computation). */
  get edges(): Edge[] {
    if (!this.rec.edges) {
      this.rec.edges = buildEdges(this.data.imports, this.data.meta.root, this.aliases);
    }
    return this.rec.edges;
  }

  resolve(target: string): string {
    return rel(this.root, target);
  }
}

const dirPrefix = (t: string): string => (t === '.' || t === '' ? '' : t.replace(/\/$/, '') + '/');
const underPrefix = (file: string, prefix: string): boolean => (prefix ? file.startsWith(prefix) : true);

/** Per-tool entry: refresh (cache-skipped when git state is unchanged), wrap in Ctx, prefix the index header. */
async function withCtx(root: string, fn: (ctx: Ctx) => string): Promise<string> {
  const hit = rootCache.get(root);
  const key = hit ? await cachedState(root) : null;
  let rec: RootRecord;
  let rebuilt: boolean;
  let note: string;
  if (hit && key !== null && hit.key === key) {
    rec = hit;
    rebuilt = false;
    note = 'cached';
  } else {
    const fresh = await refreshIndex(root);
    rec = { key: `${fresh.data.meta.headSha ?? '-'}|${fresh.data.meta.statusHash ?? '-'}`, data: fresh.data };
    rebuilt = fresh.rebuilt;
    note = fresh.note;
    rootCache.set(root, rec); // one entry per root; a new build supersedes any prior entry
    if (rootCache.size > 8) {
      const first = rootCache.keys().next().value;
      if (first !== undefined) rootCache.delete(first);
    }
  }
  const ctx = new Ctx(root, rec.data, rec);
  return clip(header(ctx, rebuilt, note) + fn(ctx));
}

function header(ctx: Ctx, rebuilt: boolean, note: string): string {
  const ageMs = Date.now() - new Date(ctx.data.meta.builtAt).getTime();
  const age = ageMs < 60_000 ? `${Math.max(1, Math.round(ageMs / 1000))}s`
    : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m`
    : `${Math.round(ageMs / 3_600_000)}h`;
  const tag = rebuilt ? ` [fresh build: ${note}]` : '';
  return `[hebros: ${Object.keys(ctx.data.files).length} files, index ${age} old${tag}]\n`;
}

/** Push a line, tracking emitted length; returns false when the budget is exhausted. */
class Budget {
  readonly lines: string[] = [];
  private used = 0;
  constructor(readonly max: number) {}
  push(line: string): boolean {
    const cost = line.length + 1;
    if (this.used + cost > this.max) return false;
    this.lines.push(line);
    this.used += cost;
    return true;
  }
  get remaining(): number {
    return this.max - this.used;
  }
  toString(): string {
    return this.lines.join('\n');
  }
}

/* ------------------------------------------------------------------ */
/* get_map — structure of a file (plus its imports/importers) or a dir */
/* ------------------------------------------------------------------ */

function symbolLine(s: SymbolRow): string {
  const flags = [s.exported ? '+' : '-', s.isDefault ? 'def' : '', s.isStatic ? 'static' : '']
    .filter(Boolean)
    .join(' ');
  const inContainer = s.container && s.kind !== 'property' && s.kind !== 'method' ? ` in ${s.container}` : '';
  const span = s.endLine > s.line ? `L${s.line}-${s.endLine}` : `L${s.line}`;
  return `${span} ${flags} ${s.kind} ${s.name}${inContainer}: ${s.sig}`;
}

function topSymbols(data: IndexData, file: string, exportedOnly: boolean): SymbolRow[] {
  return data.symbols
    .filter((s) => s.file === file && (!exportedOnly || s.exported === 1))
    .sort((a, b) => a.line - b.line);
}

function exportedTop(ctx: Ctx, file: string, n: number): string {
  const names = ctx.data.symbols
    .filter((s) => s.file === file && s.exported === 1 && !s.container)
    .sort((a, b) => a.line - b.line)
    .slice(0, n)
    .map((s) => s.name);
  return names.join(', ');
}

/** Import/importer rows for one file, within a character budget. */
function neighborhood(ctx: Ctx, f: string, budget: number): string {
  const out = ctx.edges.filter((e) => e.from === f);
  const inn = ctx.edges.filter((e) => e.to === f);
  if (!out.length && !inn.length) return '';

  const localOut = out.filter((e) => !e.to.startsWith('npm:'));
  const npmOut = [...new Set(out.filter((e) => e.to.startsWith('npm:')).map((e) => e.to.slice(4)))];

  const b = new Budget(budget);
  b.push(`imports (${out.length}):`);
  const outCap = 12;
  for (const e of localOut.slice(0, outCap)) {
    const tMeta = ctx.data.files[e.to];
    const tops = tMeta ? exportedTop(ctx, e.to, 3) : '';
    b.push(`  -> ${e.to}${tMeta ? ` (${tMeta.loc} loc)` : ''} [${e.names.slice(0, 4).join(', ')}]${tops ? ` — ${tops}` : ''}`);
  }
  if (localOut.length > outCap) b.push(`  …(+${localOut.length - outCap} more — get_deps("${f}", out))`);
  if (npmOut.length) b.push(`  npm: ${npmOut.slice(0, 10).join(', ')}${npmOut.length > 10 ? ', …' : ''}`);
  if (!out.length) b.push('  (none)');

  b.push(`imported by (${inn.length}):`);
  const inCap = 12;
  for (const e of inn.slice(0, inCap)) {
    b.push(`  <- ${e.from} [${e.names.slice(0, 4).join(', ')}]`);
  }
  if (inn.length > inCap) b.push(`  …(+${inn.length - inCap} more — get_deps("${f}", in))`);
  return b.toString();
}

function fileMap(ctx: Ctx, t: string): string {
  const meta = ctx.data.files[t]!;
  const head = `${t} (${meta.loc} loc)`;

  const render = (rows: SymbolRow[]): string => (rows.length ? rows.map(symbolLine).join('\n') : `${t}: no symbols`);
  const all = topSymbols(ctx.data, t, false);
  if (render(all).length <= SOFT_LIMIT) {
    const syms = render(all);
    // fold get_area in: the file's symbol table + what it imports + who imports it
    const hood = neighborhood(ctx, t, Math.max(400, SOFT_LIMIT - syms.length));
    return `${head}\n${syms}${hood ? `\n${hood}` : ''}`;
  }

  // too large: exported-only first, then fit as many lines as the budget allows
  const exported = topSymbols(ctx.data, t, true);
  const rows = render(exported).length <= SOFT_LIMIT ? exported : all;
  const b = new Budget(SOFT_LIMIT - head.length - 1);
  for (const s of rows) {
    if (!b.push(symbolLine(s))) break;
  }
  const shown = b.lines.length;
  const note = rows === exported && shown < all.length ? ' (non-exported hidden)' : '';
  const more = rows.length - shown;
  return `${head}${note}\n${b}${more > 0 ? `\n…(+${more} more symbols — narrow with find_symbol, or read the file)` : ''}`;
}

function dirMap(ctx: Ctx, t: string): string {
  const prefix = dirPrefix(t);
  const files = Object.keys(ctx.data.files).filter((f) => underPrefix(f, prefix)).sort();
  if (!files.length) return `${t}: no indexed files (is the path correct?)`;

  const byFile = new Map<string, SymbolRow[]>();
  for (const s of ctx.data.symbols) {
    if (!underPrefix(s.file, prefix)) continue;
    if (s.container && (s.kind === 'method' || s.kind === 'property' || s.kind === 'enum member')) continue;
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }

  const full = files
    .filter((f) => byFile.has(f))
    .map((f) => {
      const meta = ctx.data.files[f]!;
      const rows = byFile
        .get(f)!.sort((a, b) => a.line - b.line)
        .map((s) => `  ${s.endLine > s.line ? `L${s.line}-${s.endLine}` : `L${s.line}`} ${s.exported ? '+' : '-'} ${s.kind} ${s.name}`);
      return `${f} (${meta.loc} loc)\n${rows.join('\n')}`;
    })
    .join('\n');

  if (full.length <= SOFT_LIMIT) return full || `${t}: no symbols`;

  // Too large to list every file (alphabetical truncation would hide whole trees)
  // -> one summary line per first-level subdirectory, most symbols first.
  const groups = new Map<string, { files: number; syms: number; exported: string[] }>();
  for (const f of files) {
    const rest = prefix ? f.slice(prefix.length) : f;
    const top = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : '(top-level files)';
    const g = groups.get(top) ?? { files: 0, syms: 0, exported: [] };
    g.files++;
    for (const s of byFile.get(f) ?? []) {
      g.syms++;
      if (s.exported === 1 && !s.container && g.exported.length < 8) g.exported.push(s.name);
    }
    groups.set(top, g);
  }
  const b = new Budget(SOFT_LIMIT);
  const entries = [...groups.entries()].sort((a, b2) => b2[1].syms - a[1].syms);
  let hiddenGroups = 0;
  for (const [name, g] of entries) {
    if (!b.remaining) {
      hiddenGroups++;
      continue;
    }
    const shown = g.exported.slice(0, 6).join(', ');
    const dots = g.exported.length > 6 ? ', …' : '';
    const label = name === '(top-level files)' ? name : name + '/';
    b.push(`${label} ${g.files} files, ${g.syms} symbols: ${shown}${dots}`);
  }
  const more = hiddenGroups > 0 ? `\n…(+${hiddenGroups} more groups)` : '';
  return `${b}\n(summary mode — full listing too large. Drill down: get_map("${prefix || ''}<name>") per directory)${more}`;
}

export function getMap(ctx: Ctx, target: string): string {
  const t = ctx.resolve(target);
  if (ctx.data.files[t] !== undefined) return fileMap(ctx, t);
  return dirMap(ctx, t);
}

/* ------------------------------------------------------------------ */
/* get_deps — import edges of a file OR directory, in/out              */
/* ------------------------------------------------------------------ */

/** Aggregate edges -> distinct counterpart with the number of distinct source files. */
function countBy(edges: Edge[], keyOf: (e: Edge) => string): Array<[string, number]> {
  const m = new Map<string, Set<string>>();
  for (const e of edges) {
    const set = m.get(keyOf(e)) ?? new Set<string>();
    set.add(e.from);
    m.set(keyOf(e), set);
  }
  return [...m.entries()].sort((a, b) => b[1].size - a[1].size).map(([k, v]) => [k, v.size] as [string, number]);
}

function edgeGroups(title: string, rows: Array<[string, number]>, cap: number, arrow: string, narrowHint: string): string {
  const lines = [`${title} (${rows.length}):`];
  for (const [target, n] of rows.slice(0, cap)) {
    lines.push(`  ${String(n).padStart(3)} ${arrow} ${target}`);
  }
  const more = rows.length - cap;
  if (more > 0) lines.push(`  …(+${more} more — narrow with a subdirectory of ${narrowHint})`);
  if (!rows.length) lines.push('  (none)');
  return lines.join('\n');
}

function dirDeps(ctx: Ctx, dir: string, direction: 'in' | 'out' | 'both'): string {
  const prefix = dirPrefix(dir);
  const under = (p: string): boolean => underPrefix(p, prefix);
  const outEdges = ctx.edges.filter((e) => under(e.from) && !under(e.to));
  const inEdges = ctx.edges.filter((e) => under(e.to) && !under(e.from));
  const nFiles = Object.keys(ctx.data.files).filter((f) => under(f)).length;

  const parts: string[] = [];
  if (direction !== 'in') {
    parts.push(edgeGroups(`outgoing from ${dir} (${nFiles} files)`, countBy(outEdges, (e) => e.to), 25, '->', dir));
  }
  if (direction !== 'out') {
    parts.push(edgeGroups(`incoming to ${dir} (${nFiles} files)`, countBy(inEdges, (e) => e.from), 25, '<-', dir));
  }
  return parts.join('\n');
}

function fileDeps(ctx: Ctx, f: string, direction: 'in' | 'out' | 'both'): string {
  const out = ctx.edges.filter((e) => e.from === f);
  const inn = ctx.edges.filter((e) => e.to === f);
  const lines: string[] = [];

  if (direction !== 'in') {
    lines.push(`outgoing from ${f}:`);
    for (const e of out) lines.push(`  L${e.line} -> ${e.to} [${e.names.join(', ').slice(0, 100)}]`);
    if (!out.length) lines.push('  (none)');
  }
  if (direction !== 'out') {
    lines.push(`incoming to ${f}:`);
    for (const e of inn) lines.push(`  L${e.line} <- ${e.from} [${e.names.join(', ').slice(0, 100)}]`);
    if (!inn.length) lines.push('  (none)');
  }
  return lines.join('\n');
}

export function getDeps(ctx: Ctx, file: string, direction: 'in' | 'out' | 'both'): string {
  const f = ctx.resolve(file);
  if (ctx.data.files[f] === undefined) return dirDeps(ctx, f, direction);
  return fileDeps(ctx, f, direction);
}

/* ------------------------------------------------------------------ */
/* find_symbol — exact file:line for a name                            */
/* ------------------------------------------------------------------ */

export interface FindOptions {
  fileGlob?: string;
  exportedOnly?: boolean;
}

export function findSymbol(ctx: Ctx, name: string, kind?: string, opts?: FindOptions): string {
  const needle = name.toLowerCase();
  const globRe = opts?.fileGlob ? globToRegExp(opts.fileGlob) : null;
  const match = (s: SymbolRow): boolean =>
    (!kind || s.kind === kind) && (!globRe || globRe.test(s.file)) && (!opts?.exportedOnly || s.exported === 1);

  const hits = ctx.data.symbols.filter((s) => s.name.toLowerCase() === needle && match(s));
  // fuzzy fallback: whole word-parts (camelCase/snake segments) or a name-prefix
  // match, so "use" finds useState but not OSM_USER_AGENT or pausePomodoro
  const fuzzy = hits.length
    ? []
    : ctx.data.symbols.filter((s) => wordParts(s.name).includes(needle) || s.name.toLowerCase().startsWith(needle) && match(s));
  const rows = hits.length ? hits : fuzzy.filter(match);
  if (!rows.length) {
    const filters = [kind ? `kind ${kind}` : '', opts?.fileGlob ? `glob ${opts.fileGlob}` : '', opts?.exportedOnly ? 'exported only' : '']
      .filter(Boolean)
      .join(', ');
    return `no symbol matching "${name}"${filters ? ` (${filters})` : ''}`;
  }
  const label = hits.length ? 'exact matches' : 'fuzzy matches';
  const cap = 60;
  const lines = rows
    .slice(0, cap)
    .map((s) => {
      const span = s.endLine > s.line ? `${s.line}-${s.endLine}` : `${s.line}`;
      return `${s.file}:${span} ${s.exported ? '+' : '-'} ${s.kind} ${s.name}${s.container ? ` (in ${s.container})` : ''}: ${s.sig.slice(0, 70)}`;
    });
  const more = rows.length - cap;
  const tail = more > 0 ? `\n…(+${more} more — add file_glob or a more exact name)` : '';
  return `${label} (${rows.length}):\n${lines.join('\n')}${tail}\n(read the full definition with the file:line above)`;
}

/** Split an identifier into lowercase word parts: useState -> ["use","state"], OSM_USER_AGENT -> ["osm","user","agent"]. */
function wordParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* get_references — call sites + import sites of a name                */
/* ------------------------------------------------------------------ */

export function getReferences(ctx: Ctx, name: string, file?: string): string {
  const f = file ? ctx.resolve(file) : null;
  // callee is stored as written, no trailing parens ("obj.method", "fn") —
  // match the whole dotted path ending at the name, or as a chain prefix (fn().method)
  const re = new RegExp(`(^|\\.)${escapeRe(name)}(\\.|$)`);
  const callHits = ctx.data.calls.filter((c) => re.test(c.callee) && (!f || c.file === f));
  const importHits = ctx.edges.filter(
    (e) => e.names.includes(name) && (!f || e.from === f) && !e.to.startsWith('npm:') && !e.to.startsWith('(unresolved'),
  );

  // group per file with a per-file site cap — a hot hook called 80 times must
  // not print 80 nearly identical lines
  const byFile = new Map<string, { total: number; lines: string[] }>();
  for (const c of callHits) {
    const g = byFile.get(c.file) ?? { total: 0, lines: [] };
    g.total++;
    if (g.lines.length < 5) g.lines.push(`L${c.line}${c.container ? ` ${c.container}` : ''} -> ${c.callee}`);
    byFile.set(c.file, g);
  }

  const callCap = 20;
  const importCap = 40;
  const lines: string[] = [];
  lines.push(`call sites of ${name}${f ? ` in ${f}` : ''} (${callHits.length} in ${byFile.size} file(s)):`);
  for (const [file, g] of [...byFile.entries()].slice(0, callCap)) {
    lines.push(`  ${file} (${g.total}):`);
    for (const l of g.lines) lines.push(`    ${l}`);
    if (g.total > g.lines.length) lines.push(`    …(+${g.total - g.lines.length} more in this file)`);
  }
  if (byFile.size > callCap) lines.push(`  …(+${byFile.size - callCap} more files — restrict with file)`);
  if (!callHits.length) lines.push('  (none)');

  lines.push(`import sites (${importHits.length}):`);
  for (const e of importHits.slice(0, importCap)) {
    lines.push(`  ${e.from}:${e.line} <- ${e.to}`);
  }
  if (importHits.length > importCap) lines.push(`  …(+${importHits.length - importCap} more — restrict with file)`);
  if (!importHits.length) lines.push('  (none)');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* MCP entry points (async, own the refresh cycle)                     */
/* ------------------------------------------------------------------ */

export const toolGetMap = (root: string, target: string) => withCtx(root, (c) => getMap(c, target));

export const toolGetDeps = (root: string, file: string, direction: 'in' | 'out' | 'both') =>
  withCtx(root, (c) => getDeps(c, file, direction));

export const toolFindSymbol = (root: string, name: string, kind?: string, opts?: FindOptions) =>
  withCtx(root, (c) => findSymbol(c, name, kind, opts));

export const toolGetReferences = (root: string, name: string, file?: string) =>
  withCtx(root, (c) => getReferences(c, name, file));

export const toolReindex = async (root: string): Promise<string> => {
  rootCache.delete(root); // force a real refresh past the in-process cache
  const { data, note } = await refreshIndex(root);
  rootCache.set(root, { key: `${data.meta.headSha ?? '-'}|${data.meta.statusHash ?? '-'}`, data });
  return `index refreshed: ${note}\nfiles: ${Object.keys(data.files).length}, symbols: ${data.symbols.length}, imports: ${data.imports.length}, calls: ${data.calls.length}\nbuiltAt: ${data.meta.builtAt} (${data.meta.durationMs < 1000 ? data.meta.durationMs + 'ms' : Math.round(data.meta.durationMs / 100) / 10 + 's'})`;
};