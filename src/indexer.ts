#!/usr/bin/env node
/** `hebros index <root>` — build the index once and exit. Used by scripts and smoke runs. */
import process from 'node:process';
import { buildIndex } from './builder.js';
import { indexFile } from './db.js';

const root = process.argv[2] ?? process.cwd();
const t0 = Date.now();
const { data, files } = await buildIndex(root);
const ms = Date.now() - t0;
console.log(
  `indexed ${files} files (${data.symbols.length} symbols, ${data.imports.length} imports, ${data.calls.length} calls) in ${ms}ms -> ${indexFile(root)}`,
);