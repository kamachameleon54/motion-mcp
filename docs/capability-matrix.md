# Motion capability audit — 2026-09-26

“Documented” describes the public contract, not live verification. A bounded read-only pilot against a real account verified the workspace, user, schedule, status, project and task read shapes. Every legacy tool appears below; unsupported aliases fail explicitly and are omitted from tool discovery.

| Existing tool | Public contract | Repair / disposition |
|---|---|---|
| motion_list_workspaces | Documented GET /v1/workspaces | Unwrap workspaces; paginate; scope filter |
| motion_get_workspace | No individual GET documented | Resolve from documented list |
| motion_list_tasks | Documented GET /v1/tasks | Cursor support; mutually exclusive status filters; bounded full traversal |
| motion_get_task | Documented GET /v1/tasks/{id} | Scope enforcement and scheduling health |
| motion_create_task | Documented POST /v1/tasks | Duration/schedule/routing validation; durable operation record; duplicate scan; readback |
| motion_update_task | Documented PATCH /v1/tasks/{id} | Hydrate required name/workspaceId; preserve null scheduling disable; status and project validation |
| motion_delete_task | Documented DELETE /v1/tasks/{id} | Scope check; durable write; no blind retry |
| motion_move_task | Documented PATCH /v1/tasks/{id}/move takes workspaceId | Legacy projectId call uses task PATCH; separate workspace move tool |
| motion_complete_task | No completed request field | Resolve actual workspace status; ambiguous mappings need explicit status; verify completed readback |
| motion_uncomplete_task | No completed request field | Resolve default nonresolved status; verify readback |
| motion_list_projects | Documented GET /v1/projects | Unwrap projects; paginate; workspace scope |
| motion_get_project | Documented GET /v1/projects/{id} | Verify workspace |
| motion_create_project | Documented POST /v1/projects | Remove unsupported status input; support current fields; durable write |
| motion_update_project | Not in current public catalog | Disabled; do not call speculative PATCH |
| motion_delete_project | Not in current public catalog | Disabled |
| motion_get_current_user | Documented GET /v1/users/me | Verify configured Motion account |
| motion_get_user | No individual GET documented | Resolve within allowed workspace member lists |
| motion_list_users | Documented GET /v1/users | Unwrap users; paginate; scope by workspace |
| motion_get_schedule | Documented GET /v1/schedules | Named working windows and timezone only; reject event/date-range interpretation |
| motion_list_comments | Documented GET /v1/comments | Scope via task; unwrap comments; paginate |
| motion_create_comment | Documented POST /v1/comments | Scope via task; durable write; no blind retry |
| motion_get_comment | Not in public catalog | Disabled; list comments for known task |
| motion_update_comment | Not in public catalog | Disabled |
| motion_delete_comment | Not in public catalog | Disabled |
| motion_list_custom_fields | Documented GET /beta/workspaces/{workspaceId}/custom-fields | Correct beta route and require workspace |
| motion_create_custom_field | Documented POST same route | Correct route; metadata replaces undocumented top-level options |
| motion_add_custom_field_to_task | POST /beta/custom-field-values/task/{taskId} | customFieldInstanceId plus typed value object |
| motion_add_custom_field_to_project | POST /beta/custom-field-values/project/{projectId} | Same contract; project scope |
| motion_remove_custom_field_from_task | DELETE /beta/custom-field-values/task/{taskId}/custom-fields/{valueId} | Require value ID, never substitute a field ID |
| motion_list_recurring_tasks | Documented GET /v1/recurring-tasks | Require workspace; unwrap tasks; paginate |
| motion_create_recurring_task | Documented POST /v1/recurring-tasks | Documented frequency strings; required assignee; scheduling fields |
| motion_get_recurring_task | No individual GET documented | Resolve through scoped lists |
| motion_update_recurring_task | Not in public catalog | Disabled |
| motion_delete_recurring_task | Documented DELETE /v1/recurring-tasks/{id} | Scope via list; durable write |

## Added 2026-10-24

Re-checked against the 27-endpoint public catalog. Every documented endpoint now has a tool; these three had none.

| New tool | Public contract | Notes |
|---|---|---|
| motion_unassign_task | Documented DELETE /v1/tasks/{id}/assignee | Readback after write |
| motion_remove_custom_field_from_project | Documented DELETE /beta/custom-field-values/project/{projectId}/custom-fields/{valueId} | Requires value ID, mirrors the task tool |
| motion_delete_custom_field | Documented DELETE /beta/workspaces/{workspaceId}/custom-fields/{id} | Deletes the definition, not a value |

Recurring tasks: the catalog has create, list and delete only. There is no update endpoint and no way to convert an existing task into a recurring one. Tool descriptions now give the full frequency grammar and tell the model to create a recurring task (then offer to delete the one-off) and to delete and recreate to change one. The legacy stdio build offered `DAILY|WEEKLY|MONTHLY|YEARLY`, which Motion rejects.

## Calendar capabilities

| Capability | Evidence | Connector state |
|---|---|---|
| Named working hours | Public schedules API | Available; not event availability |
| Bookable slots | Booking UI observed in supplied research | No supported programmatic adapter established |
| Busy intervals | No documented endpoint found | Unavailable |
| Meeting titles | Authenticated Motion UI observed in supplied research | No remote event adapter; user-supplied event context supported |
| Direct Microsoft access | No separate authorization established | Not connected |

Calendar title access never blocks task capture. Do not invert bookable slots into busy intervals. No hidden endpoints or desktop-session credentials are used.

## Sources

Reviewed the current [public catalog](https://docs.usemotion.com/), [task creation](https://docs.usemotion.com/api-reference/tasks/post/), [update](https://docs.usemotion.com/api-reference/tasks/patch/), [workspace move](https://docs.usemotion.com/api-reference/tasks/move/), [statuses](https://docs.usemotion.com/api-reference/statuses/get/), [schedules](https://docs.usemotion.com/api-reference/schedules/get/), [custom fields](https://docs.usemotion.com/api-reference/custom-fields/post/), [recurring creation](https://docs.usemotion.com/api-reference/recurring-tasks/post/), [frequency grammar](https://docs.usemotion.com/cookbooks/frequency/) and [limits](https://docs.usemotion.com/cookbooks/rate-limits/). Each other endpoint row maps to its catalog entry. API catalog discovery is not proof private capabilities do not exist.
