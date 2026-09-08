import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { globToRegExp } from '../../src/tools.js';

describe('globToRegExp', () => {
  it('exact path', () => {
    assert.ok(globToRegExp('src/a.ts').test('src/a.ts'));
    assert.ok(!globToRegExp('src/a.ts').test('src/b.ts'));
  });

  it('* does not cross directories', () => {
    const re = globToRegExp('src/*.ts');
    assert.ok(re.test('src/a.ts'));
    assert.ok(!re.test('src/sub/a.ts'));
  });

  it('** crosses directories', () => {
    const re = globToRegExp('packages/**/*.ts');
    assert.ok(re.test('packages/a/b/c.ts'));
    assert.ok(!re.test('apps/a.ts'));
  });

  it('**/ matches zero or more dirs', () => {
    const re = globToRegExp('**/util/*.ts');
    assert.ok(re.test('util/math.ts'));
    assert.ok(re.test('src/util/math.ts'));
  });

  it('prefix glob (trailing **) matches the dir itself', () => {
    const re = globToRegExp('src/api/**');
    assert.ok(re.test('src/api/index.ts'));
    assert.ok(re.test('src/api/deep/x.ts'));
  });

  it('? matches single non-separator char', () => {
    const re = globToRegExp('src/?.ts');
    assert.ok(re.test('src/a.ts'));
    assert.ok(!re.test('src/ab.ts'));
  });

  it('regex metacharacters are escaped', () => {
    const re = globToRegExp('a(b).ts');
    assert.ok(re.test('a(b).ts'));
    assert.ok(!re.test('axb.ts'));
  });
});