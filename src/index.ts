#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './config.js';
import { MotionApiClient } from './api/client.js';
import { createMcpServer } from './server.js';
const client = new MotionApiClient(getConfig());
const server = createMcpServer(client);
server.connect(new StdioServerTransport()).catch(() => {
  console.error('Motion MCP failed to start. Check configuration.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await server.close();
    client.close();
    process.exit(0);
  });
