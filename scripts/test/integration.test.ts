import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex, ensureIndex } from '../../src/builder.js';
import { refreshIndex } from '../../src/refresh.js';
import { saveIndex, loadIndex, indexFile, cacheDir } from '../../src/db.js';
import { getMap, getDeps, findSymbol, getReferences, Ctx } from '../../src/tools.js';
import { makeRepo, standardFiles, write, commitAll, isolatedCache, cleanup, git } from '../testutil.js';
import type { IndexData } from '../../src/types.js';

after(cleanup);

describe('integration: full lifecycle', () => {
  isolatedCache();
  const root = makeRepo(standardFiles());

  it('full build indexes all files with resolved edges', async () => {
    const { data, files } = await buildIndex(root);
    assert.equal(files, 4);
    assert.ok(data.symbols.length >= 8, `symbols: ${data.symbols.length}`);
    const ctx = new Ctx(root, data);
    const edge = ctx.edges.find((e) => e.from === 'src/api/service.ts' && e.to === 'src/util/math.ts');
    assert.ok(edge, 'relative .js import resolved');
    const aliasEdge = ctx.edges.find((e) => e.from === 'src/api/service.ts' && e.to === 'src/util/ops.ts');
    assert.ok(aliasEdge, 'tsconfig alias import resolved');
  });

  it('no-change refresh is a no-op', async () => {
    const before = fs.readFileSync(indexFile(root), 'utf8');
    const { note, rebuilt } = await refreshIndex(root);
    assert.equal(rebuilt, false);
    assert.match(note, /already fresh/);
    assert.equal(fs.readFileSync(indexFile(root), 'utf8'), before);
  });

  it('editing a tracked-but-uncommitted file triggers reparse of exactly 1 file', async () => {
    write(root, 'src/util/math.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n');
    const { note, data } = await refreshIndex(root);
    assert.match(note, /1 file\(s\) re-parsed/);
    assert.ok(data.symbols.some((s) => s.name === 'sub'), 'new symbol indexed');
  });

  it('new untracked file is picked up', async () => {
    write(root, 'src/util/extra.ts', 'export function extra(): number {\n  return 42;\n}\n');
    const { note, data } = await refreshIndex(root);
    assert.match(note, /re-parsed/);
    assert.ok(data.files['src/util/extra.ts'], 'untracked file indexed');
    assert.ok(data.symbols.some((s) => s.name === 'extra'));
  });

  it('deleting an untracked file drops it from the index', async () => {
    fs.unlinkSync(path.join(root, 'src/util/extra.ts'));
    const { note, data } = await refreshIndex(root);
    assert.match(note, /1 removed/);
    assert.equal(data.files['src/util/extra.ts'], undefined);
  });

  it('commit -> diff-based refresh sees the change', async () => {
    commitAll(root, 'math + sub');
    const shaBefore = loadIndex(root)!.meta.headSha;
    write(root, 'src/util/ops.ts', 'export function multiply(a: number, b: number): number {\n  return a * b;\n}\nexport function divide(a: number, b: number): number {\n  return a / b;\n}\n');
    commitAll(root, 'ops + divide');
    const { note, data } = await refreshIndex(root);
    assert.match(note, /re-parsed/);
    assert.notEqual(data.meta.headSha, shaBefore);
    assert.ok(data.symbols.some((s) => s.name === 'divide'));
  });

  it('renames drop the old file and index the new one', async () => {
    fs.renameSync(path.join(root, 'src/util/ops.ts'), path.join(root, 'src/util/ops2.ts'));
    commitAll(root, 'rename ops');
    const { data } = await refreshIndex(root);
    assert.equal(data.files['src/util/ops.ts'], undefined);
    assert.ok(data.files['src/util/ops2.ts']);
  });

  it('history rewrite (unreachable stored HEAD) triggers full rebuild, no stale symbols', async () => {
    write(root, 'src/util/gone.ts', 'export function goneAway(): number { return 1; }\n');
    commitAll(root, 'add gone');
    await refreshIndex(root); // index stores the sha of 'add gone'
    assert.ok(loadIndex(root)!.symbols.some((s) => s.name === 'goneAway'));

    // amend the SAME commit to remove the file, then make the stored sha
    // unreachable via reflog expire + gc prune
    fs.unlinkSync(path.join(root, 'src/util/gone.ts'));
    git(root, ['add', '-A']);
    git(root, ['commit', '--amend', '-q', '--allow-empty', '-m', 'add gone (amended: file removed)']);
    git(root, ['reflog', 'expire', '--expire=now', '--all']);
    git(root, ['gc', '--prune=now', '--quiet']);

    const { data, rebuilt, note } = await refreshIndex(root);
    assert.equal(rebuilt, true);
    assert.match(note, /unreachable|full rebuild/);
    assert.ok(!data.symbols.some((s) => s.name === 'goneAway'), 'stale symbol from discarded commit gone');
    assert.ok(data.symbols.some((s) => s.file === 'src/util/math.ts'), 'current tree indexed');
  });

  it('tools answer correctly against the live index', async () => {
    const data = await ensureIndex(root);
    const ctx = new Ctx(root, data);
    assert.match(getMap(ctx, 'src/util/math.ts'), /function sub/);
    assert.match(findSymbol(ctx, 'Calculator'), /src\/api\/service\.ts/);
    const refs = getReferences(ctx, 'add');
    assert.match(refs, /call sites of add/);
    assert.match(refs, /src\/api\/service\.ts/);
    assert.match(getDeps(ctx, 'src/api', 'out'), /src\/util/);
  });

  it('get_map of a big synthetic repo degrades to summary, not truncation', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) {
      files[`gen/mod${i}/code.ts`] = `export function fn${i}(): number { return ${i}; }\nexport const k${i} = ${i};\n`;
    }
    const root2 = makeRepo(files);
    const { data } = await buildIndex(root2);
    const ctx = new Ctx(root2, data);
    const out = getMap(ctx, '.');
    assert.ok(out.length <= 6000, `len ${out.length}`);
    assert.match(out, /summary mode/);
    assert.ok(!out.includes('…(truncated)'), 'must degrade, not clip');
  });

  it('corrupt index file -> next tool call rebuilds', async () => {
    fs.writeFileSync(indexFile(root), '{ not json');
    const data = await ensureIndex(root);
    assert.ok(Object.keys(data.files).length >= 4);
  });

  it('old-schema index (missing schemaVersion) is discarded and rebuilt', async () => {
    const data = loadIndex(root)!;
    const stale: IndexData = { ...data, meta: { ...data.meta, schemaVersion: undefined } };
    fs.writeFileSync(indexFile(root), JSON.stringify(stale));
    assert.equal(loadIndex(root), null, 'old schema must be rejected');
    const fresh = await ensureIndex(root);
    assert.ok(Object.keys(fresh.files).length >= 4, 'rebuild succeeds');
    assert.ok(fresh.symbols.every((s) => typeof s.endLine === 'number' && s.endLine >= s.line));
  });

  it('saveIndex is atomic-ish: tmp file does not linger', () => {
    const data = loadIndex(root)!;
    saveIndex(root, data);
    const leftovers = fs.readdirSync(cacheDir(root)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('loadIndex returns null for missing index', () => {
    assert.equal(loadIndex('/nonexistent/repo/xyz'), null);
  });
});