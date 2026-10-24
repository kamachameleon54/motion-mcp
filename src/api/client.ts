import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, canonical, hash } from '../core/store.js';
import { MotionError } from '../core/errors.js';
import { normalizeDuration } from '../types/duration.js';
import type {
  MotionConfig,
  MotionTask,
  MotionProject,
  MotionWorkspace,
  MotionUser,
  MotionComment,
  MotionSchedule,
  MotionCustomField,
  MotionRecurringTask,
  MotionListResponse,
  MotionTaskCreateParams,
  MotionTaskUpdateParams,
  MotionProjectCreateParams,
  MotionCommentCreateParams,
  MotionStatus,
} from '../types/motion.js';

const id = (value: string) => {
  if (!value || !/^[\w-]+$/.test(value))
    throw new MotionError('invalid_id', 'Use a Motion ID, not a URL or path.');
  return encodeURIComponent(value);
};
const normalizedName = (name: string) =>
  name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
export class MotionApiClient {
  readonly store: Store;
  readonly account: string;
  readonly config: MotionConfig;
  constructor(config: MotionConfig) {
    if (!Number.isSafeInteger(config.rateLimitPerMinute) || config.rateLimitPerMinute < 1)
      throw new MotionError('configuration', 'Invalid account quota.');
    const base = new URL(config.baseUrl);
    if (
      base.origin !== 'https://api.usemotion.com' &&
      !(config.fetch && ['localhost', '127.0.0.1'].includes(base.hostname))
    )
      throw new MotionError(
        'configuration',
        'Motion API origin must be https://api.usemotion.com.'
      );
    this.config = config;
    this.account = hash(config.accountId || config.apiKey);
    this.store = new Store(
      config.statePath || join(homedir(), '.local', 'state', 'motion-mcp', 'state.sqlite')
    );
  }
  close() {
    this.store.close();
  }
  assertWorkspace(workspaceId: string) {
    id(workspaceId);
    if (this.config.allowedWorkspaceIds && !this.config.allowedWorkspaceIds.includes(workspaceId))
      throw new MotionError(
        'scope_denied',
        'Workspace is outside this connection’s allowed scope.'
      );
  }
  private async request<T>(
    method: string,
    path: string,
    data?: unknown,
    params?: Record<string, unknown>
  ): Promise<T> {
    const origin = new URL(this.config.baseUrl).origin;
    const url = new URL(path.startsWith('/beta/') ? path : '/v1' + path, origin);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined)
        for (const entry of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(entry));
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.store.acquire(
        this.account,
        this.config.rateLimitPerMinute,
        this.config.maxWaitMs ?? 20000
      );
      let response: Response;
      try {
        response = await (this.config.fetch || globalThis.fetch)(url, {
          method,
          headers: { 'X-API-Key': this.config.apiKey, 'Content-Type': 'application/json' },
          body: data === undefined ? undefined : JSON.stringify(data),
          redirect: 'error',
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 12000),
        });
        if (response.status === 429) {
          const header = response.headers.get('retry-after');
          const wait =
            header && /^\d+(\.\d+)?$/.test(header)
              ? Number(header) * 1000
              : Math.max(0, Date.parse(header || '') - Date.now()) || 60000;
          this.store.cooldown(this.account, Math.max(100, wait));
        }
        if (!response.ok) {
          if (
            method === 'GET' &&
            attempt < 2 &&
            (response.status === 429 || response.status >= 500)
          )
            continue;
          throw new MotionError(
            method !== 'GET' && (response.status >= 500 || response.status === 408)
              ? 'outcome_unknown'
              : 'upstream_rejected',
            'Motion request was not confirmed.',
            { status: response.status }
          );
        }
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (error) {
        if (error instanceof MotionError) throw error;
        if (method === 'GET' && attempt < 2) {
          await delay(100 * (attempt + 1));
          continue;
        }
        throw new MotionError(
          method === 'GET' ? 'read_unavailable' : 'outcome_unknown',
          'Motion response was unavailable or invalid.'
        );
      }
    }
    throw new MotionError('read_unavailable', 'Read retry limit reached.');
  }
  private async all<T>(
    path: string,
    key: string,
    params: Record<string, unknown> = {}
  ): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < (this.config.maxPages ?? 100); page++) {
      const response = await this.request<Record<string, unknown>>('GET', path, undefined, {
        ...params,
        cursor,
      });
      if (!response || !Array.isArray(response[key]))
        throw new MotionError(
          'invalid_response',
          'Motion list response did not match the documented contract.'
        );
      out.push(...(response[key] as T[]));
      const next = (response.meta as { nextCursor?: string } | undefined)?.nextCursor;
      if (!next) return out;
      if (typeof next !== 'string' || seen.has(next))
        throw new MotionError(
          'pagination_incomplete',
          'Motion returned a repeated or invalid cursor. No complete search was established.'
        );
      seen.add(next);
      cursor = next;
    }
    throw new MotionError(
      'pagination_incomplete',
      'Page limit reached. Narrow the workspace/query before writing.'
    );
  }
  private async write<T>(
    method: string,
    path: string,
    data: unknown,
    key?: string,
    reconcile?: () => Promise<T | undefined>
  ): Promise<T> {
    const fingerprint = hash(canonical({ method, path, data }));
    const operationKey = key || fingerprint;
    const claimed = this.store.claim(this.account, operationKey, fingerprint);
    if (!claimed.fresh) {
      if (claimed.op.state === 'done') return JSON.parse(claimed.op.result!) as T;
      if (claimed.op.state === 'rejected')
        throw new MotionError(
          'previously_rejected',
          'This exact write was previously rejected. Correct its input before submitting a new operation.'
        );
      if (reconcile) {
        try {
          const found = await reconcile();
          if (found !== undefined) {
            this.store.finish(this.account, operationKey, found);
            return found;
          }
        } catch {
          /* Keep uncertain writes fenced. */
        }
      }
      throw new MotionError(
        'outcome_unknown',
        'An earlier write may have succeeded. No second write was sent.',
        { operationKey }
      );
    }
    let result: T;
    try {
      result = await this.request<T>(method, path, data);
    } catch (error) {
      if (error instanceof MotionError && error.code === 'rate_limit_wait') {
        // acquire failed before fetch; safe to release this claim.
        this.store.db
          .prepare('DELETE FROM operations WHERE account=? AND key=?')
          .run(this.account, operationKey);
        throw error;
      }
      if (error instanceof MotionError && error.code === 'upstream_rejected') {
        this.store.finish(this.account, operationKey, { code: error.code }, 'rejected');
        throw error;
      }
      if (reconcile) {
        try {
          const found = await reconcile();
          if (found !== undefined) {
            this.store.finish(this.account, operationKey, found);
            return found;
          }
        } catch {
          /* Reconciliation failure never authorizes a retry. */
        }
      }
      throw new MotionError(
        'outcome_unknown',
        'Write outcome is uncertain; reuse the same operation key to reconcile, never create again blindly.',
        { operationKey }
      );
    }
    // A successful task create must identify the new task before it can be replayed.
    if (method === 'POST' && path === '/tasks' && !(result as MotionTask)?.id)
      throw new MotionError(
        'outcome_unknown',
        'Create response omitted the task ID. Reconcile with the same operation key.',
        { operationKey }
      );
    this.store.finish(this.account, operationKey, result ?? { success: true });
    return result;
  }
  async listWorkspaces(): Promise<MotionWorkspace[]> {
    return (await this.all<MotionWorkspace>('/workspaces', 'workspaces')).filter(
      (w) => !this.config.allowedWorkspaceIds || this.config.allowedWorkspaceIds.includes(w.id)
    );
  }
  async getWorkspace(workspaceId: string): Promise<MotionWorkspace> {
    this.assertWorkspace(workspaceId);
    const workspace = (await this.listWorkspaces()).find((w) => w.id === workspaceId);
    if (!workspace) throw new MotionError('not_found', 'Workspace not available.');
    return workspace;
  }
  async listTasks(params: Record<string, unknown> = {}): Promise<MotionListResponse<MotionTask>> {
    if (params.includeAllStatuses !== undefined && params.status !== undefined)
      throw new MotionError('invalid_input', 'Use status or includeAllStatuses, not both.');
    if (this.config.allowedWorkspaceIds && !params.workspaceId)
      throw new MotionError(
        'workspace_required',
        'Choose an allowed workspace before listing tasks.'
      );
    if (params.workspaceId) this.assertWorkspace(String(params.workspaceId));
    const response = await this.request<MotionListResponse<MotionTask>>(
      'GET',
      '/tasks',
      undefined,
      params
    );
    if (!Array.isArray(response?.tasks))
      throw new MotionError('invalid_response', 'Expected a tasks envelope.');
    return {
      ...response,
      tasks: response.tasks.filter(
        (t: MotionTask) =>
          !this.config.allowedWorkspaceIds ||
          this.config.allowedWorkspaceIds.includes(t.workspace?.id)
      ),
    };
  }
  async allTasks(workspaceId: string, includeAllStatuses = true): Promise<MotionTask[]> {
    this.assertWorkspace(workspaceId);
    return (
      await this.all<MotionTask>('/tasks', 'tasks', { workspaceId, includeAllStatuses })
    ).filter((t) => t.workspace?.id === workspaceId);
  }
  async getTask(taskId: string): Promise<MotionTask> {
    const task = await this.request<MotionTask>('GET', `/tasks/${id(taskId)}`);
    if (!task?.workspace?.id)
      throw new MotionError('invalid_response', 'Task response omitted workspace identity.');
    this.assertWorkspace(task.workspace.id);
    return task;
  }
  async getStatuses(workspaceId: string): Promise<MotionStatus[]> {
    this.assertWorkspace(workspaceId);
    const rows = await this.request<Array<MotionStatus | { status: MotionStatus }>>(
      'GET',
      '/statuses',
      undefined,
      { workspaceId }
    );
    if (!Array.isArray(rows)) throw new MotionError('invalid_response', 'Expected statuses array.');
    return rows.map((s) => ('status' in s ? s.status : s));
  }
  private async validateTask(
    params: MotionTaskCreateParams | MotionTaskUpdateParams,
    workspaceId: string
  ) {
    await this.getWorkspace(workspaceId);
    if (params.duration !== undefined) params.duration = normalizeDuration(params.duration);
    if (params.projectId && (await this.getProject(params.projectId)).workspaceId !== workspaceId)
      throw new MotionError('routing_mismatch', 'Project belongs to a different workspace.');
    if (
      params.status &&
      !(await this.getStatuses(workspaceId)).some((s) => s.name === params.status)
    )
      throw new MotionError('invalid_status', 'Status is not present in this workspace.');
    if (params.assigneeId) {
      if (
        this.config.allowedAssigneeIds &&
        !this.config.allowedAssigneeIds.includes(params.assigneeId)
      )
        throw new MotionError('scope_denied', 'Assignee is outside the configured user scope.');
      if (!(await this.listUsers(workspaceId)).some((u) => u.id === params.assigneeId))
        throw new MotionError('routing_mismatch', 'Assignee is not a workspace member.');
    }
    if (params.dueDate && !Number.isFinite(Date.parse(params.dueDate)))
      throw new MotionError('invalid_input', 'Invalid due date.');
    if (params.autoScheduled) {
      if (!params.dueDate)
        throw new MotionError('invalid_input', 'Scheduled work requires a due date.');
      if (
        params.autoScheduled.startDate &&
        !Number.isFinite(Date.parse(params.autoScheduled.startDate))
      )
        throw new MotionError('invalid_input', 'Invalid start date.');
      const schedule = params.autoScheduled.schedule || 'Work Hours';
      const current = await this.getCurrentUser();
      if (params.assigneeId && params.assigneeId !== current.id) {
        if (schedule !== 'Work Hours')
          throw new MotionError('invalid_schedule', 'Other users can only be assigned Work Hours.');
      } else if (!(await this.getSchedule({})).some((s) => s.name === schedule))
        throw new MotionError(
          'invalid_schedule',
          'Resolve an actual Motion schedule before scheduling work.'
        );
    }
  }
  async createTask(params: MotionTaskCreateParams): Promise<MotionTask> {
    const { operationKey, intentKey, ...body } = params;
    await this.validateTask(body, body.workspaceId);
    const op = operationKey || hash(canonical({ kind: 'create-task', body }));
    const marker = `motion-operation:${hash(op)}`;
    const marked = {
      ...body,
      description: [body.description, marker].filter(Boolean).join('\n\n'),
    };
    // All statuses for marker reconciliation; active tasks only for name duplicates.
    const tasks = await this.allTasks(body.workspaceId);
    const markerMatches = tasks.filter((t) => t.description?.includes(marker));
    if (markerMatches.length > 1)
      throw new MotionError(
        'outcome_unknown',
        'Multiple tasks match this operation marker. Manual review is required.'
      );
    const claimed = this.store.db
      .prepare('SELECT fingerprint FROM operations WHERE account=? AND key=?')
      .get(this.account, op);
    if (!claimed && !markerMatches.length) {
      const duplicates = tasks.filter(
        (t) =>
          !t.completed &&
          !t.status?.isResolvedStatus &&
          normalizedName(t.name) === normalizedName(body.name) &&
          (t.project?.id || '') === (body.projectId || '')
      );
      if (duplicates.length)
        throw new MotionError(
          'duplicate_candidate',
          'A matching active task already exists. Review it before creating another.',
          { taskIds: duplicates.map((t) => t.id) }
        );
    }
    // If local state was lost, a visible unique marker is still evidence of an existing write.
    if (!claimed && markerMatches.length) return this.getTask(markerMatches[0]!.id);
    this.store.guardCapture(
      this.account,
      hash(
        canonical({
          workspace: body.workspaceId,
          project: body.projectId || '',
          name: intentKey || normalizedName(body.name),
        })
      ),
      op,
      tasks.filter((t) => t.completed).map((t) => t.id)
    );
    const created = await this.write<MotionTask>('POST', '/tasks', marked, op, async () => {
      const found = (await this.allTasks(body.workspaceId)).filter((t) =>
        t.description?.includes(marker)
      );
      return found.length === 1 ? found[0] : undefined;
    });
    try {
      return Object.assign(await this.getTask(created.id), {
        _motion: { write: 'created', readback: 'verified', operationKey: op },
      });
    } catch {
      return Object.assign(created, {
        _motion: { write: 'created', readback: 'unavailable', operationKey: op },
      });
    }
  }
  private async completionStatus(workspaceId: string, completed: boolean, explicit?: string) {
    const statuses = await this.getStatuses(workspaceId);
    const selected =
      explicit ||
      this.config.completionStatuses?.[workspaceId]?.[completed ? 'complete' : 'reopen'];
    if (!selected)
      throw new MotionError(
        'status_mapping_required',
        'Choose the workspace’s actual completion/reopen status before changing it.',
        { statuses }
      );
    const status = statuses.find((s) => s.name === selected);
    if (!status || Boolean(status.isResolvedStatus) !== completed)
      throw new MotionError(
        'invalid_status',
        'Selected status does not match the requested resolved/open state.'
      );
    return selected;
  }
  async updateTask(taskId: string, params: MotionTaskUpdateParams): Promise<MotionTask> {
    const current = await this.getTask(taskId);
    const { completed, operationKey, ...changes } = params;
    if (changes.workspaceId && changes.workspaceId !== current.workspace.id)
      throw new MotionError(
        'use_workspace_move',
        'Use motion_move_task_workspace for a workspace change.'
      );
    if (completed !== undefined)
      changes.status = await this.completionStatus(current.workspace.id, completed, changes.status);
    const body = {
      ...changes,
      name: changes.name ?? current.name,
      workspaceId: current.workspace.id,
    };
    if (body.autoScheduled && !body.dueDate) body.dueDate = current.dueDate;
    await this.validateTask(body, current.workspace.id);
    const updateKey = operationKey || randomUUID();
    const response = await this.write<MotionTask>(
      'PATCH',
      `/tasks/${id(taskId)}`,
      body,
      updateKey,
      async () => {
        const task = await this.getTask(taskId);
        // Scheduling configuration and HTML description cannot be inferred from response absence.
        if (body.autoScheduled !== undefined || body.description !== undefined) return undefined;
        const matches = Object.entries(body).every(
          ([k, v]) =>
            v === undefined ||
            canonical(
              k === 'workspaceId'
                ? task.workspace.id
                : k === 'projectId'
                  ? task.project?.id
                  : k === 'status'
                    ? task.status.name
                    : k === 'assigneeId'
                      ? task.assignees?.[0]?.id
                      : k === 'labels'
                        ? task.labels?.map((l) => l.name)
                        : (task as unknown as Record<string, unknown>)[k]
            ) === canonical(v)
        );
        return matches ? task : undefined;
      }
    );
    let task: MotionTask;
    try {
      task = await this.getTask(taskId);
    } catch {
      return Object.assign(response || current, {
        _motion: { write: 'updated', readback: 'unavailable' },
      });
    }
    return Object.assign(task, {
      _motion: {
        write: 'updated',
        readback: 'verified',
        completionVerified: completed === undefined ? undefined : task.completed === completed,
        operationKey: updateKey,
      },
    });
  }
  async setCompleted(taskId: string, completed: boolean, status?: string, operationKey?: string) {
    return this.updateTask(taskId, { completed, status, operationKey });
  }
  async deleteTask(taskId: string, operationKey?: string): Promise<void> {
    await this.getTask(taskId);
    await this.write('DELETE', `/tasks/${id(taskId)}`, undefined, operationKey);
  }
  async unassignTask(taskId: string, operationKey?: string): Promise<MotionTask> {
    await this.getTask(taskId);
    await this.write('DELETE', `/tasks/${id(taskId)}/assignee`, undefined, operationKey);
    return this.getTask(taskId);
  }
  // Preserve legacy project assignment signature; workspace moves have their own method.
  async moveTask(taskId: string, projectId: string): Promise<MotionTask> {
    return this.updateTask(taskId, { projectId });
  }
  async moveTaskWorkspace(
    taskId: string,
    workspaceId: string,
    assigneeId?: string,
    operationKey?: string
  ): Promise<MotionTask> {
    await this.getTask(taskId);
    await this.validateTask({ assigneeId }, workspaceId);
    const response = await this.write<MotionTask>(
      'PATCH',
      `/tasks/${id(taskId)}/move`,
      { workspaceId, assigneeId },
      operationKey,
      async () => {
        const t = await this.getTask(taskId);
        return t.workspace.id === workspaceId &&
          (!assigneeId || t.assignees.some((u) => u.id === assigneeId))
          ? t
          : undefined;
      }
    );
    try {
      return await this.getTask(taskId);
    } catch {
      return Object.assign(response, { _motion: { write: 'moved', readback: 'unavailable' } });
    }
  }
  private async workspaces(workspaceId?: string) {
    if (workspaceId) {
      this.assertWorkspace(workspaceId);
      return [workspaceId];
    }
    return (await this.listWorkspaces()).map((w) => w.id);
  }
  async listProjects(workspaceId?: string): Promise<MotionProject[]> {
    const out: MotionProject[] = [];
    for (const w of await this.workspaces(workspaceId))
      out.push(
        ...(await this.all<MotionProject>('/projects', 'projects', { workspaceId: w })).filter(
          (p) => p.workspaceId === w
        )
      );
    return out;
  }
  async getProject(projectId: string): Promise<MotionProject> {
    const p = await this.request<MotionProject>('GET', `/projects/${id(projectId)}`);
    this.assertWorkspace(p.workspaceId);
    return p;
  }
  async createProject(
    params: MotionProjectCreateParams & { operationKey?: string }
  ): Promise<MotionProject> {
    const { operationKey, ...body } = params;
    await this.getWorkspace(body.workspaceId);
    if (body.status !== undefined)
      throw new MotionError(
        'unsupported_field',
        'Project status is not in the documented create contract.'
      );
    return this.write('POST', '/projects', body, operationKey);
  }
  async updateProject(
    _id: string,
    _params: Partial<MotionProjectCreateParams>
  ): Promise<MotionProject> {
    throw this.unsupported();
  }
  async deleteProject(_id: string): Promise<void> {
    throw this.unsupported();
  }
  async getCurrentUser(): Promise<MotionUser> {
    const user = await this.request<MotionUser>('GET', '/users/me');
    if (this.config.expectedUserId && user.id !== this.config.expectedUserId)
      throw new MotionError(
        'scope_denied',
        'Motion API key owner does not match configured account.'
      );
    return user;
  }
  async getUser(userId: string): Promise<MotionUser> {
    const user = (await this.listUsers()).find((u) => u.id === userId);
    if (!user) throw new MotionError('not_found', 'User not available within allowed workspaces.');
    return user;
  }
  async listUsers(workspaceId?: string): Promise<MotionUser[]> {
    const result = new Map<string, MotionUser>();
    for (const w of await this.workspaces(workspaceId))
      for (const user of await this.all<MotionUser>('/users', 'users', { workspaceId: w }))
        result.set(user.id, user);
    return [...result.values()];
  }
  async getSchedule(
    params: { userId?: string; startDate?: string; endDate?: string } = {}
  ): Promise<MotionSchedule[]> {
    if (params.userId || params.startDate || params.endDate)
      throw new MotionError(
        'unsupported_filter',
        'Motion schedules are the API owner’s working hours, not date-range calendar events.'
      );
    return this.request('GET', '/schedules');
  }
  async listComments(taskId: string): Promise<MotionComment[]> {
    await this.getTask(taskId);
    return this.all('/comments', 'comments', { taskId });
  }
  async createComment(
    params: MotionCommentCreateParams & { operationKey?: string }
  ): Promise<MotionComment> {
    await this.getTask(params.taskId);
    const { operationKey, ...body } = params;
    return this.write('POST', '/comments', body, operationKey);
  }
  async getComment(_id: string): Promise<MotionComment> {
    throw this.unsupported();
  }
  async updateComment(_id: string, _content: string): Promise<MotionComment> {
    throw this.unsupported();
  }
  async deleteComment(_id: string): Promise<void> {
    throw this.unsupported();
  }
  async listCustomFields(workspaceId?: string): Promise<MotionCustomField[]> {
    if (!workspaceId)
      throw new MotionError('workspace_required', 'Custom fields require a workspace.');
    this.assertWorkspace(workspaceId);
    return this.request('GET', `/beta/workspaces/${id(workspaceId)}/custom-fields`);
  }
  async createCustomField(params: {
    name: string;
    type: string;
    workspaceId: string;
    options?: string[];
    metadata?: unknown;
    operationKey?: string;
  }): Promise<MotionCustomField> {
    const { workspaceId, operationKey, options, ...body } = params;
    await this.getWorkspace(workspaceId);
    if (options)
      throw new MotionError(
        'unsupported_field',
        'Use the documented metadata object for field options.'
      );
    return this.write(
      'POST',
      `/beta/workspaces/${id(workspaceId)}/custom-fields`,
      body,
      operationKey
    );
  }
  private typedValue(value: unknown) {
    if (!value || typeof value !== 'object' || !('type' in value) || !('value' in value))
      throw new MotionError('invalid_input', 'Custom field value must contain type and value.');
    return value;
  }
  async addCustomFieldToTask(
    taskId: string,
    customFieldId: string,
    value: unknown,
    operationKey?: string
  ): Promise<void> {
    await this.getTask(taskId);
    await this.write(
      'POST',
      `/beta/custom-field-values/task/${id(taskId)}`,
      {
        customFieldInstanceId: customFieldId,
        value: this.typedValue(value),
      },
      operationKey || randomUUID()
    );
  }
  async addCustomFieldToProject(
    projectId: string,
    customFieldId: string,
    value: unknown,
    operationKey?: string
  ): Promise<void> {
    await this.getProject(projectId);
    await this.write(
      'POST',
      `/beta/custom-field-values/project/${id(projectId)}`,
      {
        customFieldInstanceId: customFieldId,
        value: this.typedValue(value),
      },
      operationKey || randomUUID()
    );
  }
  async removeCustomFieldFromTask(taskId: string, valueId: string): Promise<void> {
    await this.getTask(taskId);
    await this.write(
      'DELETE',
      `/beta/custom-field-values/task/${id(taskId)}/custom-fields/${id(valueId)}`,
      undefined
    );
  }
  async removeCustomFieldFromProject(projectId: string, valueId: string): Promise<void> {
    await this.getProject(projectId);
    await this.write(
      'DELETE',
      `/beta/custom-field-values/project/${id(projectId)}/custom-fields/${id(valueId)}`,
      undefined
    );
  }
  async deleteCustomField(workspaceId: string, fieldId: string): Promise<void> {
    await this.getWorkspace(workspaceId);
    await this.write(
      'DELETE',
      `/beta/workspaces/${id(workspaceId)}/custom-fields/${id(fieldId)}`,
      undefined
    );
  }
  async listRecurringTasks(workspaceId?: string): Promise<MotionRecurringTask[]> {
    const out: MotionRecurringTask[] = [];
    for (const w of await this.workspaces(workspaceId))
      out.push(
        ...(
          await this.all<MotionRecurringTask>('/recurring-tasks', 'tasks', { workspaceId: w })
        ).filter((t) => (t.workspace?.id || t.workspaceId) === w)
      );
    return out;
  }
  async createRecurringTask(params: {
    name: string;
    workspaceId: string;
    frequency: string;
    duration?: string | number;
    assigneeId?: string;
    operationKey?: string;
    [key: string]: unknown;
  }): Promise<MotionRecurringTask> {
    const { operationKey, ...body } = params;
    if (!body.assigneeId)
      throw new MotionError('invalid_input', 'Recurring tasks require an assignee.');
    if (!validFrequency(body.frequency))
      throw new MotionError(
        'invalid_input',
        'Use a documented Motion frequency string, not DAILY or an RRULE.'
      );
    if (body.recurrenceRule || body.projectId)
      throw new MotionError(
        'unsupported_field',
        'recurrenceRule and projectId are not recurring-create request fields.'
      );
    await this.validateTask(
      { assigneeId: body.assigneeId, duration: body.duration },
      body.workspaceId
    );
    body.duration = normalizeDuration(body.duration);
    if (body.schedule && !(await this.getSchedule({})).some((s) => s.name === body.schedule))
      throw new MotionError('invalid_schedule', 'Resolve an actual schedule for recurring work.');
    if (body.duration === 'NONE')
      throw new MotionError('invalid_input', 'Recurring duration must be minutes or REMINDER.');
    return this.write('POST', '/recurring-tasks', body, operationKey);
  }
  async getRecurringTask(recurringTaskId: string): Promise<MotionRecurringTask> {
    const task = (await this.listRecurringTasks()).find((t) => t.id === recurringTaskId);
    if (!task) throw new MotionError('not_found', 'Recurring task not available.');
    return task;
  }
  async updateRecurringTask(
    _id: string,
    _params: Partial<MotionRecurringTask>
  ): Promise<MotionRecurringTask> {
    throw this.unsupported();
  }
  async deleteRecurringTask(recurringTaskId: string): Promise<void> {
    await this.getRecurringTask(recurringTaskId);
    await this.write('DELETE', `/recurring-tasks/${id(recurringTaskId)}`, undefined);
  }
  async getStatus(_statusId: string): Promise<unknown> {
    throw new MotionError('unsupported', 'Use getStatuses(workspaceId).');
  }
  private unsupported() {
    return new MotionError(
      'unsupported',
      'No current documented endpoint supports this operation; no request was sent.'
    );
  }
}

export function validFrequency(value: string): boolean {
  const day = '(?:MO|TU|WE|TH|FR|SA|SU)';
  const days = '\\[' + day + '(?:, ?' + day + ')*\\]';
  return new RegExp(
    '^(?:daily_(?:every_day|every_week_day|specific_days_' +
      days +
      ')|weekly_(?:any_day|any_week_day|specific_days_' +
      days +
      ')|biweekly_(?:first_week_(?:any_day|any_week_day|specific_days_' +
      days +
      ')|second_week_(?:any_day|any_week_day))|monthly_(?:(?:first|second|third|fourth|last)_' +
      day +
      '|(?:[1-9]|[12][0-9]|3[01])|any_(?:week_)?day_(?:first|second|third|fourth|last)_week|last_day_of_month|any_week_day_of_month|any_day_of_month)|quarterly_(?:(?:first|last)_(?:day|week_day|' +
      day +
      ')|any_day_(?:first_week|second_week|last_week|first_month|second_month)))$'
  ).test(value);
}
