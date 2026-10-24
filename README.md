# Motion MCP: shared Claude and ChatGPT core

An MCP server for [Motion](https://www.usemotion.com) that serves Claude over local stdio and ChatGPT (or any MCP client) over OAuth-protected Streamable HTTP, from one shared Motion API core. It extends [RF-D/motion-mcp](https://github.com/RF-D/motion-mcp) by Raul Diaz; the original MIT license and attribution remain in `LICENSE`.

This build captures finite next actions, preserves resume context, checks duplicates, and reports task creation separately from scheduling health. It retains Claude stdio and adds an OAuth-protected Streamable HTTP resource server for hosted ChatGPT.

**Status:** the stdio server is in daily use with Claude Desktop. The remote HTTP server is tested locally against signed fixture tokens and a real MCP SDK client; a hosted deployment is described in the deployment guide. Every endpoint in Motion's public API catalog has a tool; see the capability matrix.

- [Capability matrix](docs/capability-matrix.md): every tool mapped to Motion's public API, plus the operations deliberately disabled.
- [Deployment guide](docs/deployment.md): persistent service, OAuth setup, ChatGPT connection, and migration.
- [Supabase sign-in](docs/supabase-auth.md): private consent page, restricted token hook, and setup checks.
- [Capture/preparation skill](skills/motion-capture/SKILL.md): portable instructions for assistants using this server.

## Local development

Requires Node.js 24 or newer (uses built-in SQLite):

```sh
npm ci
npm run build
npm test
```

Configure environment variables from `.env.example` using private local or hosting secret storage. Do not paste the Motion key into ChatGPT, tool arguments, an OAuth access token, or a tracked file.

`npm start` runs Claude-compatible stdio. `npm run start:http` runs the authenticated HTTP resource server. Remote startup requires a persistent state path, stable Motion account ID, verified Motion user, allowed workspaces/assignees, and OAuth issuer/JWKS/audience/subject. The HTTP listener defaults to loopback; a production TLS proxy may bind it using `HOST=0.0.0.0`.

The companion skill in `skills/` is optional; install it in your assistant if you want its capture and preparation guidance.

## Reliability contract

- Creates carry a durable operation key and a visible marker for reconciliation. Reuse the same key after uncertainty. An uncertain operation stays fenced until its outcome is known; no automatic write retry occurs.
- Active exact-title/project matches are duplicate candidates. Meeting identity also prevents duplicate preparation with a changed title. Semantic similarity is an assistant review task, not an asserted exact match.
- One SQLite store coordinates a rolling per-account quota, shared 429 cooldown, and operation claims across processes on one host. Production uses one instance and persistent volume. All clients must use that service for a shared quota; a separately running stdio process keeps its own limiter unless it shares the same state path.
- Reads use bounded request timeouts and retries. Paginated traversal fails explicitly if incomplete, rather than treating a partial search as proof of no duplicate.
- Task PATCH hydrates required name/workspace fields, preserves omission versus scheduling `null`, resolves actual status names, and reads back. Completion is verified independently of the resolved flag.
- `motion_move_task` retains legacy project-assignment semantics via task PATCH. `motion_move_task_workspace` performs the documented workspace move.
- Tool names backed by undocumented mutations are not advertised and fail explicitly. They are not counted as useful parity.

## Calendar boundary

Named working hours, bookable slots, busy intervals, and meeting titles remain separate. This server has no verified calendar event or booking adapter. It accepts explicitly supplied meeting context, and can review a moved/canceled meeting’s prep without changing the task. It does not inherit Motion's Office 365 permissions, use private session tokens, send invitations, or run a watcher.
