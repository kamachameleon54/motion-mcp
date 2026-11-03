import { DurableObject } from 'cloudflare:workers';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { MotionApiClient } from '../api/client.js';
import { DurableSqlDatabase } from '../core/durable-sqlite.js';
import { Store } from '../core/store.js';
import { createMcpServer } from '../server.js';
import { disabledTools, workerConfig } from './config.js';
import type { WorkerEnv } from './env.js';

/** One instance ("motion") holds the store, so duplicate fences and the quota are shared by every client.
 * Requests can interleave across awaits; the store's check-then-insert steps run inside synchronous
 * transactionSync blocks, which is what keeps them atomic. */
export class MotionObject extends DurableObject<WorkerEnv> {
  private client: MotionApiClient;
  private ownerChecked = false;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.client = new MotionApiClient(
      workerConfig(env),
      new Store(new DurableSqlDatabase(ctx.storage))
    );
  }
  async fetch(request: Request): Promise<Response> {
    if (!this.ownerChecked) {
      // Fail closed if the API key belongs to another Motion account.
      const user = await this.client.getCurrentUser();
      if (user.id !== this.env.MOTION_USER_ID)
        return Response.json({ error: 'server_misconfigured' }, { status: 500 });
      this.ownerChecked = true;
    }
    const server = createMcpServer(
      this.client,
      undefined,
      undefined,
      undefined,
      disabledTools(this.env)
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }
}
