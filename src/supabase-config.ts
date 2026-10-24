import { z } from 'zod';
import type { AuthConfig } from './auth.js';
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search;
  }, 'Use an exact HTTPS URL without query, fragment or credentials.');
export const consentConfigSchema = z
  .object({
    url: httpsUrl.refine((value) => new URL(value).pathname === '/'),
    publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]+$/),
    subject: z.string().uuid(),
    clients: z
      .array(
        z
          .object({
            clientId: z.string().uuid(),
            permissions: z
              .array(z.enum(['motion:read', 'motion:write']))
              .min(1)
              .refine((items) => items.includes('motion:read')),
            redirectUris: z.array(httpsUrl).min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict();
export type ConsentConfig = z.infer<typeof consentConfigSchema>;
export function supabaseConfig(
  env: NodeJS.ProcessEnv,
  auth: AuthConfig
): ConsentConfig | undefined {
  if (env.MCP_AUTH_PROVIDER !== 'supabase') {
    if (env.MCP_AUTH_PROVIDER && env.MCP_AUTH_PROVIDER !== 'generic')
      throw new Error('Unknown authentication provider');
    return undefined;
  }
  const config = consentConfigSchema.parse({
    url: env.SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    subject: auth.subject,
    clients: JSON.parse(env.MCP_SUPABASE_CLIENTS || '[]'),
  });
  const origin = new URL(config.url).origin;
  if (
    auth.issuer !== origin + '/auth/v1' ||
    auth.jwksUrl !== origin + '/auth/v1/.well-known/jwks.json'
  )
    throw new Error('Supabase issuer and signing keys must match the configured project');
  auth.provider = 'supabase';
  auth.clients = config.clients;
  return config;
}
