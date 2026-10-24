#!/usr/bin/env node
// Optional migration adapter: Claude stdio and ChatGPT use one remote quota/operation store.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
async function main() {
  const url = new URL(process.env.MOTION_MCP_URL!);
  if (url.protocol !== 'https:') throw new Error('HTTPS required');
  if (!process.env.MOTION_MCP_ACCESS_TOKEN) throw new Error('OAuth access token required');
  const remote = new Client({ name: 'motion-claude-bridge', version: '0.2.0' });
  await remote.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: 'Bearer ' + process.env.MOTION_MCP_ACCESS_TOKEN } },
    })
  );
  const local = new Server(
    { name: 'motion-mcp-server', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );
  local.setRequestHandler(ListToolsRequestSchema, () => remote.listTools());
  local.setRequestHandler(CallToolRequestSchema, (request) => remote.callTool(request.params));
  await local.connect(new StdioServerTransport());
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, async () => {
      await local.close();
      await remote.close();
      process.exit(0);
    });
}
main().catch(() => {
  console.error('Motion remote bridge failed. Check URL and OAuth access token.');
  process.exitCode = 1;
});
