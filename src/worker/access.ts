import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AccessConfig {
  teamDomain: string;
  aud: string;
  allowedEmail: string;
}

const TEAM = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUD = /^[0-9a-f]{64}$/;

/** Reads the three Access settings and refuses to run on anything incomplete.
 * jose skips the issuer and audience checks when those options are undefined, so this must fail closed. */
export function parseAccessConfig(env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAIL?: string;
}): AccessConfig {
  const teamDomain = env.ACCESS_TEAM_DOMAIN ?? '';
  const aud = env.ACCESS_AUD ?? '';
  const allowedEmail = env.ACCESS_ALLOWED_EMAIL ?? '';
  if (!TEAM.test(teamDomain)) throw new Error('ACCESS_TEAM_DOMAIN is invalid');
  if (!AUD.test(aud)) throw new Error('ACCESS_AUD is invalid');
  if (!allowedEmail.includes('@')) throw new Error('ACCESS_ALLOWED_EMAIL is invalid');
  return { teamDomain, aud, allowedEmail };
}

const jwksByTeam = new Map<string, JWTVerifyGetKey>();
export function teamKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = jwksByTeam.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain));
    jwksByTeam.set(teamDomain, keys);
  }
  return keys;
}

/** Verifies the Cf-Access-Jwt-Assertion Access forwards after Managed OAuth sign-in.
 * RS256 only; issuer = team domain; audience = this app's AUD tag; email = the one allowed user. */
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  getKey: JWTVerifyGetKey = teamKeys(config.teamDomain)
): Promise<{ email: string }> {
  if (!token) throw new Error('missing token');
  if (!config.teamDomain || !config.aud || !config.allowedEmail)
    throw new Error('incomplete config');
  const { payload } = await jwtVerify(token, getKey, {
    algorithms: ['RS256'],
    issuer: config.teamDomain,
    audience: config.aud,
    requiredClaims: ['exp', 'iat', 'email'],
    clockTolerance: 30,
  });
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  if (!email || email !== config.allowedEmail.toLowerCase()) throw new Error('not allowed');
  return { email };
}
