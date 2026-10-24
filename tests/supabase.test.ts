import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { createVerifier } from '../src/auth.js';
import { supabaseConfig, type ConsentConfig } from '../src/supabase-config.js';
import { createHttpApp } from '../src/http-app.js';
import { MotionApiClient } from '../src/api/client.js';
import { fixture } from './fixture.js';
import { safeRedirect, validateAuthorization } from '../web/consent-policy.js';
const subject = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const config: ConsentConfig = {
  url: 'https://fixture.supabase.co',
  publishableKey: 'sb_publishable_fixture',
  subject,
  clients: [
    {
      clientId,
      permissions: ['motion:read', 'motion:write'],
      redirectUris: ['https://chatgpt.example.test/callback'],
    },
  ],
};
const auth = {
  issuer: config.url + '/auth/v1',
  resource: 'https://motion.example.test/mcp',
  jwksUrl: config.url + '/auth/v1/.well-known/jwks.json',
  subject,
  provider: 'supabase' as const,
  clients: config.clients,
};

test('Supabase accepts only resource-bound owner/client grants, rejects regular sessions and forged scope', async () => {
  const f = fixture();
  const core = new MotionApiClient(f.config);
  const keys = await generateKeyPair('ES256');
  const verify = createVerifier(
    auth,
    core.store,
    createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] })
  );
  const token = (changes = {}) =>
    new SignJWT({
      iss: auth.issuer,
      aud: auth.resource,
      sub: subject,
      client_id: clientId,
      is_anonymous: false,
      motion_permissions: ['motion:read', 'motion:write'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
      ...changes,
    })
      .setProtectedHeader({ alg: 'ES256' })
      .sign(keys.privateKey);
  try {
    assert.deepEqual((await verify(await token())).scopes, ['motion:read', 'motion:write']);
    for (const changes of [
      { aud: 'authenticated' },
      { aud: ['authenticated', auth.resource] },
      { client_id: undefined },
      { client_id: 'unregistered' },
      { sub: 'different-user' },
      { is_anonymous: true },
      { motion_permissions: undefined, scope: 'motion:read motion:write' },
      { motion_permissions: ['motion:write'] },
      {
        motion_permissions: undefined,
        user_metadata: { motion_permissions: ['motion:read', 'motion:write'] },
      },
    ])
      await assert.rejects(verify(await token(changes)));
    const readOnly = createVerifier(
      { ...auth, clients: [{ clientId, permissions: ['motion:read'] }] },
      core.store,
      createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] })
    );
    assert.deepEqual((await readOnly(await token())).scopes, ['motion:read']);
    assert.equal(f.calls.length, 0);
  } finally {
    core.close();
  }
});

test('Supabase configuration rejects secret keys, mismatched projects and unregistered clients', () => {
  const env = {
    MCP_AUTH_PROVIDER: 'supabase',
    SUPABASE_URL: config.url,
    SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    MCP_SUPABASE_CLIENTS: JSON.stringify(config.clients),
  };
  assert.equal(supabaseConfig(env, { ...auth })?.subject, subject);
  assert.throws(() =>
    supabaseConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_fixture' }, { ...auth })
  );
  assert.throws(() => supabaseConfig({ ...env, MCP_SUPABASE_CLIENTS: '[]' }, { ...auth }));
  assert.throws(() =>
    supabaseConfig(env, { ...auth, issuer: 'https://other.supabase.co/auth/v1' })
  );
});

test('consent rejects unknown client, account, permission and redirect before approval', () => {
  const data = {
    authorization_id: 'authorization-fixture',
    user: { id: subject },
    client: { id: clientId },
    scope: 'openid',
    redirect_uri: config.clients[0]!.redirectUris[0]!,
  };
  assert.equal(
    validateAuthorization(config, subject, data.authorization_id, data).clientId,
    clientId
  );
  for (const changes of [
    { client: { id: 'unknown' } },
    { user: { id: 'other' } },
    { scope: 'openid email' },
    { redirect_uri: 'https://evil.test/callback' },
    { authorization_id: 'different' },
  ])
    assert.throws(() =>
      validateAuthorization(config, subject, data.authorization_id, { ...data, ...changes })
    );
  const redirects = config.clients[0]!.redirectUris;
  assert.equal(
    safeRedirect(redirects[0] + '?code=fixture&state=fixture', redirects),
    redirects[0] + '?code=fixture&state=fixture'
  );
  for (const value of [
    'https://chatgpt.example.test.evil.test/callback',
    'https://chatgpt.example.test@evil.test/callback',
    'javascript:alert(1)',
    'http://chatgpt.example.test/callback',
    redirects[0] + '#token=fixture',
    redirects[0] + '/extra',
  ])
    assert.throws(() => safeRedirect(value, redirects));
});

test('Supabase metadata and tool security request only supported OIDC scope while enforcing read-only Motion access', async () => {
  const f = fixture();
  const core = new MotionApiClient(f.config);
  const listener = createHttpApp(
    core,
    auth,
    async () => ({ scopes: ['motion:read'] }),
    config
  ).listen(0, '127.0.0.1');
  await new Promise<void>((r) => listener.once('listening', r));
  const base = 'http://127.0.0.1:' + (listener.address() as { port: number }).port;
  try {
    const meta = (await (
      await fetch(base + '/.well-known/oauth-protected-resource/mcp')
    ).json()) as any;
    assert.deepEqual(meta.scopes_supported, ['openid']);
    const unauth = await fetch(base + '/mcp', { method: 'POST' });
    assert.match(unauth.headers.get('www-authenticate')!, /scope="openid"/);
    const page = await fetch(base + '/oauth/consent');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(await page.text(), /Allow connection/);
    const call = async (method: string, params = {}) =>
      (await (
        await fetch(base + '/mcp', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer fixture',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).json()) as any;
    const list = await call('tools/list');
    assert.ok(list.result.tools.every((tool: any) => tool.annotations.readOnlyHint));
    assert.ok(
      list.result.tools.every(
        (tool: any) => JSON.stringify(tool._meta.securitySchemes[0].scopes) === '["openid"]'
      )
    );
    const denied = await call('tools/call', {
      name: 'motion_delete_task',
      arguments: { taskId: 'fixture' },
    });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result._meta['mcp/www_authenticate'][0], /scope="openid"/);
    assert.equal(f.calls.length, 0);
  } finally {
    await new Promise<void>((r) => listener.close(() => r()));
    core.close();
  }
});

test('actual Postgres hook grants only registered subject/client, handles refresh, and prevents public access', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role supabase_auth_admin;');
    await db.exec(readFileSync('supabase/motion-auth.sql', 'utf8'));
    await db.query('insert into motion_auth.clients values ($1,$2,$3,$4)', [
      clientId,
      subject,
      auth.resource,
      ['motion:read', 'motion:write'],
    ]);
    const original = {
      sub: subject,
      client_id: clientId,
      is_anonymous: false,
      aud: 'authenticated',
      iat: 1000,
      exp: 4600,
      scope: 'openid',
      role: 'authenticated',
    };
    const hook = async (
      claims: object,
      method = 'oauth_provider/authorization_code',
      user = subject
    ) => {
      await db.exec('set role supabase_auth_admin');
      try {
        return (
          await db.query<{ result: { claims: any } }>(
            'select motion_auth.access_token_hook($1::jsonb) as result',
            [JSON.stringify({ claims, user_id: user, authentication_method: method })]
          )
        ).rows[0]!.result.claims;
      } finally {
        await db.exec('reset role');
      }
    };
    for (const method of ['oauth_provider/authorization_code', 'token_refresh']) {
      const result = await hook(original, method);
      assert.equal(result.aud, auth.resource);
      assert.equal(result.exp, 1900);
      assert.deepEqual(result.motion_permissions, ['motion:read', 'motion:write']);
      assert.equal(result.scope, 'openid');
    }
    for (const changes of [
      { client_id: 'unknown' },
      { client_id: undefined },
      { sub: 'other' },
      { is_anonymous: true },
    ]) {
      const result = await hook({
        ...original,
        ...changes,
        motion_permissions: ['motion:read', 'motion:write'],
      });
      assert.equal(result.aud, 'authenticated');
      assert.equal(result.motion_permissions, undefined);
    }
    assert.equal(
      (await hook(original, 'token_refresh', 'different-user')).motion_permissions,
      undefined
    );
    for (const role of ['anon', 'authenticated']) {
      await db.exec('set role ' + role);
      await assert.rejects(db.query('select * from motion_auth.clients'));
      await assert.rejects(db.query("select motion_auth.access_token_hook('{}')"));
      await db.exec('reset role');
    }
    await db.exec('set role supabase_auth_admin');
    await assert.rejects(
      db.query("update motion_auth.clients set permissions = array['motion:read']")
    );
    await db.exec('reset role');
    await db.query('delete from motion_auth.clients where client_id=$1', [clientId]);
    assert.equal((await hook(original, 'token_refresh')).motion_permissions, undefined);
  } finally {
    await db.close();
  }
});
