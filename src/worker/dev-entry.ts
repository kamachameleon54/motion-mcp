import { createLocalJWKSet, type JWK } from 'jose';
import { verifyAccessToken } from './access.js';
import { gate, deny, readBody } from './gate.js';
import type { WorkerEnv } from './env.js';
export { MotionObject } from './motion-object.js';

/** wrangler dev only (wrangler.dev.jsonc). Never deployed: production uses index.ts, which refuses ACCESS_DEV_JWK. */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!env.ACCESS_DEV_JWK) return deny(500);
    const keys = createLocalJWKSet({ keys: [JSON.parse(env.ACCESS_DEV_JWK) as JWK] });
    const config = { teamDomain: 'http://localhost', aud: 'local', allowedEmail: 'dev@localhost' };
    const refused = await gate(request, (token) => verifyAccessToken(token, config, keys));
    if (refused) return refused;
    const body = await readBody(request);
    if (!body) return deny(413);
    const stub = env.MOTION.get(env.MOTION.idFromName('motion'));
    const response = await stub.fetch(
      new Request(request.url, { method: 'POST', headers: request.headers, body })
    );
    const tagged = new Response(response.body, response);
    tagged.headers.set('x-motion-entry', 'dev-only-verifier');
    return tagged;
  },
} satisfies ExportedHandler<WorkerEnv>;
