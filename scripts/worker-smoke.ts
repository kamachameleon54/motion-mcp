import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2];
const header = process.env.SMOKE_ACCESS_JWT; // local only: a token the local gate accepts
if (!url) throw new Error('usage: worker-smoke <url>');
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: header ? { 'cf-access-jwt-assertion': header } : {} },
});
const client = new Client({ name: 'worker-smoke', version: '0.0.1' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('tools', tools.length);
const me = await client.callTool({ name: 'motion_get_current_user', arguments: {} });
console.log('current user ok', !me.isError);
await client.close();
