import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { Store, hash } from './core/store.js';
import { MotionError } from './core/errors.js';
export interface AuthConfig {
  issuer: string;
  resource: string;
  jwksUrl: string;
  subject: string;
  maxTokenAgeSeconds?: number;
  provider?: 'generic' | 'supabase';
  clients?: Array<{ clientId: string; permissions: string[] }>;
}
/** OAuth resource server; an external authorization server handles login, PKCE and consent. */
export function createVerifier(config: AuthConfig, store: Store, key?: JWTVerifyGetKey) {
  for (const value of [config.issuer, config.resource, config.jwksUrl])
    if (new URL(value).protocol !== 'https:')
      throw new MotionError('configuration', 'OAuth URLs must use HTTPS.');
  if (!config.subject)
    throw new MotionError('configuration', 'A single allowed OAuth subject is required.');
  if (config.provider === 'supabase' && !config.clients?.length)
    throw new MotionError('configuration', 'Supabase requires registered OAuth clients.');
  const resolver = key || createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5000 });
  return async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, resolver, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
        ...(config.maxTokenAgeSeconds ? { maxTokenAge: config.maxTokenAgeSeconds } : {}),
      });
      if (payload.sub !== config.subject || store.isRevoked(payload.jti || hash(token)))
        throw new Error('Denied');
      let scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      if (config.provider === 'supabase') {
        const client = config.clients!.find((item) => item.clientId === payload.client_id);
        if (
          payload.aud !== config.resource ||
          !client ||
          payload.is_anonymous !== false ||
          !Array.isArray(payload.motion_permissions)
        )
          throw new Error('Unregistered client or missing Motion grant');
        scopes = payload.motion_permissions.filter(
          (permission): permission is string =>
            typeof permission === 'string' && client.permissions.includes(permission)
        );
      }
      if (!scopes.includes('motion:read')) throw new Error('No read scope');
      return { subject: payload.sub, scopes, jti: payload.jti || hash(token) };
    } catch {
      throw new MotionError(
        'unauthorized',
        'A valid, unrevoked account token with the required scope is needed.'
      );
    }
  };
}
