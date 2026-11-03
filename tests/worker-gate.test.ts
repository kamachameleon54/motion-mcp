import test from 'node:test';
import assert from 'node:assert/strict';
import { gate, readBody, MAX_BODY } from '../src/worker/gate.js';

const ok = async () => ({ email: 'owner@example.test' });
const deny = async () => {
  throw new Error('no');
};
const req = (init: RequestInit & { path?: string } = {}) =>
  new Request('https://motion.example.test' + (init.path ?? '/mcp'), {
    method: 'POST',
    headers: {
      'cf-access-jwt-assertion': 'x',
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    body: init.body ?? '{}',
  });

test('other paths are 404', async () => {
  assert.equal((await gate(req({ path: '/' }), ok))?.status, 404);
});
test('non-POST is 405', async () => {
  assert.equal((await gate(new Request('https://motion.example.test/mcp'), ok))?.status, 405);
});
test('browser Origin is refused', async () => {
  assert.equal(
    (await gate(req({ headers: { origin: 'https://evil.example.test' } }), ok))?.status,
    403
  );
});
test('oversized body is refused', async () => {
  assert.equal((await gate(req({ headers: { 'content-length': '70000' } }), ok))?.status, 413);
});
test('missing Access header is refused', async () => {
  const r = new Request('https://motion.example.test/mcp', { method: 'POST', body: '{}' });
  assert.equal((await gate(r, ok))?.status, 403);
});
test('failed verification is refused', async () => {
  assert.equal((await gate(req(), deny))?.status, 403);
});
test('a verified request passes the gate', async () => {
  assert.equal(await gate(req(), ok), undefined);
});
test('a streamed body without content-length stops at the limit', async () => {
  const chunk = new Uint8Array(16 * 1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent > MAX_BODY * 2) c.close();
      else {
        sent += chunk.length;
        c.enqueue(chunk);
      }
    },
  });
  const r = new Request('https://motion.example.test/mcp', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  assert.equal(await readBody(r), undefined);
  assert.ok(sent <= MAX_BODY + 2 * chunk.length, 'stopped reading soon after the limit');
});
test('a small body is read whole', async () => {
  const body = await readBody(
    new Request('https://motion.example.test/mcp', { method: 'POST', body: '{"a":1}' })
  );
  assert.equal(new TextDecoder().decode(body), '{"a":1}');
});
