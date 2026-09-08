import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import { porcelainPaths, diffPaths } from '../../src/refresh.js';
import { statusHash, headSha } from '../../src/gitinfo.js';
import { makeRepo, standardFiles, write, commitAll, cleanup } from '../testutil.js';

after(cleanup);

describe('gitinfo: statusHash', () => {
  it('is "clean" on a clean repo', () => {
    const root = makeRepo(standardFiles());
    assert.equal(statusHash(root), 'clean');
  });

  it('changes when a dirty file is edited again', () => {
    const root = makeRepo(standardFiles());
    write(root, 'src/util/math.ts', 'export const x = 1;\n');
    const h1 = statusHash(root);
    assert.notEqual(h1, 'clean');
    write(root, 'src/util/math.ts', 'export const x = 2;\n');
    const h2 = statusHash(root);
    assert.notEqual(h1, h2);
  });

  it('changes when a file inside an untracked dir is edited', () => {
    const root = makeRepo(standardFiles());
    write(root, 'src/new/dir/a.ts', 'export const a = 1;\n');
    const h1 = statusHash(root);
    write(root, 'src/new/dir/a.ts', 'export const a = 2;\n');
    assert.notEqual(statusHash(root), h1);
  });

  it('is null outside a git repo', () => {
    const root = makeRepo(standardFiles(), { git: false });
    assert.equal(statusHash(root), null);
  });
});

describe('refresh: porcelain parsing', () => {
  it('parses worktree-modified files (leading space status)', () => {
    const root = makeRepo(standardFiles());
    write(root, 'src/util/math.ts', 'export const x = 1;\n');
    const { changed, removed } = porcelainPaths(root);
    assert.ok(changed.includes('src/util/math.ts'));
    assert.deepEqual(removed, []);
  });

  it('parses deleted files', () => {
    const root = makeRepo(standardFiles());
    
    fs.unlinkSync(`${root}/src/util/ops.ts`);
    const { removed, changed } = porcelainPaths(root);
    assert.ok(removed.includes('src/util/ops.ts'));
    assert.ok(!changed.includes('src/util/ops.ts'));
  });

  it('lists files inside untracked directories individually', () => {
    const root = makeRepo(standardFiles());
    write(root, 'src/new/dir/a.ts', 'export const a = 1;\n');
    write(root, 'src/new/dir/b.ts', 'export const b = 1;\n');
    const { changed } = porcelainPaths(root);
    assert.ok(changed.includes('src/new/dir/a.ts'));
    assert.ok(changed.includes('src/new/dir/b.ts'));
  });

  it('handles paths with spaces and quotes', () => {
    const root = makeRepo(standardFiles());
    write(root, 'src/weird "name".ts', 'export const w = 1;\n');
    const { changed } = porcelainPaths(root);
    assert.ok(changed.includes('src/weird "name".ts'), JSON.stringify(changed));
  });

  it('splits renames into removed + changed', () => {
    const root = makeRepo(standardFiles());
    
    fs.renameSync(`${root}/src/util/ops.ts`, `${root}/src/util/ops2.ts`);
    const { changed, removed } = porcelainPaths(root);
    assert.ok(changed.includes('src/util/ops2.ts'));
    assert.ok(removed.includes('src/util/ops.ts'));
  });
});

describe('refresh: diffPaths', () => {
  it('lists files changed by commits', () => {
    const root = makeRepo(standardFiles());
    const prev = headSha(root);
    write(root, 'src/util/math.ts', 'export const x = 9;\n');
    commitAll(root, 'edit math');
    const paths = diffPaths(root, prev!, headSha(root)!);
    assert.deepEqual(paths, ['src/util/math.ts']);
  });
});