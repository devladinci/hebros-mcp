/**
 * One-shot MCP client check: list tools + call get_map.
 * Usage: node dist/scripts/mcp-check.js <repo-root> [file]
 */
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.cwd();
  const file = process.argv[3] ?? '.';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../src/server.js', import.meta.url).pathname, '--root', root],
  });
  const client = new Client({ name: 'hebros-check', version: '0.1.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log('tools:', tools.tools.map((t) => t.name).sort().join(', '));

  const res = await client.callTool({ name: 'get_map', arguments: { target: file } });
  const blocks = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const text = blocks.map((c) => c.text ?? '').join('');
  console.log('--- get_map output ---');
  console.log(text);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});