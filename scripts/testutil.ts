/**
 * Shared test helpers: throwaway git repos with generated TS files,
 * and an isolated HEBROS_CACHE so tests never touch the real ~/.cache.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const roots: string[] = [];

export function makeRepo(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hebros-test-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  if (opts.git !== false) {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'test@hebros.local']);
    git(root, ['config', 'user.name', 'hebros-test']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'init']);
  }
  return root;
}

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** Write into an existing test repo (marks it dirty unless committed). */
export function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function commitAll(root: string, msg = 'change'): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', msg]);
}

/** Fresh isolated cache dir per test file. */
export function isolatedCache(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hebros-cache-'));
  roots.push(dir);
  process.env.HEBROS_CACHE = dir;
  return dir;
}

export function cleanup(): void {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Standard small fixture: relative import, .js specifier, alias, npm, class + members. */
export function standardFiles(): Record<string, string> {
  return {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { paths: { '@util/*': ['src/util/*'] } },
    }),
    'src/util/math.ts': [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export const VERSION = "1.0.0";',
      '',
    ].join('\n'),
    'src/api/service.ts': [
      'import { add } from "../util/math.js";',
      'import { multiply } from "@util/ops.js";',
      'import fs from "node:fs";',
      '',
      'export class Calculator {',
      '  static ID = "calc";',
      '  base = 0;',
      '  addAll(nums: number[]): number {',
      '    return nums.reduce((acc, n) => add(acc, n), this.base);',
      '  }',
      '  scale(n: number): number {',
      '    return multiply(n, 2);',
      '  }',
      '}',
      '',
      'export function runService(): void {',
      '  const calc = new Calculator();',
      '  calc.addAll([1, 2, 3]);',
      '  fs.readFileSync("/dev/null");',
      '}',
      '',
    ].join('\n'),
    'src/util/ops.ts': [
      'export function multiply(a: number, b: number): number {',
      '  return a * b;',
      '}',
      '',
    ].join('\n'),
    'src/api/index.ts': [
      'export { Calculator, runService } from "./service.js";',
      'export * from "../util/math.js";',
      '',
    ].join('\n'),
    'README.md': '# fixture\n',
  };
}