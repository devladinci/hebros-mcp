/**
 * Smoke test: index a repo, print summary + sample queries.
 * Usage: node dist/scripts/smoke.js <repo-root>
 */
import process from 'node:process';
import { buildIndex } from '../src/builder.js';
import { refreshIndex } from '../src/refresh.js';
import { Ctx, getDeps, getMap, findSymbol } from '../src/tools.js';

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: node dist/scripts/smoke.js <repo-root>');
    process.exit(1);
  }

  const t0 = Date.now();
  const { data, files } = await buildIndex(root);
  const fullMs = Date.now() - t0;
  console.log(`full build: ${files} files, ${data.symbols.length} symbols, ${data.imports.length} imports, ${data.calls.length} calls in ${fullMs}ms`);

  const t1 = Date.now();
  const { note } = await refreshIndex(root);
  console.log(`refresh (nothing changed): ${Date.now() - t1}ms — ${note}`);

  // sample queries against a real symbol, if any
  const ctx = new Ctx(root, data);
  const sample = data.symbols.find((s) => s.exported && s.kind === 'function') ?? data.symbols[0];
  if (sample) {
    console.log(`\n--- find_symbol(${sample.name}) ---\n${findSymbol(ctx, sample.name).slice(0, 600)}`);
    console.log(`\n--- get_map(${sample.file}) ---\n${getMap(ctx, sample.file).slice(0, 800)}`);
    console.log(`\n--- get_deps(${sample.file}, in) ---\n${getDeps(ctx, sample.file, 'in').slice(0, 400)}`);
  }
  console.log('\nSMOKE OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});