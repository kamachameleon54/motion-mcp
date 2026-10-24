import type { MotionConfig, MotionTask } from '../src/types/motion.js';
export const future = '2030-04-22T17:00:00-07:00';
export const workspace = {
  id: 'work',
  name: 'Work',
  teamId: 'team',
  type: 'TEAM',
  labels: [],
  statuses: [],
};
export const statuses = [
  { name: 'Ready', isDefaultStatus: true, isResolvedStatus: false },
  { name: 'Finished', isResolvedStatus: true },
  { name: 'Cancelled', isResolvedStatus: true },
];
export const task = (changes: Record<string, unknown> = {}): MotionTask =>
  ({
    id: 'task_1',
    name: 'Prepare expenses',
    description: '',
    duration: 15,
    dueDate: future,
    deadlineType: 'SOFT',
    completed: false,
    creator: { id: 'owner' },
    workspace,
    status: statuses[0],
    priority: 'MEDIUM',
    labels: [],
    assignees: [{ id: 'owner', email: 'fixture@example.test' }],
    createdTime: '2030-04-20T00:00:00Z',
    scheduledStart: '2030-04-22T09:00:00-07:00',
    scheduledEnd: '2030-04-22T09:15:00-07:00',
    schedulingIssue: false,
    ...changes,
  }) as MotionTask;
export function fixture() {
  const tasks = new Map<string, MotionTask>();
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];
  let hook: ((call: (typeof calls)[number]) => Promise<Response | undefined>) | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const call = {
      method: init?.method || 'GET',
      path: u.pathname,
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const hooked = await hook?.(call);
    if (hooked) return hooked;
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (call.path === '/v1/workspaces')
      return reply({
        workspaces: [workspace, { ...workspace, id: 'private', name: 'Private' }],
        meta: {},
      });
    if (call.path === '/v1/schedules')
      return reply([
        {
          name: 'Work Hours',
          timezone: 'America/Los_Angeles',
          isDefaultTimezone: true,
          schedule: { monday: [{ start: '09:00', end: '17:00' }] },
        },
      ]);
    if (call.path === '/v1/users/me') return reply({ id: 'owner', email: 'fixture@example.test' });
    if (call.path === '/v1/users')
      return reply({ users: [{ id: 'owner', email: 'fixture@example.test' }], meta: {} });
    if (call.path === '/v1/statuses') return reply(statuses.map((status) => ({ status })));
    if (call.path === '/v1/projects')
      return reply({
        projects: [{ id: 'project_1', name: 'Expenses', workspaceId: 'work' }],
        meta: {},
      });
    if (call.path === '/v1/projects/project_1')
      return reply({ id: 'project_1', name: 'Expenses', workspaceId: 'work' });
    if (call.path === '/v1/projects/wrong')
      return reply({ id: 'wrong', name: 'Other', workspaceId: 'private' });
    if (call.path === '/v1/tasks' && call.method === 'GET')
      return reply({ tasks: [...tasks.values()], meta: {} });
    if (call.path === '/v1/tasks' && call.method === 'POST') {
      const t = task({
        ...call.body,
        id: 'task_' + (tasks.size + 1),
        workspace,
        status: statuses[0],
        scheduledEnd: new Date(
          Date.parse('2030-04-22T09:00:00-07:00') + Number(call.body.duration) * 60000
        ).toISOString(),
      });
      tasks.set(t.id, t);
      return reply(t);
    }
    const match = call.path.match(/^\/v1\/tasks\/(\w+)(\/move|\/assignee)?$/);
    if (match) {
      const t = tasks.get(match[1]!);
      if (!t) return reply({}, 404);
      if (call.method === 'PATCH') {
        if (match[2]) t.workspace = { ...t.workspace, id: call.body.workspaceId };
        else {
          const { status, ...body } = call.body;
          Object.assign(t, body);
          if (status) {
            t.status = statuses.find((s) => s.name === status)!;
            t.completed = status === 'Finished';
          }
        }
      }
      if (call.method === 'DELETE' && match[2] === '/assignee') {
        t.assignees = [];
        return new Response(null, { status: 204 });
      }
      if (call.method === 'DELETE') {
        tasks.delete(t.id);
        return new Response(null, { status: 204 });
      }
      return reply(t);
    }
    if (call.path === '/v1/comments')
      return reply(
        call.method === 'GET' ? { comments: [], meta: {} } : { id: 'comment', ...call.body }
      );
    if (call.path === '/v1/recurring-tasks')
      return reply(
        call.method === 'GET' ? { tasks: [], meta: {} } : { id: 'recurring', ...call.body }
      );
    if (call.path.startsWith('/beta/'))
      return call.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : reply(call.method === 'GET' ? [] : { id: 'field' });
    throw new Error('Unexpected fixture route ' + call.method + ' ' + call.path);
  };
  const config: MotionConfig = {
    apiKey: 'fixture-secret-never-echo',
    baseUrl: 'http://127.0.0.1',
    rateLimitPerMinute: 10000,
    statePath: ':memory:',
    maxWaitMs: 0,
    fetch: fetcher,
    allowedWorkspaceIds: ['work'],
    allowedAssigneeIds: ['owner'],
    expectedUserId: 'owner',
  };
  return {
    config,
    tasks,
    calls,
    setHook: (h: typeof hook) => {
      hook = h;
    },
  };
}
export const captureInput = {
  operationKey: 'expenses-user-request-1',
  name: 'Prepare expenses',
  workspaceId: 'work',
  durationMinutes: 15,
  startDate: '2030-04-22T08:00:00-07:00',
  dueDate: future,
  schedule: 'Work Hours',
  purpose: 'Submit this month’s expenses',
  nextStep: 'Gather receipts and enter expenses',
  sourceReference: 'conversation:expenses',
  authorization: 'explicit_user_request',
  requestEvidence: { kind: 'user_instruction', reference: 'user-message:expenses' },
};
