import { MotionError } from '../core/errors.js';
import type { MotionConfig } from '../types/motion.js';
import type { WorkerEnv } from './env.js';

const csv = (v?: string) =>
  v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const num = (v?: string) => (v?.trim() ? Number(v) : undefined);
export const disabledTools = (env: WorkerEnv) => csv(env.MOTION_DISABLED_TOOLS) ?? [];
export function workerConfig(env: WorkerEnv): MotionConfig {
  // Workspace and assignee lists are required remotely: without them client.ts allows every
  // workspace and every member as an assignee.
  for (const k of [
    'MOTION_API_KEY',
    'MOTION_ACCOUNT_ID',
    'MOTION_USER_ID',
    'MOTION_WORKSPACE_IDS',
    'MOTION_ASSIGNEE_IDS',
  ] as const)
    if (!env[k]?.trim()) throw new MotionError('configuration', `${k} is required.`);
  return {
    apiKey: env.MOTION_API_KEY,
    baseUrl: 'https://api.usemotion.com/v1',
    rateLimitPerMinute: Number(env.MOTION_RATE_LIMIT_PER_MINUTE || 6),
    // Quota wait before rate_limit_wait (client default 45 s). The Durable Object holds the request
    // open while it waits; 45 s plus one Motion call stays inside the 60 s MCP client timeout and
    // Cloudflare's 100 s edge response limit.
    maxWaitMs: num(env.MOTION_MAX_WAIT_MS),
    // Lookup cache lives in the Durable Object's memory, so every remote client shares it until
    // the object is evicted (client default 10 min; 0 turns it off).
    cacheTtlMs: num(env.MOTION_CACHE_TTL_MS),
    accountId: env.MOTION_ACCOUNT_ID,
    expectedUserId: env.MOTION_USER_ID,
    allowedWorkspaceIds: csv(env.MOTION_WORKSPACE_IDS),
    allowedAssigneeIds: csv(env.MOTION_ASSIGNEE_IDS),
    completionStatuses: env.MOTION_STATUS_MAP ? JSON.parse(env.MOTION_STATUS_MAP) : undefined,
  };
}
