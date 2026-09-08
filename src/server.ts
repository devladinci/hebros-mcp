#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  toolFindSymbol,
  toolGetDeps,
  toolGetMap,
  toolGetReferences,
  toolReindex,
} from './tools.js';

const VERSION: string = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;

/** Resolve the repo to index: --root flag, HEBROS_ROOT env, or cwd. */
function resolveRoot(): string {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf('--root');
  const root = (flagIdx !== -1 ? args[flagIdx + 1] : process.env.HEBROS_ROOT) ?? process.cwd();
  return fs.realpathSync(path.resolve(root));
}

interface ToolDef {
  name: string;
  register: (srv: McpServer, root: string) => void;
}

const TOOLS: ToolDef[] = [
  {
    name: 'get_map',
    register: (srv, root) =>
      srv.registerTool(
        'get_map',
        {
          title: 'Get code map',
          description:
            'Structure of a file or directory from the prebuilt index: every symbol with its line number and ' +
            'one-line signature, NO bodies. For a file, also shows what it imports (with each dependency\'s main ' +
            'exports) and who imports it. Cheaper than reading the whole file or globbing directories. ' +
            'Use BEFORE reading any file to decide which exact lines you need.',
          inputSchema: {
            target: z
              .string()
              .describe('File or directory path relative to the repo root (e.g. "src" or "src/server.ts"). "." = whole repo.'),
          },
        },
        async ({ target }) => ({ content: [{ type: 'text', text: await toolGetMap(root, target ?? '.') }] }),
      ),
  },
  {
    name: 'find_symbol',
    register: (srv, root) =>
      srv.registerTool(
        'find_symbol',
        {
          title: 'Find symbol definition',
          description:
            'Exact file:line where a function/class/interface/type/const is defined, from the symbol index. ' +
            'Use instead of grepping for definitions. Then read only that line range.',
          inputSchema: {
            name: z.string().describe('Symbol name (exact, falls back to word-part match).'),
            kind: z
              .string()
              .optional()
              .describe('Optional filter: class | function | const | interface | type | enum | method | property.'),
            file_glob: z
              .string()
              .optional()
              .describe('Restrict to files matching a glob, e.g. "packages/ui-web/**".'),
            exported_only: z
              .boolean()
              .optional()
              .describe('Only exported symbols (the public API of an area).'),
          },
        },
        async ({ name, kind, file_glob, exported_only }) => ({
          content: [{ type: 'text', text: await toolFindSymbol(root, name, kind, { fileGlob: file_glob, exportedOnly: exported_only }) }],
        }),
      ),
  },
  {
    name: 'get_deps',
    register: (srv, root) =>
      srv.registerTool(
        'get_deps',
        {
          title: 'Get import dependencies',
          description:
            'Import graph for one file OR a whole directory/package: what it imports and who imports it. ' +
            'Directory mode aggregates edges (N files -> target). Use for impact analysis before refactoring ' +
            '("what breaks if I change this package?").',
          inputSchema: {
            file: z.string().describe('File or directory path relative to the repo root.'),
            direction: z.enum(['in', 'out', 'both']).default('both').describe('Which edges to show.'),
          },
        },
        async ({ file, direction }) => ({ content: [{ type: 'text', text: await toolGetDeps(root, file, direction ?? 'both') }] }),
      ),
  },
  {
    name: 'get_references',
    register: (srv, root) =>
      srv.registerTool(
        'get_references',
        {
          title: 'Get symbol references',
          description:
            'Where a symbol is used: JSX component usages, call sites (with line numbers) and which files import it by name. ' +
            'Use instead of grep-ing for usages. Heuristic — for a common name, narrow with file.',
          inputSchema: {
            name: z.string().describe('Symbol name (function/class/method/component as written at usage sites).'),
            file: z.string().optional().describe('Restrict to one file (repo-relative).'),
          },
        },
        async ({ name, file }) => ({ content: [{ type: 'text', text: await toolGetReferences(root, name, file) }] }),
      ),
  },
  {
    name: 'reindex',
    register: (srv, root) =>
      srv.registerTool(
        'reindex',
        {
          title: 'Refresh the index',
          description: 'Incremental git-based refresh (only changed files are re-parsed). Rarely needed — tools auto-refresh.',
          inputSchema: {},
        },
        async () => ({ content: [{ type: 'text', text: await toolReindex(root) }] }),
      ),
  },
];

async function main(): Promise<void> {
  const root = resolveRoot();
  const server = new McpServer({ name: 'hebros', version: VERSION });
  for (const tool of TOOLS) tool.register(server, root);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`hebros MCP ready (${TOOLS.length} tools) — indexing ${root}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});