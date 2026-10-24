/** Bounded, read-only pilot. Reads a local config in memory; writes only an aggregate report. */
import { readFileSync, writeFileSync } from 'node:fs';
import { MotionApiClient } from '../src/api/client.js';
const sourcePath = process.env.MOTION_SOURCE_CONFIG;
if (!sourcePath) throw new Error('Provide the source config path explicitly.');
const config = JSON.parse(readFileSync(sourcePath, 'utf8')).mcpServers['Motion Scheduler'];
if (!config?.env?.MOTION_API_KEY)
  throw new Error('Motion key not available in named configuration.');
const client = new MotionApiClient({
  apiKey: config.env.MOTION_API_KEY,
  baseUrl: 'https://api.usemotion.com/v1',
  rateLimitPerMinute: 12,
  statePath: 'state/live-read-audit.sqlite',
  maxWaitMs: 20000,
});
try {
  const user = await client.getCurrentUser();
  const workspaces = await client.listWorkspaces();
  const schedules = await client.getSchedule({});
  const report: any = {
    observedAt: new Date().toISOString(),
    mode: 'read_only',
    userIdentityPresent: !!user.id,
    configuredLegacyLimit: Number(config.env.MOTION_RATE_LIMIT_PER_MINUTE),
    verifiedAccountAllowance: 'unknown; audit uses conservative 12/minute',
    workspaces: workspaces.map((w) => ({ name: w.name, idPresent: !!w.id })),
    schedules: schedules.map((s) => ({
      name: s.name,
      timeZone: s.timezone,
      workingDays: Object.keys(s.schedule),
    })),
    workspaceChecks: [],
  };
  for (const workspace of workspaces.slice(0, 3)) {
    const statuses = await client.getStatuses(workspace.id);
    const projects = await client.listProjects(workspace.id);
    report.workspaceChecks.push({
      name: workspace.name,
      statuses: statuses.map((s) => ({
        name: s.name,
        isResolvedStatus: s.isResolvedStatus,
        isDefaultStatus: s.isDefaultStatus,
      })),
      projectCount: projects.length,
    });
  }
  const wanted = process.env.MOTION_AUDIT_WORKSPACE;
  const workspace = workspaces.find((w) => w.name === wanted) || workspaces[0];
  if (workspace) {
    const page = await client.listTasks({ workspaceId: workspace.id });
    report.taskPage = { count: page.tasks.length, hasNextCursor: !!page.meta?.nextCursor };
    if (page.tasks[0]) {
      const t = await client.getTask(page.tasks[0].id);
      report.taskReadback = {
        idMatches: t.id === page.tasks[0].id,
        workspaceMatches: t.workspace.id === workspace.id,
        durationType: typeof t.duration,
        hasScheduledStart: !!t.scheduledStart,
        hasScheduledEnd: !!t.scheduledEnd,
        hasChunks: Array.isArray(t.chunks),
      };
    }
  }
  // Written outside the repo by default: the report describes a real account.
  const out = process.env.MOTION_AUDIT_OUT || 'state/live-read-verification.json';
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error('Read-only audit stopped:', e instanceof Error ? e.message : 'unknown error');
  process.exitCode = 1;
} finally {
  client.close();
}
