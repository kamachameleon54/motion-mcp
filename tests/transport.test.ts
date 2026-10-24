import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MotionApiClient } from '../src/api/client.js';
import { createVerifier } from '../src/auth.js';
import { createHttpApp } from '../src/http-app.js';
import { getTools } from '../src/server.js';
import { fixture, captureInput } from './fixture.js';
const auth = {
  issuer: 'https://issuer.example.test/',
  resource: 'https://motion.example.test/mcp',
  jwksUrl: 'https://issuer.example.test/jwks',
  subject: 'owner-test',
};
async function setup() {
  const f = fixture(),
    core = new MotionApiClient(f.config);
  const keys = await generateKeyPair('RS256');
  const verify = createVerifier(
    auth,
    core.store,
    createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] })
  );
  const token = async (changes: Record<string, unknown> = {}) =>
    new SignJWT({
      sub: 'owner-test',
      scope: 'motion:read motion:write',
      jti: 'fixture-token',
      iss: auth.issuer,
      aud: auth.resource,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...changes,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .sign(keys.privateKey);
  return { ...f, core, verify, token };
}
test('OAuth verifies subject, issuer, audience, scopes, expiry, required claims and revocation', async () => {
  const f = await setup();
  const good = await f.token();
  assert.deepEqual((await f.verify(good)).scopes, ['motion:read', 'motion:write']);
  for (const changes of [
    { sub: 'someone-else' },
    { iss: 'https://evil.test/' },
    { aud: 'different-resource' },
    { scope: 'motion:write' },
    { exp: 1 },
    { exp: undefined },
    { iat: undefined },
  ])
    await assert.rejects(f.verify(await f.token(changes)));
  f.core.store.revoke('fixture-token');
  await assert.rejects(f.verify(good));
  assert.equal(f.calls.length, 0);
  f.core.close();
});
test('HTTP rejects unauthenticated and revoked requests, advertises metadata, and enforces tool scopes', async () => {
  const f = await setup();
  const app = createHttpApp(f.core, auth, f.verify);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => listener.once('listening', r));
  const address = listener.address() as { port: number };
  const base = 'http://127.0.0.1:' + address.port;
  const call = async (token?: string, method = 'tools/list', params: any = {}) =>
    fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  try {
    const unauth = await call();
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
    const metadata = await fetch(base + '/.well-known/oauth-protected-resource/mcp');
    assert.equal(metadata.status, 200);
    assert.equal(((await metadata.json()) as any).resource, auth.resource);
    assert.equal(
      (await fetch(base + '/mcp', { method: 'POST', headers: { Origin: 'https://evil.test' } }))
        .status,
      403
    );
    const read = await f.token({ scope: 'motion:read', jti: 'read-token' });
    const list = (await (await call(read)).json()) as any;
    assert.ok(list.result.tools.length > 0);
    assert.ok(list.result.tools.every((t: any) => t.annotations.readOnlyHint));
    const denied = (await (
      await call(read, 'tools/call', { name: 'motion_capture_task', arguments: captureInput })
    ).json()) as any;
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /scope_denied/);
    assert.equal(f.calls.length, 0);
    const good = await f.token();
    f.core.store.revoke('fixture-token');
    assert.equal((await call(good)).status, 401);
  } finally {
    await new Promise<void>((r) => listener.close(() => r()));
    f.core.close();
  }
});
test('real SDK client initializes and calls authenticated Streamable HTTP', async () => {
  const f = await setup();
  const listener = createHttpApp(f.core, auth, f.verify).listen(0, '127.0.0.1');
  await new Promise<void>((r) => listener.once('listening', r));
  const port = (listener.address() as { port: number }).port;
  const client = new Client({ name: 'chatgpt-contract-fixture', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer ' + (await f.token()) } },
      })
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, getTools(f.core).length);
    const result = await client.callTool({
      name: 'motion_get_calendar_capabilities',
      arguments: {},
    });
    assert.ok(!result.isError);
    const bad = await client.callTool({
      name: 'motion_create_task',
      arguments: { name: 'test', workspaceId: 'work', inventedFlag: true },
    });
    assert.equal(bad.isError, true);
    assert.equal(f.calls.length, 0);
    const created: any = await client.callTool({
      name: 'motion_capture_task',
      arguments: captureInput,
    });
    assert.ok(!created.isError);
    assert.equal(f.tasks.size, 1);
  } finally {
    await client.close();
    await new Promise<void>((r) => listener.close(() => r()));
    f.core.close();
  }
});
test('Claude stdio launches and advertises the same supported tools without contacting Motion', async () => {
  const f = fixture();
  const core = new MotionApiClient(f.config);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      MOTION_API_KEY: 'fixture',
      MOTION_STATE_PATH: ':memory:',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'claude-parity-fixture', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((t) => t.name),
      getTools(core).map((t) => t.name)
    );
    const cap = await client.callTool({ name: 'motion_get_calendar_capabilities', arguments: {} });
    assert.ok(!cap.isError);
  } finally {
    await client.close();
    core.close();
  }
});
