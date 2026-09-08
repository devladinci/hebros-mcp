import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { analyze } from '../../src/analyze.js';
import { initParser, parseFile } from '../../src/parser.js';
import { makeRepo, standardFiles, cleanup, write } from '../testutil.js';
import fs from 'node:fs';
import path from 'node:path';

after(cleanup);

const src = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

async function analyzeFile(root: string, rel: string) {
  await initParser();
  const lang = rel.endsWith('.tsx') ? 'tsx' : 'ts';
  const tree = parseFile(src(root, rel), lang);
  const res = analyze(rel, tree);
  tree.delete();
  return res;
}

describe('analyze: symbols', () => {
  const root = makeRepo(standardFiles());

  it('finds exported functions and consts with line numbers', async () => {
    const { symbols } = await analyzeFile(root, 'src/util/math.ts');
    const add = symbols.find((s) => s.name === 'add');
    assert.ok(add);
    assert.equal(add.line, 1);
    assert.equal(add.endLine, 3, 'add() spans L1-L3');
    assert.equal(add.kind, 'function');
    assert.equal(add.exported, 1);
    assert.match(add.sig, /export function add\(a: number, b: number\): number/);
    const ver = symbols.find((s) => s.name === 'VERSION');
    assert.ok(ver);
    assert.equal(ver.kind, 'const');
    assert.equal(ver.exported, 1);
    assert.equal(ver.endLine, ver.line, 'one-liner has endLine == line');
  });

  it('class endLine covers the whole class body', async () => {
    const { symbols } = await analyzeFile(root, 'src/api/service.ts');
    const calc = symbols.find((s) => s.name === 'Calculator');
    assert.ok(calc);
    assert.equal(calc.line, 5);
    assert.equal(calc.endLine, 14, 'class closes on L14');
    const runService = symbols.find((s) => s.name === 'runService');
    assert.ok(runService);
    assert.ok(runService.endLine > runService.line);
  });

  it('marks class members with container and static flags', async () => {
    const { symbols } = await analyzeFile(root, 'src/api/service.ts');
    const addAll = symbols.find((s) => s.name === 'addAll');
    assert.ok(addAll);
    assert.equal(addAll.kind, 'method');
    assert.equal(addAll.container, 'Calculator');
    assert.equal(addAll.isStatic, 0);
    const id = symbols.find((s) => s.name === 'ID');
    assert.ok(id);
    assert.equal(id.isStatic, 1);
  });

  it('non-exported symbols are flagged exported=0', async () => {
    const files = standardFiles();
    files['src/priv.ts'] = 'function hidden(): void {}\nexport function shown(): void {}\n';
    const root2 = makeRepo(files);
    const { symbols } = await analyzeFile(root2, 'src/priv.ts');
    assert.equal(symbols.find((s) => s.name === 'hidden')?.exported, 0);
    assert.equal(symbols.find((s) => s.name === 'shown')?.exported, 1);
  });
});

describe('analyze: imports', () => {
  const root = makeRepo(standardFiles());

  it('records named imports with local names', async () => {
    const { imports } = await analyzeFile(root, 'src/api/service.ts');
    const rel = imports.find((i) => i.source === '../util/math.js');
    assert.ok(rel);
    assert.deepEqual(rel.names, ['add']);
    assert.equal(rel.kind, 'import');
    assert.equal(rel.line, 1);
  });

  it('records npm imports', async () => {
    const { imports } = await analyzeFile(root, 'src/api/service.ts');
    const node = imports.find((i) => i.source === 'node:fs');
    assert.ok(node);
    assert.deepEqual(node.names, ['fs']);
  });

  it('records side-effect imports as (side-effect)', async () => {
    const files = standardFiles();
    files['src/side.ts'] = 'import "./util/math.js";\n';
    const root2 = makeRepo(files);
    const { imports } = await analyzeFile(root2, 'src/side.ts');
    const side = imports.find((i) => i.source === './util/math.js');
    assert.ok(side);
    assert.deepEqual(side.names, ['(side-effect)']);
  });

  it('records re-exports', async () => {
    const { imports } = await analyzeFile(root, 'src/api/index.ts');
    const re = imports.find((i) => i.source === './service.js');
    assert.ok(re);
    assert.equal(re.kind, 'reexport');
    assert.ok(re.names.includes('Calculator'));
  });

  it('records dynamic imports', async () => {
    const files = standardFiles();
    files['src/dyn.ts'] = 'export async function lazy(): Promise<unknown> {\n  return import("./util/math.js");\n}\n';
    const root2 = makeRepo(files);
    const { imports } = await analyzeFile(root2, 'src/dyn.ts');
    const dyn = imports.find((i) => i.kind === 'dynamic');
    assert.ok(dyn);
    assert.equal(dyn.source, './util/math.js');
  });
});

describe('analyze: calls', () => {
  const root = makeRepo(standardFiles());

  it('records bare calls and calls inside const initializers', async () => {
    const { calls } = await analyzeFile(root, 'src/api/service.ts');
    const reduce = calls.find((c) => c.callee.includes('reduce'));
    assert.ok(reduce);
    assert.equal(reduce.container, 'addAll');
    const ctor = calls.find((c) => c.callee === 'Calculator');
    assert.ok(ctor);
    assert.equal(ctor.kind, 'new');
    assert.equal(ctor.container, 'runService');
  });

  it('records method calls with dotted callee', async () => {
    const { calls } = await analyzeFile(root, 'src/api/service.ts');
    const read = calls.find((c) => c.callee === 'fs.readFileSync');
    assert.ok(read);
    assert.equal(read.kind, 'method');
    assert.equal(read.container, 'runService');
  });

  it('records calls at module scope (container null)', async () => {
    const files = standardFiles();
    files['src/top.ts'] = 'const now = Date.now();\nexport const x = Math.max(1, 2);\n';
    const root2 = makeRepo(files);
    const { calls } = await analyzeFile(root2, 'src/top.ts');
    assert.ok(calls.some((c) => c.callee === 'Date.now' && c.container === null));
    assert.ok(calls.some((c) => c.callee === 'Math.max' && c.container === null));
  });

  it('records calls inside nested function declarations', async () => {
    const files = standardFiles();
    files['src/nested.ts'] = [
      'function helper(): void {}',
      'export function outer(): void {',
      '  function inner(): void {',
      '    helper();',
      '  }',
      '  inner();',
      '}',
      '',
    ].join('\n');
    const root2 = makeRepo(files);
    const { calls } = await analyzeFile(root2, 'src/nested.ts');
    assert.ok(calls.some((c) => c.callee === 'helper' && c.container === 'inner'), 'helper() inside inner() recorded');
    assert.ok(calls.some((c) => c.callee === 'inner' && c.container === 'outer'), 'inner() called from outer() recorded');
    const names = new Set((await analyzeFile(root2, 'src/nested.ts')).symbols.map((s) => s.name));
    assert.ok(!names.has('inner'), 'nested declaration is not a symbol');
  });

  it('anonymous default export becomes a default symbol', async () => {
    const files = standardFiles();
    files['src/def.tsx'] = 'export default () => { return null; };\n';
    const root2 = makeRepo(files);
    const { symbols } = await analyzeFile(root2, 'src/def.tsx');
    const def = symbols.find((s) => s.isDefault === 1);
    assert.ok(def, 'anonymous default export indexed');
    assert.equal(def.kind, 'function');
    assert.equal(def.exported, 1);
    assert.match(def.sig, /export default/);
  });

  it('export default Named keeps the name and adds a default alias row', async () => {
    const files = standardFiles();
    files['src/defnamed.ts'] = 'const Named = () => null;\nexport default Named;\n';
    const root2 = makeRepo(files);
    const { symbols } = await analyzeFile(root2, 'src/defnamed.ts');
    assert.ok(symbols.find((s) => s.name === 'Named' && s.isDefault === 0), 'declaration row keeps its own name');
    assert.ok(symbols.find((s) => s.name === 'Named' && s.isDefault === 1), 'default row aliases the same name');
  });

  it('anonymous default class/function expressions get symbol rows', async () => {
    const files = standardFiles();
    files['src/defexpr.ts'] = 'export default function () { return 1; }\n';
    const root2 = makeRepo(files);
    const { symbols } = await analyzeFile(root2, 'src/defexpr.ts');
    const def = symbols.find((s) => s.isDefault === 1);
    assert.ok(def, 'anonymous default function expression indexed');
    assert.equal(def.kind, 'function');
  });
});

describe('analyze: tsx', () => {
  it('parses tsx files and finds components', async () => {
    const root = makeRepo({
      'src/Comp.tsx': [
        'export function Badge({ label }: { label: string }) {',
        '  return <span className="badge">{label}</span>;',
        '}',
        '',
      ].join('\n'),
    });
    const { symbols } = await analyzeFile(root, 'src/Comp.tsx');
    const badge = symbols.find((s) => s.name === 'Badge');
    assert.ok(badge);
    assert.equal(badge.kind, 'function');
    assert.equal(badge.exported, 1);
  });

  it('records JSX component usage as a call row (open and self-closing tags)', async () => {
    const root = makeRepo({
      'src/Picker.tsx': 'export function Picker(): null { return null; }\n',
      'src/App.tsx': [
        'import { Picker } from "./Picker";',
        '',
        'export function App() {',
        '  return (',
        '    <div>',
        '      <Picker mode="fast" />',
        '      <Picker>text</Picker>',
        '      <span>plain</span>',
        '    </div>',
        '  );',
        '}',
        '',
      ].join('\n'),
    });
    const { calls } = await analyzeFile(root, 'src/App.tsx');
    const jsx = calls.filter((c) => c.kind === 'jsx');
    assert.equal(jsx.length, 2, `expected 2 jsx rows, got ${JSON.stringify(calls)}`);
    assert.ok(jsx.every((c) => c.callee === 'Picker'));
    assert.ok(jsx.every((c) => c.container === 'App'));
    assert.ok(!calls.some((c) => c.callee === 'span'), 'lowercase host elements are not components');
  });
});