import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { resolveImport, loadAliasConfigs, buildEdges } from '../../src/imports.js';
import { makeRepo, standardFiles, cleanup } from '../testutil.js';

after(cleanup);

describe('imports: relative resolution', () => {
  const root = makeRepo(standardFiles());
  const aliases = loadAliasConfigs(root);

  it('resolves .js specifier to .ts file (TS ESM style)', () => {
    const r = resolveImport('src/api/service.ts', '../util/math.js', root, aliases);
    assert.equal(r.target, 'src/util/math.ts');
    assert.equal(r.pkg, null);
  });

  it('resolves extensionless relative import', () => {
    const r = resolveImport('src/api/service.ts', '../util/math', root, aliases);
    assert.equal(r.target, 'src/util/math.ts');
  });

  it('resolves directory index', () => {
    const files = standardFiles();
    files['src/dir/index.ts'] = 'export const d = 1;\n';
    const root2 = makeRepo(files);
    const r = resolveImport('src/api/service.ts', '../dir', root2, aliases);
    assert.equal(r.target, 'src/dir/index.ts');
  });
});

describe('imports: tsconfig aliases', () => {
  const root = makeRepo(standardFiles());
  const aliases = loadAliasConfigs(root);

  it('loads @util/* alias from tsconfig.json', () => {
    assert.deepEqual(aliases[0]?.patterns['@util/*'], ['src/util/*']);
  });

  it('resolves alias import', () => {
    const r = assertResolve(root, 'src/api/service.ts', '@util/ops.js', 'src/util/ops.ts');
    assert.equal(r.target, 'src/util/ops.ts');
  });
});

/** assert-style wrapper that keeps the resolveImport call sites readable */
function assertResolve(root: string, from: string, spec: string, expected: string): { target: string | null; pkg: string | null } {
  const r = resolveImport(from, spec, root, loadAliasConfigs(root));
  assert.equal(r.target, expected, `resolveImport(${from}, ${spec})`);
  return r;
}

describe('imports: tsconfig discovery (nested + extends)', () => {
  // Vite/Next-shaped layout: tsconfig at frontend/ (not repo root), alias
  // "@/*": ["./src/*"], plus a solution-style root tsconfig with extends.
  const files = {
    ...standardFiles(),
    'frontend/tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
    }),
    'frontend/src/main.tsx': 'import { util } from "@/lib/util";\nexport const u = util;\n',
    'frontend/src/lib/util.ts': 'export const util = 1;\n',
  };
  const root = makeRepo(files);

  it('discovers nested tsconfig and resolves relative to its own directory', () => {
    const configs = loadAliasConfigs(root);
    const fe = configs.find((c) => c.scope === 'frontend');
    assert.ok(fe, 'frontend tsconfig discovered');
    assert.deepEqual(fe.patterns['@/*'], ['frontend/src/*']);
  });

  it('resolves @/ imports scoped to the nested config directory', () => {
    const r = resolveImport('frontend/src/main.tsx', '@/lib/util', root, loadAliasConfigs(root));
    assert.equal(r.target, 'frontend/src/lib/util.ts');
  });

  it('root-scope files do not get frontend aliases applied', () => {
    const r = resolveImport('src/api/service.ts', '@/lib/util', root, loadAliasConfigs(root));
    assert.equal(r.target, null);
  });
});

describe('imports: extends chains', () => {
  const files = {
    ...standardFiles(),
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { paths: { '@base/*': ['src/base/*'] } } }),
    'packages/app/tsconfig.json': JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['./app/*'] } },
    }),
    'src/base/helper.ts': 'export const h = 1;\n',
    'packages/app/app/thing.ts': 'export const t = 1;\n',
    'packages/app/index.ts': 'import { h } from "@base/helper";\nimport { t } from "@app/thing";\n',
  };
  const root = makeRepo(files);

  it('child config wins, parent paths still usable (targets relative to defining config)', () => {
    const r1 = resolveImport('packages/app/index.ts', '@base/helper', root, loadAliasConfigs(root));
    assert.equal(r1.target, 'src/base/helper.ts', 'inherited alias resolves relative to base config dir');
    const r2 = resolveImport('packages/app/index.ts', '@app/thing', root, loadAliasConfigs(root));
    assert.equal(r2.target, 'packages/app/app/thing.ts');
  });

  it('extends cycle terminates', () => {
    const root2 = makeRepo({
      ...standardFiles(),
      'a/tsconfig.json': '{"extends": "./tsconfig.self.json", "compilerOptions": {"paths": {"@a/*": ["src/*"]}}}',
      'a/tsconfig.self.json': '{"extends": "./tsconfig.json"}',
      'a/x.ts': 'export const x = 1;\n',
    });
    const configs = loadAliasConfigs(root2);
    assert.ok(configs.length >= 1, 'no infinite loop');
  });
});

describe('imports: failed aliases are never npm', () => {
  const root = makeRepo({
    ...standardFiles(),
    'frontend/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'frontend/src/main.tsx': 'import x from "@/nope";\n',
  });

  it('failed alias -> pkg null (stays (unresolved:...), never npm:)', () => {
    const r = resolveImport('frontend/src/main.tsx', '@/nope', root, loadAliasConfigs(root));
    assert.equal(r.target, null);
    assert.equal(r.pkg, null);
  });

  it('unmatched @pkg/name (real npm scope) still resolves as npm', () => {
    const r = resolveImport('src/api/service.ts', '@scope/lib', root, loadAliasConfigs(root));
    assert.equal(r.pkg, '@scope/lib');
  });

  it('~/ and # prefixes are never npm', () => {
    for (const spec of ['~/lib/x', '#internal']) {
      const r = resolveImport('src/api/service.ts', spec, root, loadAliasConfigs(root));
      assert.equal(r.pkg, null, spec);
    }
  });

  it('buildEdges: failed alias shows as (unresolved:...)', () => {
    const edges = buildEdges(
      [{ file: 'frontend/src/main.tsx', source: '@/nope', names: ['x'], line: 1, kind: 'import' }],
      root,
      loadAliasConfigs(root),
    );
    assert.equal(edges[0]!.to, '(unresolved:@/nope)');
  });
});

describe('imports: workspace and npm', () => {
  const root = makeRepo({
    ...standardFiles(),
    'packages/shared/package.json': '{"name":"@app/shared"}',
    'packages/shared/src/index.ts': 'export const s = 1;\n',
  });
  const aliases = loadAliasConfigs(root);

  it('resolves workspace package by short name', () => {
    const r = resolveImport('src/api/service.ts', '@app/shared', root, aliases);
    assert.equal(r.target, 'packages/shared/src/index.ts');
  });

  it('falls back to npm: for unknown bare specifiers', () => {
    const r = resolveImport('src/api/service.ts', 'lodash-es', root, aliases);
    assert.equal(r.target, null);
    assert.equal(r.pkg, 'lodash-es');
  });
});

describe('buildEdges', () => {
  it('unresolved relative imports stay visible', () => {
    const root = makeRepo(standardFiles());
    const edges = buildEdges(
      [{ file: 'src/api/service.ts', source: '../missing/thing.js', names: ['x'], line: 3, kind: 'import' }],
      root,
      [],
    );
    assert.equal(edges[0]!.to, '(unresolved:../missing/thing.js)');
  });

  it('npm edges get npm: prefix', () => {
    const root = makeRepo(standardFiles());
    const edges = buildEdges(
      [{ file: 'src/api/service.ts', source: 'lodash-es', names: ['x'], line: 3, kind: 'import' }],
      root,
      [],
    );
    assert.equal(edges[0]!.to, 'npm:lodash-es');
  });
});

describe('imports: workspace packages outside packages/', () => {
  const root = makeRepo({
    ...standardFiles(),
    'package.json': '{"name":"root","workspaces":["packages/*","apps/*"]}',
    'packages/ui/package.json': '{"name":"@acme/ui"}',
    'packages/ui/src/index.ts': 'export const ui = 1;\n',
    'packages/ui/src/button/index.ts': 'export const button = 2;\n',
    'packages/renamed-dir/package.json': '{"name":"@acme/actual"}',
    'packages/renamed-dir/src/index.ts': 'export const a = 1;\n',
    'apps/api/package.json': '{"name":"@acme/api"}',
    'apps/api/src/index.ts': 'export const api = 1;\n',
  });
  const aliases = loadAliasConfigs(root);

  it('resolves a workspace package under apps/, not just packages/', () => {
    const r = resolveImport('packages/ui/src/index.ts', '@acme/api', root, aliases);
    assert.equal(r.target, 'apps/api/src/index.ts');
    assert.equal(r.pkg, null, 'a workspace dep must never be labelled an npm package');
  });

  it('resolves by declared name when it differs from the directory name', () => {
    const r = resolveImport('apps/api/src/index.ts', '@acme/actual', root, aliases);
    assert.equal(r.target, 'packages/renamed-dir/src/index.ts');
  });

  it('deep subpath into a scoped package keeps the whole subpath', () => {
    // the subpath is 'button', whatever the lengths of the scope and the name
    const r = resolveImport('apps/api/src/index.ts', '@acme/ui/button', root, aliases);
    assert.equal(r.target, 'packages/ui/src/button/index.ts');
  });

  it('unknown scoped specifier is still npm', () => {
    const r = resolveImport('apps/api/src/index.ts', '@acme/nope', root, aliases);
    assert.equal(r.target, null);
    assert.equal(r.pkg, '@acme/nope');
  });

  it('buildEdges records the workspace edge as a file, not npm:', () => {
    const edges = buildEdges(
      [{ file: 'packages/ui/src/index.ts', source: '@acme/api', names: ['api'], line: 1, kind: 'import' }],
      root,
      aliases,
    );
    assert.equal(edges[0]!.to, 'apps/api/src/index.ts');
  });
});

describe('imports: workspace globs are read from the repo', () => {
  const root = makeRepo({
    ...standardFiles(),
    'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n",
    'libs/shared/package.json': '{"name":"@acme/shared"}',
    'libs/shared/src/index.ts': 'export const s = 1;\n',
  });

  it('honours pnpm-workspace.yaml globs (libs/, not the default layout)', () => {
    const r = resolveImport('src/api/service.ts', '@acme/shared', root, loadAliasConfigs(root));
    assert.equal(r.target, 'libs/shared/src/index.ts');
  });
});
