#!/usr/bin/env node
// subcommands: `index` (one-shot build), `serve` (MCP server, default).
const argv = process.argv.slice(2);
const subIdx = argv.findIndex((a) => !a.startsWith('--'));
const sub = subIdx !== -1 && argv[subIdx] === 'index' ? 'index' : 'serve';
if (subIdx !== -1 && argv[subIdx] === 'index') argv.splice(subIdx, 1); // ["index", "/path"] -> ["/path"]
process.argv = [process.argv[0], process.argv[1], ...argv];
const mod = sub === 'index' ? '../dist/src/indexer.js' : '../dist/src/server.js';
import(mod).catch((e) => {
  console.error(e);
  process.exit(1);
});