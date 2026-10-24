import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MotionApiClient, validFrequency } from '../src/api/client.js';
import { normalizeDuration } from '../src/types/duration.js';
import {
  captureTask,
  schedulingHealth,
  calendarCapabilities,
  reviewMeetingPrep,
} from '../src/core/capture.js';
import { Store } from '../src/core/store.js';
import { fixture, task, captureInput, future } from './fixture.js';
const now = new Date('2030-04-20T00:00:00Z');
const make = () => {
  const f = fixture();
  return { ...f, client: new MotionApiClient(f.config) };
};
const rejected = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: any) => e.code === code);

test('durations validate numbers and strings equally', () => {
  for (const v of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', '-2', '1.5', ''])
    assert.throws(() => normalizeDuration(v));
  assert.equal(normalizeDuration('60'), 60);
  assert.equal(normalizeDuration(15), 15);
  assert.equal(normalizeDuration('reminder'), 'REMINDER');
});
test('observed expense / short admin request becomes finite work, not all-day reminder', async () => {
  const f = make();
  const result = await captureTask(f.client, captureInput, now);
  assert.equal(result.scheduling?.state, 'scheduled');
  const body = f.calls.find((c) => c.method === 'POST')!.body;
  assert.equal(body.duration, 15);
  assert.equal(body.autoScheduled.schedule, 'Work Hours');
  assert.equal(result.schedule?.timeZone, 'America/Los_Angeles');
  f.client.close();
});
test('observed one-hour initial skill slice preserves source, collaborator and scope', async () => {
  const f = make();
  await captureTask(
    f.client,
    {
      ...captureInput,
      operationKey: 'skill-user-request',
      name: 'Draft the initial BD call workflow',
      durationMinutes: 60,
      nextStep: 'Review research notes and consult Alex on the first section',
      collaborator: 'Alex',
      sourceReference: 'doc:research-notes',
    },
    now
  );
  const created = [...f.tasks.values()][0]!;
  assert.equal(created.duration, 60);
  assert.match(created.description, /Alex/);
  assert.match(created.description, /doc:research-notes/);
  assert.equal(f.tasks.size, 1);
  f.client.close();
});
test('observed independent report-layout and onboarding-guide outcomes stay separate', async () => {
  const f = make();
  for (const [i, name] of ['Review report layout', 'Outline onboarding guide'].entries())
    await captureTask(
      f.client,
      { ...captureInput, operationKey: 'independent-outcome-' + i, name },
      now
    );
  assert.equal(f.tasks.size, 2);
  assert.equal(f.calls.filter((c) => c.path === '/v1/projects' && c.method === 'POST').length, 0);
  f.client.close();
});
test('appointment booking cap rejects more than 15; stated hour remains allowed for work', async () => {
  const f = make();
  await rejected(
    captureTask(
      f.client,
      { ...captureInput, kind: 'appointment_booking', durationMinutes: 30 },
      now
    ),
    'duration_cap'
  );
  assert.equal(f.calls.length, 0);
  f.client.close();
});
test('agent generated content cannot be submitted as observed user instruction', async () => {
  const f = make();
  await assert.rejects(
    captureTask(
      f.client,
      {
        ...captureInput,
        requestEvidence: { kind: 'agent_generated', reference: 'assistant-plan' },
      },
      now
    )
  );
  assert.equal(f.calls.length, 0);
  f.client.close();
});
test('same operation readbacks without duplicate and changed payload conflicts', async () => {
  const f = make();
  await captureTask(f.client, captureInput, now);
  await captureTask(f.client, captureInput, now);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  await rejected(
    captureTask(f.client, { ...captureInput, durationMinutes: 30 }, now),
    'operation_key_conflict'
  );
  f.client.close();
});
test('different operation key still checks active duplicate candidates', async () => {
  const f = make();
  await captureTask(f.client, captureInput, now);
  await rejected(
    captureTask(f.client, { ...captureInput, operationKey: 'different-prompt' }, now),
    'duplicate_candidate'
  );
  assert.equal(f.tasks.size, 1);
  f.client.close();
});
test('timeout after create reconciles a persisted marker', async () => {
  const f = make();
  let posts = 0;
  f.setHook(async (c) => {
    if (c.method === 'POST' && c.path === '/v1/tasks') {
      posts++;
      f.tasks.set('created', task({ ...c.body, id: 'created' }));
      throw new Error('connection lost');
    }
    return undefined;
  });
  const result = await captureTask(f.client, captureInput, now);
  assert.equal(result.taskId, 'created');
  assert.equal(posts, 1);
  f.client.close();
});
test('uncertain create remains fenced across process-store restart', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'motion-state-'));
  f.config.statePath = join(dir, 'state.sqlite');
  let posts = 0;
  f.setHook(async (c) => {
    if (c.method === 'POST') {
      posts++;
      throw new Error('timeout');
    }
    return undefined;
  });
  const first = new MotionApiClient(f.config);
  await rejected(captureTask(first, captureInput, now), 'outcome_unknown');
  first.close();
  const second = new MotionApiClient(f.config);
  await rejected(captureTask(second, captureInput, now), 'outcome_unknown');
  assert.equal(posts, 1);
  second.close();
  rmSync(dir, { recursive: true });
});
test('pagination scans later pages before declaring no duplicates', async () => {
  const f = make();
  f.setHook(async (c) =>
    c.path === '/v1/tasks' && c.method === 'GET'
      ? new Response(
          JSON.stringify(
            c.query.has('cursor')
              ? { tasks: [task()], meta: {} }
              : { tasks: [], meta: { nextCursor: 'second' } }
          )
        )
      : undefined
  );
  await rejected(captureTask(f.client, captureInput, now), 'duplicate_candidate');
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
  f.client.close();
});
test('repeated cursor is incomplete, not an empty successful search', async () => {
  const f = make();
  f.setHook(async (c) =>
    c.path === '/v1/tasks'
      ? new Response(JSON.stringify({ tasks: [], meta: { nextCursor: 'loop' } }))
      : undefined
  );
  await rejected(captureTask(f.client, captureInput, now), 'pagination_incomplete');
  f.client.close();
});
test('task update hydrates name/workspace and preserves explicit null versus omission', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  await f.client.updateTask('task_1', { autoScheduled: null, projectId: 'project_1' });
  const body = f.calls.find((c) => c.method === 'PATCH')!.body;
  assert.equal(body.name, 'Prepare expenses');
  assert.equal(body.workspaceId, 'work');
  assert.equal(body.autoScheduled, null);
  assert.equal(body.projectId, 'project_1');
  assert.ok(!('completed' in body));
  f.client.close();
});
test('scheduling update exposes real schedule with due date hydration', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  await f.client.updateTask('task_1', { autoScheduled: { schedule: 'Work Hours' }, duration: 30 });
  assert.equal(f.calls.find((c) => c.method === 'PATCH')!.body.dueDate, future);
  f.client.close();
});
test('completion requires explicit verified mapping and uses status, never completed request field', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  await rejected(f.client.setCompleted('task_1', true), 'status_mapping_required');
  const result = await f.client.setCompleted('task_1', true, 'Finished');
  assert.equal(result.completed, true);
  assert.equal(f.calls.find((c) => c.method === 'PATCH')!.body.status, 'Finished');
  assert.ok(!('completed' in f.calls.find((c) => c.method === 'PATCH')!.body));
  await f.client.setCompleted('task_1', false, 'Ready');
  assert.equal(f.tasks.get('task_1')!.completed, false);
  f.client.close();
});
test('resolved cancelled status is not falsely reported as completed', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  const result: any = await f.client.setCompleted('task_1', true, 'Cancelled');
  assert.equal(result._motion.completionVerified, false);
  f.client.close();
});
test('project assignment uses task PATCH and workspace move uses move payload', async () => {
  const f = fixture();
  f.config.allowedWorkspaceIds = ['work', 'private'];
  const client = new MotionApiClient(f.config);
  f.tasks.set('task_1', task());
  await client.moveTask('task_1', 'project_1');
  await client.moveTaskWorkspace('task_1', 'private');
  const patches = f.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches[0]!.path, '/v1/tasks/task_1');
  assert.equal(patches[1]!.body.workspaceId, 'private');
  assert.ok(!('projectId' in patches[1]!.body));
  client.close();
});
test('cross-workspace data and routing are denied', async () => {
  const f = make();
  f.tasks.set(
    'private_task',
    task({ id: 'private_task', workspace: { ...task().workspace, id: 'private' } })
  );
  await rejected(f.client.getTask('private_task'), 'scope_denied');
  await rejected(
    f.client.createTask({ name: 'Bad route', workspaceId: 'work', projectId: 'wrong' }),
    'scope_denied'
  );
  await rejected(f.client.listTasks(), 'workspace_required');
  assert.deepEqual(
    (await f.client.listWorkspaces()).map((w) => w.id),
    ['work']
  );
  f.client.close();
});
test('rate limit reservations and 429 cooldown are shared by independent clients', () => {
  const dir = mkdtempSync(join(tmpdir(), 'motion-quota-'));
  const a = new Store(join(dir, 'state.sqlite')),
    b = new Store(join(dir, 'state.sqlite'));
  assert.equal(a.reserve('account', 2, 1000), 0);
  assert.equal(b.reserve('account', 2, 1000), 0);
  assert.equal(a.reserve('account', 2, 1000), 60000);
  assert.equal(b.reserve('account', 2, 61000), 0);
  a.cooldown('another', 5000);
  assert.ok(b.reserve('another', 12) > 4000);
  a.close();
  b.close();
  rmSync(dir, { recursive: true });
});
test('429 read gets bounded retry and honors shared Retry-After', async () => {
  const f = make();
  let reads = 0;
  f.setHook(async (c) => {
    if (c.path === '/v1/users/me') {
      reads++;
      return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } });
    }
    return undefined;
  });
  await rejected(f.client.getCurrentUser(), 'rate_limit_wait');
  assert.equal(reads, 1);
  f.client.close();
});
test('scheduling readback distinguishes unscheduled, insufficient time, overdue, and reminders', () => {
  assert.equal(
    schedulingHealth(task({ scheduledStart: undefined, scheduledEnd: undefined }), now).state,
    'unscheduled'
  );
  assert.equal(schedulingHealth(task({ duration: 60 }), now).state, 'unscheduled');
  assert.equal(
    schedulingHealth(task({ dueDate: '2030-04-22T08:30:00-07:00' }), now).state,
    'past_deadline'
  );
  assert.equal(schedulingHealth(task({ duration: 'REMINDER' }), now).state, 'reminder_only');
  assert.equal(
    schedulingHealth(task({ _motion: { readback: 'unavailable' } }), now).state,
    'unknown'
  );
});
const meeting = {
  id: 'application-review',
  source: 'user-calendar-context',
  startsAt: '2030-04-22T12:00:00-07:00',
  timeZone: 'America/Los_Angeles',
  observedAt: '2030-04-20T10:00:00-07:00',
  contextOrigin: 'user_supplied',
  bufferMinutes: 15,
  title: 'Application review with Sam',
};
test('observed application review supports contextual prep; never creates meeting invitation', async () => {
  const f = make();
  const result = await captureTask(
    f.client,
    {
      ...captureInput,
      meeting,
      collaborator: 'Sam',
      sourceReference: 'document:application-process',
    },
    now
  );
  assert.equal(result.task?.dueDate, '2030-04-22T18:45:00.000Z');
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 1);
  f.client.close();
});
test('moved meeting proposes update to existing prep without duplicate or silent reschedule', async () => {
  const f = make();
  const result = await captureTask(f.client, { ...captureInput, meeting }, now);
  const review = await reviewMeetingPrep(f.client, result.taskId!, {
    ...meeting,
    startsAt: '2030-04-23T12:00:00-07:00',
  });
  assert.equal(review.mutationPerformed, false);
  const repeat = await captureTask(
    f.client,
    {
      ...captureInput,
      operationKey: 'new-meeting-request',
      name: 'Revised prep',
      meeting: { ...meeting, startsAt: '2030-04-23T12:00:00-07:00' },
    },
    now
  );
  assert.equal(repeat.state, 'existing_meeting_prep');
  assert.equal(f.tasks.size, 1);
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 0);
  f.client.close();
});
test('calendar capabilities distinguish title, availability and Microsoft authorization', () => {
  const c = calendarCapabilities();
  assert.equal(c.bookableSlots.state, 'unavailable');
  assert.equal(c.busyIntervals.state, 'unavailable');
  assert.equal(c.meetingMetadata.state, 'unavailable');
  assert.equal(c.microsoftAccess.state, 'not_connected');
});
test('custom field routes use beta, typed values and actual value ID', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  await f.client.createCustomField({ name: 'Source', type: 'text', workspaceId: 'work' });
  await f.client.addCustomFieldToTask('task_1', 'field', { type: 'text', value: 'context' });
  await f.client.removeCustomFieldFromTask('task_1', 'value_1');
  const writes = f.calls.filter((c) => c.method !== 'GET');
  assert.equal(writes[0]!.path, '/beta/workspaces/work/custom-fields');
  assert.equal(writes[1]!.body.customFieldInstanceId, 'field');
  assert.equal(writes[2]!.path, '/beta/custom-field-values/task/task_1/custom-fields/value_1');
  f.client.close();
});
test('remaining catalog endpoints: unassign, project value removal, field deletion', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  const unassigned = await f.client.unassignTask('task_1');
  assert.equal(unassigned.assignees.length, 0);
  await f.client.removeCustomFieldFromProject('project_1', 'value_2');
  await f.client.deleteCustomField('work', 'field_9');
  const writes = f.calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(
    writes.map((c) => c.method + ' ' + c.path),
    [
      'DELETE /v1/tasks/task_1/assignee',
      'DELETE /beta/custom-field-values/project/project_1/custom-fields/value_2',
      'DELETE /beta/workspaces/work/custom-fields/field_9',
    ]
  );
  f.client.close();
});
test('every frequency pattern in Motion docs validates; legacy values do not', () => {
  for (const ok of [
    'daily_every_day',
    'daily_every_week_day',
    'daily_specific_days_[MO, TU, FR]',
    'weekly_any_day',
    'weekly_any_week_day',
    'weekly_specific_days_[MO, TU, FR]',
    'biweekly_first_week_specific_days_[MO, TU, FR]',
    'biweekly_first_week_any_day',
    'biweekly_first_week_any_week_day',
    'biweekly_second_week_any_day',
    'biweekly_second_week_any_week_day',
    'monthly_first_MO',
    'monthly_last_FR',
    'monthly_1',
    'monthly_15',
    'monthly_31',
    'monthly_any_day_first_week',
    'monthly_any_week_day_last_week',
    'monthly_last_day_of_month',
    'monthly_any_week_day_of_month',
    'monthly_any_day_of_month',
    'quarterly_first_day',
    'quarterly_first_week_day',
    'quarterly_first_MO',
    'quarterly_last_day',
    'quarterly_last_week_day',
    'quarterly_last_MO',
    'quarterly_any_day_first_week',
    'quarterly_any_day_second_week',
    'quarterly_any_day_last_week',
    'quarterly_any_day_first_month',
    'quarterly_any_day_second_month',
  ])
    assert.ok(validFrequency(ok), ok);
  for (const bad of ['DAILY', 'WEEKLY', 'FREQ=WEEKLY;BYDAY=MO', '[MO, FR]', 'monthly_32'])
    assert.ok(!validFrequency(bad), bad);
});
test('undocumented project/comment/recurring mutations fail without network calls', async () => {
  const f = make();
  await rejected(f.client.deleteProject('p'), 'unsupported');
  await rejected(f.client.updateComment('c', 'text'), 'unsupported');
  await rejected(f.client.updateRecurringTask('r', {}), 'unsupported');
  assert.equal(f.calls.length, 0);
  f.client.close();
});

test('simultaneous different keys cannot create duplicate active tasks', async () => {
  const f = make();
  const result = await Promise.allSettled([
    captureTask(f.client, captureInput, now),
    captureTask(f.client, { ...captureInput, operationKey: 'parallel-second-request' }, now),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  f.client.close();
});
test('simultaneous meeting captures with different titles cannot duplicate prep', async () => {
  const f = make();
  const result = await Promise.allSettled([
    captureTask(f.client, { ...captureInput, meeting }, now),
    captureTask(
      f.client,
      { ...captureInput, operationKey: 'second-prep-key', name: 'Review for Sam', meeting },
      now
    ),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.tasks.size, 1);
  f.client.close();
});
test('partial read failure after confirmed create preserves created, scheduling unknown', async () => {
  const f = make();
  f.setHook(async (c) =>
    c.method === 'GET' && /^\/v1\/tasks\//.test(c.path)
      ? new Response('{}', { status: 503 })
      : undefined
  );
  const result = await captureTask(f.client, captureInput, now);
  assert.equal(result.scheduling?.state, 'unknown');
  assert.equal(f.tasks.size, 1);
  f.client.close();
});
test('safe read network timeout is bounded and does not expose credentials', async () => {
  const f = fixture();
  f.config.timeoutMs = 2;
  let count = 0;
  f.config.fetch = async (_url, init) => {
    count++;
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('fixture-secret-never-echo')))
    );
  };
  const client = new MotionApiClient(f.config);
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(
    client.getCurrentUser(),
    (e: any) => e.code === 'read_unavailable' && !e.message.includes('fixture-secret')
  );
  assert.equal(count, 3);
  clearTimeout(keepAlive);
  client.close();
});
test('client preserves observed schedule case and timezone instead of assuming Pacific', async () => {
  const f = make();
  f.setHook(async (c) =>
    c.path === '/v1/schedules'
      ? new Response(
          JSON.stringify([
            { name: 'Work hours', timezone: 'America/New_York', schedule: { monday: [] } },
          ])
        )
      : undefined
  );
  const result = await captureTask(f.client, { ...captureInput, schedule: 'Work hours' }, now);
  assert.equal(result.schedule?.timeZone, 'America/New_York');
  assert.equal(f.calls.find((c) => c.method === 'POST')!.body.autoScheduled.schedule, 'Work hours');
  f.client.close();
});

test('every paginated collection unwraps envelopes and visits the second page', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  const keys: Record<string, string> = {
    '/v1/workspaces': 'workspaces',
    '/v1/projects': 'projects',
    '/v1/users': 'users',
    '/v1/comments': 'comments',
    '/v1/recurring-tasks': 'tasks',
  };
  f.setHook(async (c) => {
    const key = keys[c.path];
    if (c.method !== 'GET' || !key) return undefined;
    const page = c.query.has('cursor') ? 2 : 1;
    const row =
      key === 'workspaces'
        ? { ...task().workspace, id: 'work' }
        : key === 'projects'
          ? { id: 'p' + page, workspaceId: 'work' }
          : key === 'users'
            ? { id: 'u' + page }
            : key === 'comments'
              ? { id: 'c' + page }
              : { id: 'r' + page, workspace: { id: 'work' } };
    return new Response(
      JSON.stringify({ [key]: [row], meta: page === 1 ? { nextCursor: 'next' } : {} })
    );
  });
  assert.equal((await f.client.listWorkspaces()).length, 2);
  assert.equal((await f.client.listProjects('work')).length, 2);
  assert.equal((await f.client.listUsers('work')).length, 2);
  assert.equal((await f.client.listComments('task_1')).length, 2);
  assert.equal((await f.client.listRecurringTasks('work')).length, 2);
  f.client.close();
});
test('task status filter conflict and invalid schedules fail before mutation', async () => {
  const f = make();
  await rejected(
    f.client.listTasks({ workspaceId: 'work', status: ['Todo'], includeAllStatuses: true }),
    'invalid_input'
  );
  await rejected(
    captureTask(f.client, { ...captureInput, schedule: 'Invented' }, now),
    'invalid_schedule'
  );
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
  f.client.close();
});
test('canceled and unknown meeting identities never silently modify tasks', async () => {
  const f = make();
  await rejected(
    captureTask(f.client, { ...captureInput, meeting: { ...meeting, state: 'cancelled' } }, now),
    'meeting_cancelled'
  );
  f.tasks.set('task_1', task());
  await rejected(reviewMeetingPrep(f.client, 'task_1', meeting), 'event_mismatch');
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
  f.client.close();
});
test('recurring creation uses documented frequency grammar and rejects invalid legacy values', async () => {
  const f = make();
  await rejected(
    f.client.createRecurringTask({
      name: 'Weekly review',
      workspaceId: 'work',
      assigneeId: 'owner',
      frequency: 'WEEKLY',
    }),
    'invalid_input'
  );
  await rejected(
    f.client.createRecurringTask({
      name: 'Review',
      workspaceId: 'work',
      assigneeId: 'owner',
      frequency: 'weekly_nonsense',
    }),
    'invalid_input'
  );
  await f.client.createRecurringTask({
    name: 'Weekly review',
    workspaceId: 'work',
    assigneeId: 'owner',
    frequency: 'weekly_specific_days_[MO, FR]',
    duration: '15',
    startingOn: '2030-04-22',
    idealTime: '09:00',
    schedule: 'Work Hours',
  });
  const body = f.calls.find((c) => c.method === 'POST')!.body;
  assert.equal(body.duration, 15);
  assert.equal(body.frequency, 'weekly_specific_days_[MO, FR]');
  assert.ok(!('recurrenceRule' in body));
  f.client.close();
});

test('complete, reopen, complete again remains functional without optional updatedTime', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  await f.client.setCompleted('task_1', true, 'Finished');
  await f.client.setCompleted('task_1', false, 'Ready');
  await f.client.setCompleted('task_1', true, 'Finished');
  assert.equal(f.calls.filter((c) => c.method === 'PATCH').length, 3);
  assert.equal(f.tasks.get('task_1')!.completed, true);
  f.client.close();
});
test('custom field values can intentionally return to an earlier value', async () => {
  const f = make();
  f.tasks.set('task_1', task());
  for (const value of ['one', 'two', 'one'])
    await f.client.addCustomFieldToTask('task_1', 'field', { type: 'text', value });
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 3);
  f.client.close();
});
