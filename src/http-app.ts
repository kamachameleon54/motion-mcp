import express from 'express';
import { fileURLToPath } from 'node:url';
import { consentConfigSchema, type ConsentConfig } from './supabase-config.js';
import type { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MotionApiClient } from './api/client.js';
import { createMcpServer } from './server.js';
import type { AuthConfig } from './auth.js';
export function createHttpApp(
  client: MotionApiClient,
  auth: AuthConfig,
  verify: (token: string) => Promise<{ scopes: string[] }>,
  consent?: ConsentConfig
) {
  const app = express();
  app.disable('x-powered-by');
  const oauthScopes = auth.provider === 'supabase' ? ['openid'] : ['motion:read', 'motion:write'];
  const resource = new URL(auth.resource);
  const metadataURL = resource.origin + '/.well-known/oauth-protected-resource' + resource.pathname;
  // Host is checked without trusting arbitrary forwarded headers. Reverse proxy preserves public Host.
  app.use((req, res, next) => {
    if (req.headers.host !== resource.host && !['127.0.0.1', 'localhost'].includes(req.hostname)) {
      res.status(421).json({ error: 'invalid_host' });
      return;
    }
    if (req.headers.origin && req.headers.origin !== resource.origin) {
      res.status(403).json({ error: 'invalid_origin' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get(
    ['/\.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
    (_req, res) =>
      res.json({
        resource: auth.resource,
        authorization_servers: [auth.issuer],
        scopes_supported: oauthScopes,
        bearer_methods_supported: ['header'],
      })
  );
  if (consent) {
    const publicConfig = consentConfigSchema.parse(consent);
    app.use('/oauth', (_req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${new URL(publicConfig.url).origin}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
      );
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      next();
    });
    app.get('/oauth/config', (_req, res) => res.json(publicConfig));
    const assets = fileURLToPath(new URL('../dist/web/', import.meta.url));
    app.get('/oauth/consent', (_req, res) => res.sendFile('consent.html', { root: assets }));
    app.use('/oauth/assets', express.static(assets, { index: false, dotfiles: 'deny' }));
  }
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/mcp', async (req, res, next) => {
    const match = req.headers.authorization?.match(/^Bearer ([^\s]+)$/);
    try {
      if (!match) throw new Error();
      res.locals.identity = await verify(match[1]!);
      next();
    } catch {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${metadataURL}", scope="${oauthScopes.join(' ')}"`
      );
      res.status(401).json({ error: 'unauthorized' });
    }
  });
  app.use('/mcp', express.json({ limit: '64kb' }));
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer(
      client,
      res.locals.identity.scopes,
      metadataURL,
      auth.provider === 'supabase' ? oauthScopes : undefined
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' });
    }
  });
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
  });
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: 'invalid_request' });
  });
  return app;
}
