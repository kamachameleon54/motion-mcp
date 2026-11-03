export const MAX_BODY = 64 * 1024;
export const deny = (status: number) =>
  new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

/** Returns a refusal, or undefined when the request may reach the Durable Object. */
export async function gate(
  request: Request,
  verify: (token: string) => Promise<{ email: string }>
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp') return deny(404);
  if (request.method !== 'POST') {
    const r = deny(405);
    r.headers.set('Allow', 'POST');
    return r;
  }
  // MCP clients call server-to-server; a browser Origin means a web page is trying to use the session.
  if (request.headers.has('origin')) return deny(403);
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return deny(413);
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return deny(403);
  try {
    await verify(token);
  } catch {
    return deny(403);
  }
  return undefined;
}

/** Reads the body with a running byte count, so a chunked upload without Content-Length
 * cannot make the isolate buffer more than MAX_BODY. Returns undefined when over the limit. */
export async function readBody(
  request: Request,
  max = MAX_BODY
): Promise<ArrayBuffer | undefined> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}
