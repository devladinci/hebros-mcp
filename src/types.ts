/** Row shapes shared by the analyzer, the index store and the MCP tools. */

export type SymbolKind =
  | 'class'
  | 'abstract class'
  | 'function'
  | 'const'
  | 'interface'
  | 'type'
  | 'enum'
  | 'enum member'
  | 'method'
  | 'property';

export interface SymbolRow {
  file: string; // repo-relative, posix separators
  name: string;
  kind: SymbolKind;
  line: number; // 1-based, first line of the declaration
  endLine: number; // 1-based, last line of the declaration (>= line)
  sig: string; // one-line signature preview (no body)
  exported: 0 | 1;
  isDefault: 0 | 1;
  isStatic: 0 | 1;
  container: string | null; // enclosing class/interface/function
}

export type ImportKind = 'import' | 'dynamic' | 'reexport';

export interface ImportRow {
  file: string; // repo-relative of the importing file
  source: string; // raw module specifier as written
  names: string[]; // names bound by this import; may contain '(side-effect)', '*', '(dynamic)'
  line: number;
  kind: ImportKind;
}

export interface CallRow {
  file: string;
  line: number;
  callee: string; // dotted callee as written, e.g. "fs.readFileSync" — or a JSX component tag
  container: string | null; // enclosing function/method
  kind: 'call' | 'new' | 'method' | 'jsx';
}

/**
 * A place where a name is written but never called: a key-like string literal
 * ("computer_observe"), an object key (`computer_observe: Camera`) or a property
 * access (`TOOL_ICONS.computer_observe`). This is how registries, event names
 * and route tables wire things together, and callee matching cannot see it.
 */
export interface NameUseRow {
  file: string;
  line: number;
  name: string; // literal contents / key / property, quotes stripped
  kind: 'string' | 'key' | 'property';
  container: string | null; // enclosing function/method
}

export interface IndexMeta {
  root: string; // realpath of the indexed repo
  builtAt: string; // ISO timestamp
  durationMs: number; // duration of the last (re)build
  headSha: string | null; // git HEAD at build time (null when not a git repo)
  statusHash: string | null; // fingerprint of `git status --porcelain` ('clean' when empty; null when no git)
  schemaVersion?: number; // bump when the row shape changes (old caches are discarded)
}

export interface IndexData {
  meta: IndexMeta;
  files: Record<string, { loc: number; bytes: number }>;
  symbols: SymbolRow[];
  imports: ImportRow[]; // raw, unresolved specifiers
  calls: CallRow[];
  nameUses: NameUseRow[];
}

/** Current index schema; older cached indexes are discarded and rebuilt. */
export const SCHEMA_VERSION = 4; // v4: name uses indexed (strings, object keys, property access)

/** Import edge with the module specifier resolved to a real file/dir/npm package. */
export interface Edge {
  from: string;
  to: string; // repo-relative file/dir, 'npm:<pkg>' or '(unresolved:<spec>)'
  names: string[];
  kind: ImportKind;
  line: number;
}