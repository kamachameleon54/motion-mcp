# Deployment and connection guide

How to host the remote HTTP server for ChatGPT or another remote MCP client. The test suite covers both transports and concurrency; a hosted deployment still needs the live checks below.

## Hosting and acceptance

The reference setup is Render (roughly US$7.25/month at the time of writing: Starter compute plus a 1 GB disk; check current pricing). Any always-on host with a persistent disk works.

The deployment must stay usable while your own computer is off; a laptop tunnel does not meet that bar. Acceptance: from ChatGPT on a phone, create a finite disposable work block, read its actual scheduling, update it and complete it. Mobile account and plugin availability must be tested; hosting success does not prove it. Use a designated disposable workspace or task for live writes.

`render.yaml` specifies the single-instance native Node service and 1 GB persistent disk. The Node runtime avoids relying on an untested local Docker build. CI runs the full test suite with the matching Node version. Deployment is manual until the pilot is complete. Authentication remains fail-closed until a managed provider and the owner's exact identity have been configured.

## Service architecture

Use one Render Node.js 24 service with HTTPS and a 1 GB persistent disk, with Supabase for managed sign-in. The Motion key and operation history stay on Render; Supabase handles login, authorization codes, PKCE and refresh. Keep the single subject allowlist and verified Motion workspace/user scope in the service.

Render's disk permits one attached service instance and a short interruption during deployment. Check the Supabase plan and any extra cost for the project you use. Sources: [Render disks](https://render.com/docs/disks), [Render pricing](https://render.com/pricing).

Supabase OAuth currently supports standard OIDC scopes, not custom Motion scopes. This build therefore requests `openid` while enforcing separate signed `motion_permissions`, the exact resource audience, owner subject, registered client ID and nonanonymous identity. A restricted Postgres access-token hook issues those claims. See [Supabase setup](supabase-auth.md). These provider capabilities and local adapter tests do not prove live tenant configuration or ChatGPT login.

An existing always-on host with persistent local storage can use the same Dockerfile and OAuth resource server. An ephemeral function deployment requires replacing SQLite with a shared durable transactional store before use; copying this build unchanged onto separate serverless instances would break coordinated limits and write claims.

## Exact service configuration

Build: `npm ci && npm run build`. Start: `npm run start:http`. Health path: `/health`. Runtime: Node 24. One instance. Persistent mount: `/var/data`; database: `/var/data/motion/state.sqlite`. Keep the service private to the one authorized OAuth subject even though its HTTPS URL is publicly reachable.

Set these through the host's secret/configuration interface:

| Variable | Value to establish |
|---|---|
| MOTION_API_KEY | Existing authorized key or separately issued server key; server-side only |
| MOTION_ACCOUNT_ID | Stable verified Motion account identity, shared by every serving client |
| MOTION_USER_ID | Verified API owner ID from users/me |
| MOTION_WORKSPACE_IDS | Explicit allowed workspace IDs, comma-separated |
| MOTION_ASSIGNEE_IDS | The owner's verified Motion user ID for the first deployment |
| MOTION_RATE_LIMIT_PER_MINUTE | 12 until the account allowance is verified |
| MOTION_STATE_PATH | /var/data/motion/state.sqlite |
| MOTION_STATUS_MAP | Workspace IDs mapped to verified complete/reopen status names (often Completed and Todo) |
| MCP_RESOURCE_URL | Exact public HTTPS URL ending in /mcp |
| MCP_OAUTH_ISSUER | Exact authorization-server issuer |
| MCP_JWKS_URL | Authorization server's HTTPS signing-key endpoint |
| MCP_ALLOWED_SUBJECT | The owner's exact authenticated subject identifier, not an email heuristic |
| HOST | 0.0.0.0 behind the provider's TLS proxy |
| PORT | Host-assigned port or 8787 |

Do not expose a bootstrap endpoint for changing scope or entering credentials. The source checkout contains no Motion key or production access token. The optional operator script `scripts/live-read-audit.ts` reads the old local configuration only when an explicit source path is supplied; it is not included in the runtime image.

## OAuth authorization server

For Supabase, follow [the Supabase runbook](supabase-auth.md); it includes the consent page and the access-token hook. The generic provider path below remains supported for providers with custom OAuth scopes.

1. Register the MCP resource with identifier equal to `MCP_RESOURCE_URL`. Define `motion:read` and `motion:write` scopes.
2. Configure authorization-code login with PKCE S256. Restrict access to the owner. Disable unnecessary signup paths; the server also checks the exact subject on every request.
3. Register ChatGPT using the exact CIMD/callback information shown for this connection, or an explicitly configured supported registration method. Do not invent a callback URL or use an unrestricted redirect wildcard.
4. Configure RS256 or ES256 JWT access tokens with this issuer/resource audience, subject, issue time, expiry, and scopes. Prefer short expiry and normal refresh/revocation policies. A jti is used if present; otherwise local revocation identifies a token by SHA-256. Motion API keys are never exchanged as MCP access tokens.
5. Publish the authorization server's own discovery metadata. This project publishes protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` and a 401 challenge pointing there. It intentionally delegates login, PKCE, consent, refresh, and code redemption to the managed authorization server.
6. Verify wrong issuer/audience/subject, expiry, revoked identifiers, missing read permission, and write calls with read-only tokens at the deployed URL.

The resource server was tested with signed fixture tokens and a real MCP SDK HTTP client. That does not prove a real provider's registration/login/refresh flow. Current requirements: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## ChatGPT web activation

After the HTTPS endpoint and OAuth flow work, add the remote MCP connection in ChatGPT's supported developer/plugin setup. Supply the public `/mcp` URL and sign in. Verify the connection in a **ChatGPT web** chat, first with `motion_list_workspaces` and `motion_get_calendar_capabilities`, then with a designated disposable task. A local Codex entry or Claude stdio success is not this acceptance check. Current official connection guidance: [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

For a private developer connection, check workspace administrator availability and account permissions in the actual ChatGPT workspace.

## Live task pilot and Claude migration

Use an explicitly designated disposable workspace/task. Create one finite 15-minute block using the actual schedule name/timezone, read it back, adjust its scheduling, complete with a verified status, reopen, and inspect the final result. Check creation versus scheduling health and confirm duplicates are prevented on the same operation key. Do not edit or delete real commitments to test the integration.

Keep the current Claude integration until this succeeds. Then connect Claude to the same remote service via its supported OAuth connection. The included stdio bridge can forward through an operator-supplied OAuth access token for a bounded migration test; it does **not** implement refresh and is not the preferred unattended production connection. Direct local stdio remains supported for standalone use.

The old Claude process does not share the new store or quota. During migration, prevent simultaneous production use until all account traffic is behind the new service. No software can coordinate a still-independent old limiter without changing its integration path. After cutover, test both clients against the same service and use one state store. Never run multiple service replicas with independent copies of the database.

Rollback: remove/disable the new ChatGPT connection and restore the prior Claude connection if it was migrated. Preserve the operation database; don't reset it to “fix” an uncertain write. Do not automatically remove tasks created during real use.

## Operations

Restrict the volume and backups to the service owner. The store contains operation results and preparation state, so treat it as private task data. Back up SQLite consistently using its backup API while running, or stop the service before copying the database; do not copy only a live main database while omitting WAL state. A rollback to an older database may lose operation history; reconcile task markers before any retry.

Use the operator revocation script with an access-token jti or token hash, never a raw token argument. Disabling the allowed subject blocks all that subject's future requests after service reconfiguration. This build does not introspect provider revocation on every request; provider revocation alone may take until access-token expiry unless the token identifier is locally revoked.

No calendar enrichment, scheduler, automatic task-tree generation, or Microsoft account connection is needed to deploy reliable task capture.
