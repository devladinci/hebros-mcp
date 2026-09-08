/**
 * Benchmark: build, refresh no-op, refresh after edit, tool calls.
 * Usage: node dist/scripts/bench.js <repo-root>
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from '../src/builder.js';
import { refreshIndex } from '../src/refresh.js';
import {
  toolFindSymbol,
  toolGetDeps,
  toolGetMap,
  toolGetReferences,
  toolReindex,
} from '../src/tools.js';
import { loadIndex } from '../src/db.js';

const root = process.argv[2];
if (!root) {
  console.error('usage: node dist/scripts/bench.js <repo-root>');
  process.exit(1);
}

async function time(label: string, fn: () => unknown, runs = 1): Promise<void> {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b2) => a - b2);
  const med = ms[Math.floor(ms.length / 2)] ?? 0;
  console.log(`${label.padEnd(46)} ${med.toFixed(1).padStart(8)} ms`);
}

const first = await buildIndex(root);
const files = Object.keys(first.data.files);
const mid = files.find((f) => (first.data.files[f]?.loc ?? 0) > 60 && (first.data.files[f]?.loc ?? 0) < 200) ?? files[0]!;
const dir = mid.split('/').slice(0, 2).join('/');

console.log(`repo: ${root} (${files.length} files)\n`);

await time('full build (parse + JSON write)', () => buildIndex(root));
await time('load index from disk', () => loadIndex(root), 5);
await time('refresh no-op (git unchanged)', () => refreshIndex(root), 5);

// edit one file -> incremental reparse (restored byte-identical afterwards)
const target = files.find((f) => f.endsWith('.ts')) ?? mid;
const abs = path.join(root, target);
const orig = fs.readFileSync(abs, 'utf8');
try {
  fs.appendFileSync(abs, '\nexport function __bench_marker__(): number { return 1; }\n');
  await time('refresh after 1-file edit (reparse 1)', () => refreshIndex(root), 3);
} finally {
  fs.writeFileSync(abs, orig);
}
await refreshIndex(root);

await time('get_map file (+ neighborhood)', () => toolGetMap(root, mid), 10);
await time('get_map repo root (summary mode)', () => toolGetMap(root, '.'), 5);
await time('get_deps file both', () => toolGetDeps(root, mid, 'both'), 10);
await time('get_deps dir both', () => toolGetDeps(root, dir, 'both'), 10);
await time('find_symbol', () => toolFindSymbol(root, 'a', undefined, { exportedOnly: true }), 10);
await time('get_references', () => toolGetReferences(root, 'get'), 10);
await time('reindex no-op', () => toolReindex(root), 5);