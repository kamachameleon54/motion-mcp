#!/usr/bin/env node
import { getConfig } from './config.js';
import { MotionApiClient } from './api/client.js';
import { createVerifier } from './auth.js';
import { supabaseConfig } from './supabase-config.js';
import { createHttpApp } from './http-app.js';
async function main() {
  const config = getConfig();
  if (
    !config.allowedWorkspaceIds?.length ||
    !config.allowedAssigneeIds?.length ||
    !config.expectedUserId ||
    !config.statePath ||
    !config.accountId
  )
    throw new Error('Remote scope and state configuration required');
  const auth = {
    issuer: process.env.MCP_OAUTH_ISSUER!,
    resource: process.env.MCP_RESOURCE_URL!,
    jwksUrl: process.env.MCP_JWKS_URL!,
    subject: process.env.MCP_ALLOWED_SUBJECT!,
  };
  if (new URL(auth.resource).pathname !== '/mcp') throw new Error('Resource URL must end /mcp');
  const consent = supabaseConfig(process.env, auth);
  const client = new MotionApiClient(config);
  const verify = createVerifier(auth, client.store);
  await client.getCurrentUser(); // Fail closed if a server secret belongs to another Motion account.
  const app = createHttpApp(client, auth, verify, consent);
  const listener = app.listen(
    Number(process.env.PORT || 8787),
    process.env.HOST || '127.0.0.1',
    () => console.error('Authenticated Motion MCP is listening.')
  );
  listener.requestTimeout = 30000;
  listener.headersTimeout = 10000;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () =>
      listener.close(() => {
        client.close();
        process.exit(0);
      })
    );
}
main().catch(() => {
  console.error('Remote Motion MCP failed startup validation. Check scoped server configuration.');
  process.exitCode = 1;
});
