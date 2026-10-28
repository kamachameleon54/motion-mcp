# Motion MCP

**Say it to Claude or ChatGPT. Find it on your Motion calendar.**

Your commitments come up in conversation: "I'll send that Thursday," "I need to prep for Monday's 1:1," "remind me to chase the vendor." Motion MCP lets your AI assistant turn that sentence into a real, auto-scheduled block of time in [Motion](https://www.usemotion.com), in the right workspace and project, with enough context to pick it up cold. Then it tells you honestly whether the task made it onto your calendar.

One open-source server works with Claude (local) and ChatGPT or any remote MCP client (OAuth), and covers every endpoint in Motion's public API.

## What you can do with it

**Capture the next action before you lose it.** In the middle of drafting an email or planning a project, say "put a 15-minute task on my calendar to send Dana the revised list." The assistant files it in the right workspace and schedule (work hours for work, evenings for personal), with a due date, a link to the source, and a note on who's involved.

**Walk into meetings prepared.** Tell the assistant about your weekly 1:1 or leadership meeting and it can set a prep task due before it starts, sized to the work. If the meeting moves or is canceled, it flags the prep task for review instead of quietly leaving a stale one or creating a duplicate.

**Brief yourself every morning.** Point a scheduled assistant routine at Motion and get a read-only digest of what's overdue, due this week, and in progress, without giving the routine permission to change anything.

**Build agendas from what you're actually carrying.** Meeting-prep workflows can pull open tasks and projects from a single workspace, so a work agenda never shows personal or volunteer items.

**Turn "later" into one task, not a pile.** When you're working through an inbox or a review queue and something needs more time, the assistant offers a single follow-up task. Suggestions wait for your yes, and dismissed ones stay dismissed.

**Keep your lanes separate.** Work, volunteer, and personal workspaces stay apart. Each task lands in the workspace, project, and schedule that match it, and the assistant asks when it isn't sure.

**Chase what others owe you.** When someone owes you a reply, set a short follow-up task due on the day you'll nudge them, using whatever status your workspace uses for waiting.

**Set up rituals that run themselves.** Create recurring tasks (daily, weekly, specific weekdays, monthly patterns) that carry a link to the dashboard, doc, or checklist you use each time.

## Why this one

There are several community Motion MCP servers. This one is built around a question every user eventually asks: *did the assistant actually do it, or just say it did?*

- **Scheduling truth.** Creating a task and scheduling it are reported separately: `scheduled`, `unscheduled`, `past_deadline`, or `outcome_unknown`. The assistant can't tell you a task is on your calendar unless Motion confirms the time blocks.
- **No duplicate tasks.** Every create checks for an existing match first and carries a durable operation key. After a timeout, the same key reconciles the outcome instead of creating a second copy.
- **Context that survives.** Captures carry a purpose, next step, source link, and collaborator, so the task still makes sense two weeks later.
- **Claude and ChatGPT from one core.** Local stdio for Claude Desktop, Claude Code, and Codex; OAuth-protected Streamable HTTP for ChatGPT. Clients that share the server's state store share one rate limit, so two assistants don't double-spend Motion's quota.
- **Honest API coverage.** Every endpoint in Motion's public API has a tool. Operations Motion doesn't document are disabled, not faked.
- **Scoped access.** Read and write are separate OAuth scopes, workspaces and assignees are allow-listed, and your Motion API key never leaves your server.

## Capabilities

| Area | What the assistant can do | Tools |
|---|---|---|
| **Capture** | Create a task with duplicate check, scheduling readback, and resume context | `motion_capture_task` |
| **Tasks: read** | List and filter tasks, get one task, check whether it's scheduled or past due | `motion_list_tasks`, `motion_get_task`, `motion_get_task_health` |
| **Tasks: write** | Create, update, complete, reopen, delete, unassign | `motion_create_task`, `motion_update_task`, `motion_complete_task`, `motion_uncomplete_task`, `motion_delete_task`, `motion_unassign_task` |
| **Tasks: move** | Assign to a project, or move to another workspace | `motion_move_task`, `motion_move_task_workspace` |
| **Schedule** | Auto-schedule into a named working-hours schedule; read schedules and time zones | `motion_get_schedule` |
| **Projects** | List, read, and create projects | `motion_list_projects`, `motion_get_project`, `motion_create_project` |
| **Recurring tasks** | List, create, and delete recurring tasks with Motion's full frequency grammar | `motion_list_recurring_tasks`, `motion_get_recurring_task`, `motion_create_recurring_task`, `motion_delete_recurring_task` |
| **Comments** | Read and add task comments | `motion_list_comments`, `motion_create_comment` |
| **Custom fields** | Define fields and set or clear their values on tasks and projects | `motion_list_custom_fields`, `motion_create_custom_field`, `motion_delete_custom_field`, `motion_add_custom_field_to_task`, `motion_add_custom_field_to_project`, `motion_remove_custom_field_from_task`, `motion_remove_custom_field_from_project` |
| **Meeting prep** | Track prep suggestions and dismissals; review prep when a meeting moves | `motion_record_prep_candidate`, `motion_review_meeting_prep`, `motion_get_calendar_capabilities` |
| **Workspaces and people** | List workspaces, statuses, and users; confirm the signed-in account | `motion_list_workspaces`, `motion_get_workspace`, `motion_list_statuses`, `motion_list_users`, `motion_get_user`, `motion_get_current_user` |

Full mapping to Motion's API, plus the operations deliberately disabled: [capability matrix](docs/capability-matrix.md).

### What it won't do

Motion's public API exposes working hours, not calendar events. This server doesn't read your meetings, book time, send invitations, or use Motion's Office 365 connection. You tell the assistant about a meeting and it plans prep around it. Motion also has no API to edit a recurring task, so changing one means deleting and recreating it; the tools say so instead of pretending.

## Quick start: Claude Desktop

Requires Node.js 24 or newer and a [Motion API key](https://docs.usemotion.com/).

```sh
git clone https://github.com/kamachameleon54/motion-mcp.git
cd motion-mcp
npm ci && npm run build
```

Add the server to Claude Desktop's config, keeping the key out of any tracked file:

```json
{
  "mcpServers": {
    "motion": {
      "command": "node",
      "args": ["/absolute/path/to/motion-mcp/dist/index.js"],
      "env": { "MOTION_API_KEY": "your-key" }
    }
  }
}
```

Restart Claude Desktop and ask: "What's on my Motion list this week?"

For ChatGPT or another remote client, follow the [deployment guide](docs/deployment.md) and [Supabase sign-in](docs/supabase-auth.md). The optional [capture skill](skills/motion-capture/SKILL.md) teaches your assistant good capture habits: one next action at a time, honest durations, no all-day reminders.

## Local development

```sh
npm ci
npm run build
npm test
```

Configure environment variables from `.env.example` using private local or hosting secret storage. Do not paste the Motion key into ChatGPT, tool arguments, an OAuth access token, or a tracked file.

`npm start` runs Claude-compatible stdio. `npm run start:http` runs the authenticated HTTP resource server. Remote startup requires a persistent state path, stable Motion account ID, verified Motion user, allowed workspaces/assignees, and OAuth issuer/JWKS/audience/subject. The HTTP listener defaults to loopback; a production TLS proxy may bind it using `HOST=0.0.0.0`.

**Status:** the stdio server is in daily use with Claude Desktop. The remote HTTP server is tested locally against signed fixture tokens and a real MCP SDK client; a hosted deployment is described in the deployment guide.

## Reliability contract

- Creates carry a durable operation key and a visible marker for reconciliation. Reuse the same key after uncertainty. An uncertain operation stays fenced until its outcome is known; no automatic write retry occurs.
- Active exact-title/project matches are duplicate candidates. Meeting identity also prevents duplicate preparation with a changed title. Semantic similarity is an assistant review task, not an asserted exact match.
- One SQLite store coordinates a rolling per-account quota, shared 429 cooldown, and operation claims across processes on one host. Production uses one instance and persistent volume. All clients must use that service for a shared quota; a separately running stdio process keeps its own limiter unless it shares the same state path.
- Reads use bounded request timeouts and retries. Paginated traversal fails explicitly if incomplete, rather than treating a partial search as proof of no duplicate.
- Task PATCH hydrates required name/workspace fields, preserves omission versus scheduling `null`, resolves actual status names, and reads back. Completion is verified independently of the resolved flag.
- `motion_move_task` retains legacy project-assignment semantics via task PATCH. `motion_move_task_workspace` performs the documented workspace move.
- Tool names backed by undocumented mutations are not advertised and fail explicitly. They are not counted as useful parity.

## Calendar boundary

Named working hours, bookable slots, busy intervals, and meeting titles remain separate. This server has no verified calendar event or booking adapter. It accepts explicitly supplied meeting context, and can review a moved/canceled meeting's prep without changing the task. It does not inherit Motion's Office 365 permissions, use private session tokens, send invitations, or run a watcher.

## Credits

Extends [RF-D/motion-mcp](https://github.com/RF-D/motion-mcp) by Raul Diaz. The original MIT license and attribution remain in `LICENSE`.
