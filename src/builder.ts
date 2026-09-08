import fs from 'node:fs';
import path from 'node:path';
import { analyze, detectLang } from './analyze.js';
import { loadIndex, saveIndex } from './db.js';
import { headSha, statusHash } from './gitinfo.js';
import { listFiles } from './fsutil.js';
import { initParser, parseFile } from './parser.js';
import type { IndexData } from './types.js';

export interface BuildResult {
  data: IndexData;
  files: number;
}

/** Full build: parse every code file and write a fresh index. Correct, O(repo). */
export async function buildIndex(root: string): Promise<BuildResult> {
  const started = Date.now();
  await initParser();

  const realpath = fs.realpathSync(root);
  const files = listFiles(realpath);
  const symbols: IndexData['symbols'] = [];
  const imports: IndexData['imports'] = [];
  const calls: IndexData['calls'] = [];
  const filesMeta: IndexData['files'] = {};

  for (const f of files) {
    const lang = detectLang(f);
    if (!lang) continue;
    let code: string;
    try {
      code = fs.readFileSync(path.join(realpath, f), 'utf8');
    } catch {
      continue; // deleted between list and read
    }
    const tree = parseFile(code, lang);
    const res = analyze(f, tree);
    tree.delete(); // free WASM memory eagerly
    symbols.push(...res.symbols);
    imports.push(...res.imports);
    calls.push(...res.calls);
    filesMeta[f] = { loc: code.split('\n').length, bytes: Buffer.byteLength(code) };
  }

  const data: IndexData = {
    meta: {
      root: realpath, // single source of truth: tools resolve edges against this
      builtAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      headSha: headSha(realpath),
      statusHash: statusHash(realpath),
    },
    files: filesMeta,
    symbols,
    imports,
    calls,
  };
  saveIndex(realpath, data);
  return { data, files: files.length };
}
/** Convenience for tools: load the index, building it when missing. */
export async function ensureIndex(root: string): Promise<IndexData> {
  return loadIndex(root) ?? (await buildIndex(root)).data;
}
