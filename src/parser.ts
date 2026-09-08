import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language, type Tree } from 'web-tree-sitter';

type LangKey = 'ts' | 'tsx';

const parsers = new Map<LangKey, Parser>();
const langs = new Map<LangKey, Language>();

/** Vendored grammar wasm files live in vendor/tree-sitter/ (dist/src -> ../../vendor). */
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'tree-sitter');

/**
 * Initialise the WASM parser and load the TypeScript grammars (once per process).
 * web-tree-sitter 0.27: Language.load takes a path/URL to a .wasm file;
 * the two grammars are vendored in vendor/tree-sitter/ (see the LICENSE there).
 */
export async function initParser(): Promise<void> {
  if (langs.size === 2) return;
  await Parser.init();
  langs.set('ts', await Language.load(path.join(VENDOR_DIR, 'tree-sitter-typescript.wasm')));
  langs.set('tsx', await Language.load(path.join(VENDOR_DIR, 'tree-sitter-tsx.wasm')));
}

/**
 * Parse `source` with the grammar for `lang`.
 * Parsers are pooled per language (setLanguage is expensive; parse is not thread-safe per instance).
 * The caller must call tree.delete() when done — WASM memory is not GC'd.
 */
export function parseFile(source: string, lang: LangKey): Tree {
  let parser = parsers.get(lang);
  const langObj = langs.get(lang);
  if (!langObj) throw new Error('parser not initialised — call initParser() first');
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(langObj);
    parsers.set(lang, parser);
  }
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter parse returned null');
  return tree;
}