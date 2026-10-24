# Private Supabase sign-in for Motion

Supabase can act as the OAuth authorization server for a single-owner deployment. The adapter and consent page are implemented and tested locally against a real Postgres instance.

## Access model

Render hosts `/mcp`, `/oauth/consent`, and the sign-in assets. Supabase hosts the OAuth authorization server. The browser uses only a Supabase **publishable** key. The Motion key never reaches Supabase or the browser. No Supabase secret/service-role key is needed by the running Motion service.

Supabase's standard access-token audience is `authenticated`; that token is rejected by Motion. Custom OAuth scopes are currently unsupported, so discovery and tool metadata request `openid`. Motion access is enforced independently through:

- Exact Supabase issuer and asymmetric RS256/ES256 signature.
- Audience equal to this service's full HTTPS `/mcp` URL, without additional audiences.
- Exact allowed Supabase subject, a registered OAuth `client_id`, and `is_anonymous: false`.
- A top-level, server-issued `motion_permissions` array containing `motion:read`, with `motion:write` additionally required for mutations. The runtime configuration can narrow those permissions further.
- Expiry, issue time and local token revocation.

Neither OIDC `openid` nor `user_metadata` grants Motion access. Generic OAuth providers retain their existing `motion:read`/`motion:write` scope path. Claude stdio is unchanged.

## Project setup

1. Identify the intended project in your Supabase account. Inspect its plan, existing Auth users, Site URL and access-token hook before making changes. Prefer an isolated project when changing an existing app would disrupt it; confirm any additional project cost before creating it. A free project may pause when inactive, so verify the account's availability requirements as well as its billing.
2. Use asymmetric signing keys and enable OAuth 2.1 Server. Keep dynamic client registration disabled for this private integration. Register the exact ChatGPT callback shown in the user's connection UI; no wildcard callbacks. A manually registered confidential client is supported by ChatGPT's connection setup, but that path still requires actual account verification.
3. Set the Site URL to the Render origin and Authorization Path to `/oauth/consent`. Add the exact consent path to allowed email redirect URLs. Create or designate only the owner's app user, record the user UUID, and disable public signups. The Supabase dashboard account is distinct from this app user. The consent page uses email magic-link login with `shouldCreateUser: false`; it never collects the Supabase dashboard password.
4. Verify mail delivery. Supabase's default mail provider is limited to organization members and rate-limited. New free projects cannot customize its email templates; this implementation uses the default magic link and does not require template changes. Configure existing SMTP only if needed and authorized; no SMTP account or recurring cost is assumed.
5. Review `supabase/motion-auth.sql`, which creates only an empty private allowlist and restricted hook. Install it in the designated project, review advisors, and then configure `motion_auth.access_token_hook` as the Custom Access Token hook. Do not replace a pre-existing hook without composing its responsibilities deliberately. The hook is `security invoker`, its schema is not exposed through the Data API, and only `supabase_auth_admin` can read the allowlist/call the hook. Anonymous and authenticated users cannot modify it.
6. Insert the one registered client, exact owner user UUID, exact Render `/mcp` audience, and chosen permission array into `motion_auth.clients` using parameterized SQL. No production identity or client ID is checked into this file. The hook rechecks the registration for code exchange and refresh, preserves required Supabase claims, and limits Motion token validity to at most 15 minutes.
7. Set these Render variables using provider secret settings:

| Variable | Value |
|---|---|
| MCP_AUTH_PROVIDER | supabase |
| SUPABASE_URL | https://<project-ref>.supabase.co |
| SUPABASE_PUBLISHABLE_KEY | sb_publishable_...; safe for browser use |
| MCP_OAUTH_ISSUER | https://<project-ref>.supabase.co/auth/v1 |
| MCP_JWKS_URL | https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json |
| MCP_ALLOWED_SUBJECT | Exact designated app-user UUID |
| MCP_RESOURCE_URL | Exact public Render URL ending /mcp |
| MCP_SUPABASE_CLIENTS | JSON array of clientId, permissions, and exact redirectUris; must match the registration and hook row |

The service fails startup for missing registrations, secret keys supplied as publishable keys, or mismatched project/issuer/JWKS. Sign-in configuration is public by design and contains no API secret. The consent page validates the user, client, requested OIDC scope and callback before approval, renders text safely, denies framing, and loads a locally bundled pinned Supabase SDK.

## Deployment acceptance

First validate provider discovery and the public key endpoint. Then complete actual email login, consent, ChatGPT code exchange and refresh with PKCE. Verify the live signed token's audience/client/subject/grant **without logging the raw token**. Confirm another user, unregistered client and ordinary project token cannot call Motion. Verify read-only grants cannot mutate even if `scope` claims otherwise. Removing a hook registration prevents new Motion grants at refresh; already issued access tokens remain valid until expiry unless locally revoked or rejected by the runtime allowlist.

The consent page and hook do not guarantee mobile support. Finish the ChatGPT web pilot and a phone pilot with the laptop off. Live writes require a designated disposable task/workspace. Use the same operation key after an uncertain write and read back actual scheduling.

## Verification and sources

Local validation: typecheck, browser bundle, 47 tests including the actual hook in embedded Postgres, and production dependency audit. The local hook tests do not validate the deployed Supabase Auth hook invocation or end-to-end PKCE. Browser access is restored. The existing TempoMKT organization is on the Free plan. An isolated `motion-chatgpt-login` project form is prepared with Data API disabled, but no password has been entered and the project has not been created. Existing projects remain unchanged.

Current official references: [OAuth setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started), [supported scopes and refresh](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows), [resource audiences and custom token hooks](https://supabase.com/docs/guides/auth/oauth-server/token-security), [hook claim contract](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook), [hook grants](https://supabase.com/docs/guides/auth/auth-hooks), [free-tier email template change](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier), [OpenAI authentication](https://developers.openai.com/plugins/build/auth).
