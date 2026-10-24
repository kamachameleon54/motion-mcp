import { config } from 'dotenv';
import { MotionError } from './core/errors.js';
import type { MotionConfig } from './types/motion.js';
config();
const csv = (value: string | undefined) =>
  value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export function getConfig(): MotionConfig {
  if (!process.env.MOTION_API_KEY)
    throw new MotionError('configuration', 'MOTION_API_KEY is required.');
  return {
    apiKey: process.env.MOTION_API_KEY,
    baseUrl: 'https://api.usemotion.com/v1',
    rateLimitPerMinute: Number(process.env.MOTION_RATE_LIMIT_PER_MINUTE || 12),
    statePath: process.env.MOTION_STATE_PATH,
    accountId: process.env.MOTION_ACCOUNT_ID,
    expectedUserId: process.env.MOTION_USER_ID,
    allowedWorkspaceIds: csv(process.env.MOTION_WORKSPACE_IDS),
    allowedAssigneeIds: csv(process.env.MOTION_ASSIGNEE_IDS),
    completionStatuses: process.env.MOTION_STATUS_MAP
      ? JSON.parse(process.env.MOTION_STATUS_MAP)
      : undefined,
  };
}
