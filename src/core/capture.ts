import { z } from 'zod';
import { MotionApiClient } from '../api/client.js';
import { MotionError } from './errors.js';
import { hash } from './store.js';
import type { MotionTask } from '../types/motion.js';
export const instant = z.string().datetime({ offset: true });
export const meetingSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    startsAt: instant,
    timeZone: z.string().min(1),
    observedAt: instant,
    contextOrigin: z.literal('user_supplied'),
    title: z.string().optional(),
    state: z.enum(['active', 'cancelled']).default('active'),
    bufferMinutes: z.number().int().min(0).max(1440),
  })
  .strict();
export const captureSchema = z
  .object({
    operationKey: z.string().min(8).max(200),
    name: z.string().min(1).max(500),
    workspaceId: z.string().min(1),
    projectId: z.string().optional(),
    durationMinutes: z.number().int().positive(),
    startDate: instant,
    dueDate: instant,
    schedule: z.string().min(1),
    purpose: z.string().min(1),
    nextStep: z.string().min(1),
    sourceReference: z.string().min(1),
    collaborator: z.string().optional(),
    context: z.string().max(10000).optional(),
    kind: z.enum(['work', 'review', 'appointment_booking']).default('work'),
    priority: z.enum(['ASAP', 'HIGH', 'MEDIUM', 'LOW']).optional(),
    deadlineType: z.enum(['HARD', 'SOFT', 'NONE']).optional(),
    authorization: z.enum(['explicit_user_request', 'approved_suggestion']),
    requestEvidence: z
      .object({ kind: z.literal('user_instruction'), reference: z.string().min(1) })
      .strict(),
    meeting: meetingSchema.optional(),
  })
  .strict();
export type CaptureInput = z.input<typeof captureSchema>;
export function schedulingHealth(task: MotionTask, now = new Date()) {
  const observedAt = now.toISOString();
  if (
    (task as MotionTask & { _motion?: { readback?: string } })._motion?.readback === 'unavailable'
  )
    return { state: 'unknown', observedAt, reason: 'readback_unavailable' };
  if (task.completed) return { state: 'completed', observedAt };
  if (typeof task.duration !== 'number' || task.duration <= 0)
    return { state: 'reminder_only', observedAt, reason: 'no_finite_work_duration' };
  const chunks = task.chunks?.length
    ? task.chunks.filter((c) => !c.completedTime)
    : [{ scheduledStart: task.scheduledStart, scheduledEnd: task.scheduledEnd }];
  const blocks = chunks.map((c) => ({ start: c.scheduledStart, end: c.scheduledEnd }));
  const valid = blocks.every(
    (b) =>
      Number.isFinite(Date.parse(b.start || '')) &&
      Number.isFinite(Date.parse(b.end || '')) &&
      Date.parse(b.end!) > Date.parse(b.start!)
  );
  const due = Date.parse(task.dueDate || '');
  const pastDeadline =
    Number.isFinite(due) &&
    (due < now.getTime() || (valid && blocks.some((b) => Date.parse(b.end!) > due)));
  const minutes = valid
    ? blocks.reduce((sum, b) => sum + (Date.parse(b.end!) - Date.parse(b.start!)) / 60000, 0)
    : 0;
  if (pastDeadline)
    return {
      state: 'past_deadline',
      observedAt,
      blocks,
      scheduledMinutes: minutes,
      schedulingIssue: task.schedulingIssue,
    };
  const completedMinutes =
    task.chunks?.filter((c) => c.completedTime).reduce((sum, c) => sum + c.duration, 0) || 0;
  if (
    task.schedulingIssue ||
    !valid ||
    !blocks.length ||
    minutes + completedMinutes < task.duration ||
    blocks.some((b) => Date.parse(b.end!) <= now.getTime())
  )
    return {
      state: 'unscheduled',
      observedAt,
      blocks,
      scheduledMinutes: minutes,
      reason: task.schedulingIssue
        ? 'motion_scheduling_issue'
        : 'missing_or_insufficient_future_time',
    };
  return { state: 'scheduled', observedAt, blocks, scheduledMinutes: minutes };
}
const eventMarker = (meeting: z.infer<typeof meetingSchema>) =>
  `motion-event:${hash(meeting.source + '\n' + meeting.id)}`;
export async function captureTask(client: MotionApiClient, input: unknown, now = new Date()) {
  const x = captureSchema.parse(input);
  if (x.kind === 'appointment_booking' && x.durationMinutes > 15)
    throw new MotionError(
      'duration_cap',
      'Appointment booking is capped at 15 minutes; attending the appointment is a different task.'
    );
  if (Date.parse(x.dueDate) < Date.parse(x.startDate))
    throw new MotionError('invalid_window', 'Due date precedes the requested start date.');
  const schedule = (await client.getSchedule({})).find((s) => s.name === x.schedule);
  if (!schedule)
    throw new MotionError('invalid_schedule', 'Choose an actual named Motion schedule.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone });
  } catch {
    throw new MotionError('invalid_timezone', 'Motion schedule has no usable timezone.');
  }
  let dueDate = x.dueDate;
  let eventContext = '';
  if (x.meeting) {
    const m = x.meeting;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: m.timeZone });
    } catch {
      throw new MotionError('invalid_timezone', 'Meeting timezone is not valid.');
    }
    if (m.state === 'cancelled')
      throw new MotionError(
        'meeting_cancelled',
        'The meeting is cancelled; review the preparation need before scheduling.'
      );
    const deadline = Date.parse(m.startsAt) - m.bufferMinutes * 60000;
    dueDate = new Date(Math.min(Date.parse(dueDate), deadline)).toISOString();
    if (deadline <= Date.parse(x.startDate))
      throw new MotionError(
        'invalid_window',
        'There is no preparation window before this meeting.'
      );
    const existing = (await client.allTasks(x.workspaceId)).filter(
      (t) => t.description?.includes(eventMarker(m)) && !t.completed && !t.status?.isResolvedStatus
    );
    // A known event owns one next preparation action until explicitly revised.
    if (
      existing.length &&
      !existing.some((t) => t.description.includes(`motion-operation:${hash(x.operationKey)}`))
    )
      return {
        write: 'not_sent',
        state: 'existing_meeting_prep',
        taskIds: existing.map((t) => t.id),
        proposedDueDate: dueDate,
        requiresExplicitUpdate: true,
      };
    eventContext = `\n\nMeeting context (user supplied; not independently fetched): ${JSON.stringify(m)}\n${eventMarker(m)}`;
  }
  const provenance = {
    origin_channel: 'external_agent',
    initiated_by: 'user',
    executed_by: 'motion-mcp',
    source_reference: x.sourceReference,
    request_evidence: x.requestEvidence,
    authorization: x.authorization,
  };
  // Observation time is stored in the operation result rather than changing the idempotent payload.
  const description = `Purpose: ${x.purpose}\n\nNext step: ${x.nextStep}\n\nSource: ${x.sourceReference}${x.collaborator ? '\n\nCollaborator: ' + x.collaborator : ''}${x.context ? '\n\nResume context: ' + x.context : ''}\n\nProvenance: ${JSON.stringify(provenance)}${eventContext}`;
  const task = await client.createTask({
    operationKey: x.operationKey,
    intentKey: x.meeting ? eventMarker(x.meeting) : undefined,
    name: x.name,
    workspaceId: x.workspaceId,
    projectId: x.projectId,
    duration: x.durationMinutes,
    dueDate,
    autoScheduled: {
      startDate: x.startDate,
      schedule: x.schedule,
      deadlineType: x.deadlineType || 'SOFT',
    },
    priority: x.priority,
    description,
  });
  return {
    write: 'created_or_reconciled',
    taskId: task.id,
    task,
    scheduling: schedulingHealth(task, now),
    schedule: { name: schedule.name, timeZone: schedule.timezone },
    provenance: { ...provenance, observed_at: now.toISOString() },
  };
}
export async function reviewMeetingPrep(client: MotionApiClient, taskId: string, input: unknown) {
  const meeting = meetingSchema.parse(input);
  const task = await client.getTask(taskId);
  if (!task.description?.includes(eventMarker(meeting)))
    throw new MotionError(
      'event_mismatch',
      'This task is not linked to the supplied event identity.'
    );
  return {
    taskId,
    state: meeting.state === 'cancelled' ? 'review_cancelled_meeting' : 'review_moved_meeting',
    currentDueDate: task.dueDate,
    proposedDueDate:
      meeting.state === 'active'
        ? new Date(Date.parse(meeting.startsAt) - meeting.bufferMinutes * 60000).toISOString()
        : null,
    mutationPerformed: false,
    requiresExplicitUpdate: true,
    scheduling: schedulingHealth(task),
  };
}
export function calendarCapabilities() {
  return {
    workingHours: { state: 'available', source: 'Motion public schedules API' },
    bookableSlots: {
      state: 'unavailable',
      reason: 'No supported programmatic adapter verified; booking UI observation is not a feed.',
      observedAt: null,
    },
    busyIntervals: {
      state: 'unavailable',
      reason: 'No documented Motion endpoint established.',
      observedAt: null,
    },
    meetingMetadata: {
      state: 'unavailable',
      reason: 'Authenticated Motion UI titles do not provide this server calendar access.',
      observedAt: null,
    },
    microsoftAccess: { state: 'not_connected' },
    userSuppliedMeetingContext: true,
  };
}
