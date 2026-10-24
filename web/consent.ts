import { createClient } from '@supabase/supabase-js';
import type { ConsentConfig } from '../src/supabase-config.js';
import { safeRedirect, validateAuthorization } from './consent-policy.js';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = element('message');
const login = element<HTMLFormElement>('login');
const section = element('consent');
const signout = element<HTMLButtonElement>('signout');
async function main() {
  const authorizationId = new URL(location.href).searchParams.get('authorization_id');
  if (!authorizationId || !/^[A-Za-z0-9_-]{8,256}$/.test(authorizationId))
    throw new Error('Start this connection from ChatGPT, then return here to sign in.');
  const response = await fetch('/oauth/config', {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Sign-in is not configured yet.');
  const config: ConsentConfig = await response.json();
  const supabase = createClient(config.url, config.publishableKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    global: {
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }),
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    login.hidden = false;
    message.textContent = 'Sign in to approve your Motion connection.';
    login.onsubmit = async (event) => {
      event.preventDefault();
      const button = login.querySelector('button')!;
      button.disabled = true;
      try {
        const email = element<HTMLInputElement>('email').value.trim();
        const callback = new URL('/oauth/consent', location.origin);
        callback.searchParams.set('authorization_id', authorizationId);
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false, emailRedirectTo: callback.href },
        });
        if (error)
          throw new Error('Could not send the sign-in link. Check the email and try again later.');
        message.textContent = 'Check your email and open the sign-in link in this browser.';
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
      }
    };
    return;
  }
  signout.hidden = false;
  signout.onclick = async () => {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) {
      showError(new Error('Could not sign out. Try again.'));
      return;
    }
    location.replace('/oauth/consent?authorization_id=' + encodeURIComponent(authorizationId));
  };
  if (user.id !== config.subject)
    throw new Error(
      'This account does not have access to this private Motion connection. Sign out and use the designated account.'
    );
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data)
    throw new Error('This connection request has expired or is invalid. Start again from ChatGPT.');
  const redirect = (url: string, allowed: string[]) => location.assign(safeRedirect(url, allowed));
  if ('redirect_url' in data) {
    redirect(
      data.redirect_url,
      config.clients.flatMap((client) => client.redirectUris)
    );
    return;
  }
  const client = validateAuthorization(config, user.id, authorizationId, data);
  message.textContent = 'Review what this connection can do.';
  element('client').textContent = data.client.name + ' requests access';
  element('identity').textContent = 'Signed in as ' + (user.email || 'your private account');
  const permissions = element('permissions');
  for (const description of [
    'Read your allowed Motion workspaces, projects and tasks.',
    ...(client.permissions.includes('motion:write')
      ? [
          'Create and change tasks, projects, comments, recurring tasks and custom fields in those workspaces. This includes completing, moving and deleting tasks.',
        ]
      : []),
  ]) {
    const item = document.createElement('li');
    item.textContent = description;
    permissions.append(item);
  }
  section.hidden = false;
  for (const action of ['approve', 'deny'] as const) {
    element<HTMLButtonElement>(action).onclick = async () => {
      const buttons = [...section.querySelectorAll('button')];
      buttons.forEach((button) => {
        button.disabled = true;
      });
      try {
        const result =
          action === 'approve'
            ? await supabase.auth.oauth.approveAuthorization(authorizationId, {
                skipBrowserRedirect: true,
              })
            : await supabase.auth.oauth.denyAuthorization(authorizationId, {
                skipBrowserRedirect: true,
              });
        if (result.error || !result.data)
          throw new Error('Could not complete the connection. Start again from ChatGPT.');
        redirect(result.data.redirect_url, client.redirectUris);
      } catch (error) {
        showError(error);
        buttons.forEach((button) => {
          button.disabled = false;
        });
      }
    };
  }
}
function showError(error: unknown) {
  message.textContent =
    error instanceof Error
      ? error.message
      : 'Could not complete sign-in. Please start again from ChatGPT.';
}
void main().catch(showError);
