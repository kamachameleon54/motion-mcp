import type { ConsentConfig } from '../src/supabase-config.js';
export function safeRedirect(value: string, allowed: string[]) {
  const url = new URL(value);
  const base = new URL(url);
  base.search = '';
  base.hash = '';
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !allowed.includes(base.href)
  )
    throw new Error('The return address does not match this registered connection.');
  return url.href;
}
export function validateAuthorization(
  config: ConsentConfig,
  subject: string,
  authorizationId: string,
  data: {
    authorization_id: string;
    user: { id: string };
    client: { id: string };
    scope: string;
    redirect_uri: string;
  }
) {
  const client = config.clients.find((item) => item.clientId === data.client.id);
  if (
    subject !== config.subject ||
    data.user.id !== subject ||
    data.authorization_id !== authorizationId ||
    !client
  )
    throw new Error('This account or app is not allowed to connect to Motion.');
  if (data.scope.trim() !== 'openid')
    throw new Error('This app requested unexpected sign-in permissions.');
  if (!client.redirectUris.includes(data.redirect_uri))
    throw new Error('Unexpected return address.');
  safeRedirect(data.redirect_uri, client.redirectUris);
  return client;
}
