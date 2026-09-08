# Hebros MCP — design notes

The README sells the tool; this file records how it works and why.

## Architecture

```
scan (git ls-files / fs walk, ignored dirs filtered)
  → parse (tree-sitter grammars via web-tree-sitter, WASM, vendored binaries)
  → analyze (symbols / imports / calls / name uses per file)
  → resolve (import specifiers → repo files or npm:<pkg>)
  → index (one JSON document, atomic write)
```

Single pass over each file; nothing is re-parsed per query. All tools are
in-memory lookups over the index.

## Index format

Deliberately **not SQLite**: plain JSON, loads in milliseconds, zero native
dependencies, trivially inspectable. Expect roughly 10× the source size at
parse time (a 6 MB source tree → ~60 MB JSON in memory, ~6 MB on disk). Fine
into the low thousands of files; revisit (binary format / SQLite) beyond that.

```jsonc
{
  "meta": { "root": "<realpath>", "builtAt": "...", "headSha": "...", "statusHash": "...", "schemaVersion": 3 },
  "files": { "src/foo.ts": { "loc": 210, "bytes": 6400 } },
  "symbols": [ { "file": "src/foo.ts", "name": "buildEdges", "kind": "function",
                 "line": 292, "endLine": 292, "sig": "export function buildEdges(...)",
                 "exported": 1, "isDefault": 0, "isStatic": 0, "container": null } ],
  "imports": [ { "file": "src/foo.ts", "source": "./bar.js", "names": ["x"], "line": 3, "kind": "import" } ],
  "calls":   [ { "file": "src/foo.ts", "line": 106, "callee": "resolveImport", "container": "buildEdges", "kind": "call" } ],
  "nameUses":[ { "file": "src/reg.ts", "line": 24, "name": "computer_observe", "kind": "key", "container": null } ]
}
```

`SCHEMA_VERSION` in `src/types.ts` is stamped on every save; `loadIndex`
discards caches with a different version.

## Cache lives outside the repo

```
~/.cache/hebros/<sha1(realpath of repo)>/index.json
```

- the repo stays untouched (no `.hebros/`, no `.gitignore` edits, no untracked
  noise in `git status`);
- one server instance can serve multiple repos, each with its own index;
- writes are atomic (temp + rename); `HEBROS_CACHE` overrides the location.

`meta.root` stores the realpath and is the single source of truth tools use to
resolve import edges — a server started from a different directory still
resolves against the right root.

## Freshness: git-based incremental refresh

No mtime walking. Two git commands answer "what changed":

1. The index stores the `HEAD` sha it was built from. On refresh,
   `git diff --name-only -z <old> HEAD` gives files changed by commits
   (A/M/D/R handled; renames drop the old entry, parse the new).
2. `git status --porcelain -z` is always consulted for uncommitted edits and
   untracked files (a plain `git diff` misses untracked). Its output is hashed
   (plus size+mtime per file) and stored; unchanged hash → no-op refresh.
3. Not a git repo / no commits → full rebuild.
4. **History rewrite** (amend/rebase/filter-branch): the stored HEAD SHA becomes
   unreachable, so the base commit is verified first (`git cat-file -e
   sha^{commit}`); when unreachable — or when the diff fails for any reason —
   the refresh falls back to a full build instead of silently keeping stale
   symbols.
5. Deleted untracked files leave no porcelain trace → the file list is synced
   against disk.

Typical refresh: two git calls + re-parse of a handful of files, well under
100 ms.

## Import resolution

Order: relative → tsconfig `paths` alias → workspace package (`packages/<name>`)
→ npm package. Details:

- `.js`/`.jsx` specifiers are tried as `.ts`/`.tsx` on disk (TS ESM style).
- Every `tsconfig*.json` in the repo is discovered (ignored dirs skipped);
  `extends` chains are followed (child wins per field); alias targets resolve
  relative to the config that defined them (`baseUrl` honored); a root-level
  config applies repo-wide, nested configs only under their directory.
- A specifier that matches a `paths` pattern but has no target on disk is
  reported as `(unresolved:…)` — never as an npm package. `@/`, `~/` and `#`
  prefixes can never be npm either. A visible unknown beats a confident mislabel.

## Analyzer

Two-pass tree-sitter walk per file:

1. top-level export statements → exported-name set, default flag, re-export imports;
2. full walk → symbols (top-level + class/interface members + enum members),
   call rows (calls, `new`, dotted method calls, JSX component usages),
   dynamic imports recorded as import rows, and name-use rows.

Name-use rows cover the places a name is written but never called: a key-like
string literal, an object key, a property read. That is how registries, event
names and route tables are wired, and callee matching cannot see any of it — a
dispatcher keyed by `"computer_observe"` used to return nothing but the import.
A name is recorded only when it reads like an identifier or a path (no spaces,
64 chars max), so prose stays out; module specifiers are skipped because
imports already index them, and a method call's callee is skipped because the
call row already has it — without that, every `arr.map()` would be stored twice
and real reads would sit under thousands of `.length` rows.

Cost on a 258-file monorepo: index 1.70 MB → 2.77 MB, 12.8k name-use rows.

Nested function declarations are not symbols (they'd flood the map) but their
bodies are walked so call rows survive. Anonymous default exports
(`export default () => …`) get an indexed default symbol so a file whose only
export is a default component is not reported as "no symbols".

## Tool output discipline

- Hard cap 6000 chars; builders degrade before a soft limit.
- Degradation is explicit and structured: a huge directory map becomes a
  per-subdirectory summary ordered by symbol count with drill-down hints; a
  huge file hides non-exported symbols first; a hot symbol in `get_references`
  collapses to per-file groups with sample lines. Never silent alphabetical
  truncation.
- Tool descriptions tell the model *when to prefer each tool over built-in
  glob/grep/read* — an MCP tool that duplicates built-ins gets ignored.

## Why unprefixed tool names

Clients namespace by server already (`mcp__hebros__get_map` in Claude Code), so
a `hebros_` prefix inside the name only duplicates itself in every schema.

## Vendored grammars

`vendor/tree-sitter/` holds the two prebuilt grammar binaries from
tree-sitter-typescript v0.23.2 (2.8 MB, MIT) instead of depending on the 37 MB
npm package (native build script, prebuilds for only six platforms — Alpine or
unusual arches would otherwise compile C at install time). License notice
included next to the files.

## Benchmark history

Measured on a real 223-file monorepo (M-series Mac): full build ~215–386 ms,
no-op refresh ~25 ms, every tool query under ~45 ms (two git subprocesses
dominate; the query math itself is 1–5 ms). Schema cost via a real MCP client:
5 tools ≈ 700 tokens of `tools/list` payload (the earlier 9-tool prefixed
schema was ~1.4k).

Output size per query, measured on a 324-file TS monorepo (230 files over 400 B;
ratios are output bytes, which track tokens closely for this kind of text):

- `get_map <file>` vs reading the file — median 3.3x smaller (3.5x on this repo);
  in aggregate 1026 KB of source against 204 KB of maps.
- `find_symbol` vs `grep -rn` for the same name — 2x for a unique name
  (`createRpcClient`), 37x for a widely used one (`useAppStore`, 40 call sites).
- `get_map "."` vs a bare file listing — 365 B against 13 KB, and the map carries
  symbol names the listing does not.

The ratio inverts on small repos: with ~20 files the directory map is larger than
`ls`, and the value is precision (an exact `file:line`) rather than volume.

Still open: tokens & wall-clock end-to-end over a fixed task list with vs without
Hebros. The numbers above are per-query output size, not task-level savings —
they do not account for how many queries an agent makes to finish a job.

## History

- v0.1 — TS/TSX server, git refresh, verified on a real monorepo.
- v0.2 — 9 tools, graceful degradation, test suite, `-z` porcelain safety.
- v0.2.1 — symbol end-line spans, schema guard, in-process cache, CLI.
- v0.3 — trimmed to 5 unprefixed tools; vendored grammars; four bug fixes
  (nested-function calls, history-rewrite fallback, realpath root, anonymous
  default exports); renamed to `hebros`, published as `hebros-mcp`.
- v0.3.1 — workspace packages resolve by declared name, from the repo's own
  workspace globs, so a package outside `packages/` is an internal edge.