import { parseAccessConfig, verifyAccessToken } from './access.js';
import { gate, deny, readBody } from './gate.js';
import type { WorkerEnv } from './env.js';
export { MotionObject } from './motion-object.js';

/** Production entry. It never reads ACCESS_DEV_JWK and refuses to run if it is set. */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (env.ACCESS_DEV_JWK) return deny(500); // a dev key must never reach a deployed Worker
    let access;
    try {
      access = parseAccessConfig(env);
    } catch {
      return deny(500);
    }
    const refused = await gate(request, (token) => verifyAccessToken(token, access));
    if (refused) return refused;
    const body = await readBody(request);
    if (!body) return deny(413);
    const stub = env.MOTION.get(env.MOTION.idFromName('motion'));
    return stub.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body }));
  },
} satisfies ExportedHandler<WorkerEnv>;
