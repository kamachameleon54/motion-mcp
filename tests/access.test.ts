import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { parseAccessConfig, verifyAccessToken } from '../src/worker/access.js';

const team = 'https://team.cloudflareaccess.com';
const aud = 'a'.repeat(64);
const email = 'owner@example.test';
const keys = await generateKeyPair('RS256');
const getKey: JWTVerifyGetKey = async () => keys.publicKey;
const sign = (
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string | string[]; exp?: string; key?: CryptoKey } = {}
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(opts.iss ?? team)
    .setAudience(opts.aud ?? aud)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? keys.privateKey);
const cfg = { teamDomain: team, aud, allowedEmail: email };
const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ACCESS_ALLOWED_EMAIL: email };

test('config: accepts a complete env', () => {
  assert.deepEqual(parseAccessConfig(env), cfg);
});
test('config: refuses an empty or missing AUD', () => {
  assert.throws(() => parseAccessConfig({ ...env, ACCESS_AUD: '' }));
  assert.throws(() => parseAccessConfig({ ...env, ACCESS_AUD: undefined as never }));
  assert.throws(() => parseAccessConfig({ ...env, ACCESS_AUD: 'short' }));
});
test('config: refuses a non-Access or plain-http team domain', () => {
  assert.throws(() => parseAccessConfig({ ...env, ACCESS_TEAM_DOMAIN: 'http://localhost' }));
  assert.throws(() =>
    parseAccessConfig({ ...env, ACCESS_TEAM_DOMAIN: 'https://evil.example.test' })
  );
});
test('config: refuses an email without @', () => {
  assert.throws(() => parseAccessConfig({ ...env, ACCESS_ALLOWED_EMAIL: '' }));
});

test('accepts the owner', async () => {
  assert.equal((await verifyAccessToken(await sign({ email }), cfg, getKey)).email, email);
});
test('email match ignores case', async () => {
  assert.equal(
    (await verifyAccessToken(await sign({ email: 'Owner@Example.test' }), cfg, getKey)).email,
    email
  );
});
test('rejects another email', async () => {
  await assert.rejects(verifyAccessToken(await sign({ email: 'x@example.test' }), cfg, getKey));
});
test('rejects a missing email claim', async () => {
  await assert.rejects(verifyAccessToken(await sign({}), cfg, getKey));
});
test('rejects the wrong audience', async () => {
  await assert.rejects(verifyAccessToken(await sign({ email }, { aud: 'other' }), cfg, getKey));
});
test('rejects the wrong issuer', async () => {
  await assert.rejects(
    verifyAccessToken(await sign({ email }, { iss: 'https://evil.example.test' }), cfg, getKey)
  );
});
test('rejects an expired token', async () => {
  await assert.rejects(verifyAccessToken(await sign({ email }, { exp: '-1m' }), cfg, getKey));
});
test('rejects an HS256 token signed with the public key text', async () => {
  const forged = await new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(team)
    .setAudience(aud)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode('not-the-key'));
  await assert.rejects(verifyAccessToken(forged, cfg, getKey));
});
test('rejects an empty or garbage token', async () => {
  await assert.rejects(verifyAccessToken('', cfg, getKey));
  await assert.rejects(verifyAccessToken('a.b.c', cfg, getKey));
});
test('rejects a token signed by a different key pair', async () => {
  const other = await generateKeyPair('RS256');
  await assert.rejects(
    verifyAccessToken(await sign({ email }, { key: other.privateKey }), cfg, getKey)
  );
});
test('rejects an unsigned alg:none token', async () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const none = `${b64({ alg: 'none' })}.${b64({ email, iss: team, aud, iat: now, exp: now + 300 })}.`;
  await assert.rejects(verifyAccessToken(none, cfg, getKey));
});
test('rejects a token whose aud list does not include this app', async () => {
  await assert.rejects(
    verifyAccessToken(await sign({ email }, { aud: ['b'.repeat(64), 'c'.repeat(64)] }), cfg, getKey)
  );
});
test('rejects a token that is not yet valid', async () => {
  const early = await new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(team)
    .setAudience(aud)
    .setIssuedAt()
    .setNotBefore('10m')
    .setExpirationTime('20m')
    .sign(keys.privateKey);
  await assert.rejects(verifyAccessToken(early, cfg, getKey));
});
test('rejects a token without exp', async () => {
  const noExp = await new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(team)
    .setAudience(aud)
    .setIssuedAt()
    .sign(keys.privateKey);
  await assert.rejects(verifyAccessToken(noExp, cfg, getKey));
});
test('refuses to verify with an empty audience in config', async () => {
  await assert.rejects(verifyAccessToken(await sign({ email }), { ...cfg, aud: '' }, getKey));
});
