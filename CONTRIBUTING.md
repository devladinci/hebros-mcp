# Contributing to Hebros MCP

Thanks for considering a contribution. Hebros is small on purpose — read the
design rules below before opening a PR.

## Setup

```bash
git clone https://github.com/devladinci/hebros-mcp.git
cd hebros-mcp
npm install
npm test                              # 89 unit + integration tests (node:test)
npm run smoke -- /path/to/any/ts-repo # end-to-end against a real repo
npm run bench -- /path/to/any/ts-repo # timings
```

Tests build throwaway git repos in the temp dir and use an isolated
`HEBROS_CACHE` — they never touch `~/.cache` or any real repo.

> **Why `npm test` passes `--no-maglev`.** On Node v23.11.1 the suite deadlocks
> inside V8 — a maglev compilation job parks on the GC collection barrier while
> the main thread sits idle — and the run hangs forever, printing nothing. It is
> a V8 bug, not a Hebros one, but a silent infinite hang is a miserable way to
> meet it, and it stalls `prepublishOnly` at release time too. The flag turns off
> that compiler tier and changes nothing about what the tests check. Drop it once
> the affected Node releases are behind us.

Bump `SCHEMA_VERSION` in `src/types.ts` whenever the index row shape changes;
`loadIndex` discards older caches automatically.

`npm run smoke` builds an index, runs an incremental refresh, and exercises the
query functions. `npm test` runs the unit + integration suite.

## Ground rules

1. **No new runtime dependencies** without strong justification. The point of
   Hebros is a small, fast, inspectable tool. TypeScript compiler + zod are
   the only build-time extras.
2. **Tool outputs are capped** (6000 chars). Any new tool must degrade
   gracefully (summarize / suggest narrowing) instead of truncating blindly —
   a truncated alphabetical list hides whole parts of a repo.
3. **The index cache stays out of user repos** (`~/.cache/hebros`). Never
   write anything into the indexed repo.
4. **No `any`, explicit interfaces, early returns, small single-purpose
   functions.** `tsc` strict must stay clean: `npm run build`.
5. **Tree-sitter field access is fragile.** If you touch `analyze.ts`, verify
   against a real repo with varied code — AST field names differ between
   grammar versions.
6. **Scope discipline:** v0.x is TypeScript/TSX only. Language adapters are
   welcome as separate discussion issues first.

## Good first contributions

- Bug reports with a minimal TS/TSX file that produces wrong symbols/edges.
- Improving tool `description` texts (they steer model tool-selection — the
  most underrated lever in the codebase).
- More granular degradation for huge repos in `get_map` summary mode.

## Commit style

Short imperative subject, no scope tags (`fix porcelain parsing`, not
`fix(refresh): ...`).