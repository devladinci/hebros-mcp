import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { Ctx, getMap, getDeps, findSymbol, getReferences } from '../../src/tools.js';
import type { IndexData } from '../../src/types.js';
import { makeRepo, standardFiles, cleanup } from '../testutil.js';

after(cleanup);

const SYMBOLS: IndexData['symbols'] = [
  { file: 'src/a.ts', name: 'alpha', kind: 'function', line: 1, endLine: 1, sig: 'export function alpha(): void', exported: 1, isDefault: 0, isStatic: 0, container: null },
  { file: 'src/b.ts', name: 'beta', kind: 'function', line: 5, endLine: 8, sig: 'function beta(): void', exported: 0, isDefault: 0, isStatic: 0, container: null },
  { file: 'src/deep/c.ts', name: 'gamma', kind: 'class', line: 10, endLine: 10, sig: 'export class gamma', exported: 1, isDefault: 0, isStatic: 0, container: null },
];

const IMPORTS: IndexData['imports'] = [
  { file: 'src/b.ts', source: './a.js', names: ['alpha'], line: 1, kind: 'import' },
  { file: 'src/deep/c.ts', source: 'lodash', names: ['(side-effect)'], line: 1, kind: 'import' },
  { file: 'src/d.ts', source: './deep/c.js', names: ['gamma'], line: 1, kind: 'import' },
];

const CALLS: IndexData['calls'] = [
  { file: 'src/b.ts', line: 7, callee: 'alpha', container: 'beta', kind: 'call' },
  { file: 'src/b.ts', line: 8, callee: 'console.log', container: 'beta', kind: 'method' },
];

// Edges resolve against a real filesystem, so synthetic Ctx data needs a real
// fixture repo containing the files referenced by IMPORTS/SYMBOLS.
const fixtureRoot = makeRepo({
  'src/a.ts': 'export function alpha(): void {}\n',
  'src/b.ts': 'import { alpha } from "./a.js";\nexport function beta(): void { alpha(); }\n',
  'src/deep/c.ts': 'import lodash from "lodash";\nexport class gamma {}\n',
  'src/d.ts': 'import { gamma } from "./deep/c.js";\n',
});

function ctxWithData(files: Record<string, { loc: number; bytes: number }>): Ctx {
  return new Ctx(fixtureRoot, {
    meta: { root: fixtureRoot, builtAt: new Date().toISOString(), durationMs: 5, headSha: null, statusHash: 'clean' },
    files,
    symbols: SYMBOLS,
    imports: IMPORTS,
    calls: CALLS,
  });
}

describe('getMap: file mode', () => {
  it('lists symbols with flags and signatures', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 20, bytes: 400 } });
    const out = getMap(ctx, 'src/a.ts');
    assert.match(out, /src\/a\.ts \(20 loc\)/);
    assert.match(out, /L1 \+ function alpha: export function alpha\(\): void/);
  });

  it('file mode folds in the import neighborhood (get_area)', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 10, bytes: 100 }, 'src/b.ts': { loc: 10, bytes: 100 } });
    const out = getMap(ctx, 'src/a.ts');
    assert.match(out, /imported by \(1\)/);
    assert.match(out, /<- src\/b\.ts \[alpha\]/);
  });

  it('unknown file with no data -> helpful message', () => {
    const ctx = ctxWithData({});
    assert.match(getMap(ctx, 'nope.ts'), /no symbols|no indexed files/);
  });
});

describe('getMap: directory mode', () => {
  it('lists files with top-level symbols', () => {
    const ctx = ctxWithData({
      'src/a.ts': { loc: 10, bytes: 100 },
      'src/b.ts': { loc: 10, bytes: 100 },
      'src/deep/c.ts': { loc: 10, bytes: 100 },
    });
    const out = getMap(ctx, 'src');
    assert.match(out, /src\/a\.ts/);
    assert.match(out, /L1 \+ function alpha/);
    assert.match(out, /src\/deep\/c\.ts/);
  });

  it('"." covers the whole repo', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 10, bytes: 100 } });
    assert.match(getMap(ctx, '.'), /src\/a\.ts/);
  });

  it('hides methods/properties in directory view', () => {
    const ctx = new Ctx('/repo', {
      meta: { root: '/repo', builtAt: new Date().toISOString(), durationMs: 5, headSha: null, statusHash: 'clean' },
      files: { 'src/a.ts': { loc: 10, bytes: 100 } },
      symbols: [
        { ...SYMBOLS[0]!, kind: 'class', name: 'K', exported: 1 },
        { file: 'src/a.ts', name: 'method1', kind: 'method', line: 2, endLine: 2, sig: 'm()', exported: 0, isDefault: 0, isStatic: 0, container: 'K' },
      ],
      imports: [],
      calls: [],
    });
    const out = getMap(ctx, '.');
    assert.match(out, /class K/);
    assert.ok(!out.includes('method1'));
  });
});

describe('getDeps', () => {
  it('file mode: in/out edges', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 10, bytes: 100 }, 'src/b.ts': { loc: 10, bytes: 100 } });
    const out = getDeps(ctx, 'src/a.ts', 'both');
    assert.match(out, /L1 <- src\/b\.ts \[alpha\]/);
  });

  it('directory mode: aggregates importers with file counts', () => {
    // d.ts imports from deep/c.ts -> one incoming edge to src/deep from outside
    const ctx = ctxWithData({
      'src/a.ts': { loc: 10, bytes: 100 },
      'src/b.ts': { loc: 10, bytes: 100 },
      'src/deep/c.ts': { loc: 10, bytes: 100 },
      'src/d.ts': { loc: 10, bytes: 100 },
    });
    const out = getDeps(ctx, 'src/deep', 'in');
    assert.match(out, /incoming to src\/deep \(1 files\)/);
    assert.match(out, /1 <- src\/d\.ts/);
  });

  it('directory mode: outgoing excludes intra-dir edges', () => {
    const ctx = ctxWithData({
      'src/a.ts': { loc: 10, bytes: 100 },
      'src/b.ts': { loc: 10, bytes: 100 },
      'src/deep/c.ts': { loc: 10, bytes: 100 },
    });
    const out = getDeps(ctx, 'src', 'out');
    assert.ok(!out.includes('src/a.ts\n'), 'b->a is intra-dir and must not appear');
    assert.match(out, /\(none\)|npm|deep/, `got: ${out}`);
  });
});

describe('findSymbol', () => {
  it('exact match beats fuzzy', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 10, bytes: 100 } });
    const out = findSymbol(ctx, 'alpha');
    assert.match(out, /exact matches \(1\)/);
    assert.match(out, /src\/a\.ts:1/);
  });

  it('fuzzy fallback with filter summary', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 10, bytes: 100 } });
    const out = findSymbol(ctx, 'alph');
    assert.match(out, /fuzzy matches \(1\)/);
  });

  it('exportedOnly filters private symbols', () => {
    const ctx = ctxWithData({ 'src/b.ts': { loc: 10, bytes: 100 } });
    // beta exists but is private -> excluded when exportedOnly
    assert.match(findSymbol(ctx, 'beta', undefined, { exportedOnly: true }), /no symbol matching "beta" \(exported only\)/);
    assert.match(findSymbol(ctx, 'beta'), /src\/b\.ts:5/);
  });

  it('fileGlob restricts results', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 10, bytes: 100 }, 'src/deep/c.ts': { loc: 10, bytes: 100 } });
    // 'alpha' only exists in src/a.ts -> excluded by the deep glob
    const out = findSymbol(ctx, 'alpha', undefined, { fileGlob: 'src/deep/**' });
    assert.match(out, /no symbol matching/);
    const out2 = findSymbol(ctx, 'gamma', undefined, { fileGlob: 'src/deep/**' });
    assert.match(out2, /src\/deep\/c\.ts:10/);
  });
});

describe('getReferences', () => {
  it('finds bare call sites and import sites', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 10, bytes: 100 }, 'src/b.ts': { loc: 10, bytes: 100 } });
    const out = getReferences(ctx, 'alpha');
    assert.match(out, /call sites of alpha \(1 in 1 file\(s\)\)/);
    assert.match(out, /src\/b\.ts \(1\)/);
    assert.match(out, /L7 beta -> alpha/);
    assert.match(out, /import sites \(1\)/);
    assert.match(out, /src\/b\.ts:1 <- src\/a\.ts/);
  });

  it('does not match partial names', () => {
    const ctx = ctxWithData({ 'src/a.ts': { loc: 10, bytes: 100 }, 'src/b.ts': { loc: 10, bytes: 100 } });
    const out = getReferences(ctx, 'alph');
    assert.match(out, /call sites of alph \(0 in 0 file\(s\)\)/);
  });

  it('hot symbols collapse per file instead of dumping every site', () => {
    const data: IndexData = {
      meta: { root: fixtureRoot, builtAt: new Date().toISOString(), durationMs: 5, headSha: null, statusHash: 'clean' },
      files: { 'src/a.ts': { loc: 10, bytes: 100 } },
      symbols: [],
      imports: [],
      calls: Array.from({ length: 80 }, (_, i) => ({ file: 'src/a.ts', line: i + 2, callee: 'useState', container: `c${i}`, kind: 'call' as const })),
    };
    const out = getReferences(new Ctx(fixtureRoot, data), 'useState');
    assert.match(out, /80 in 1 file\(s\)/);
    assert.equal((out.match(/-> useState/g) ?? []).length, 5, 'only 5 sample lines per file');
    assert.match(out, /\(\+75 more in this file\)/);
  });
});