import { MotionApiClient } from '../api/client.js';
import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { normalizeDuration } from '../types/duration.js';

export function registerRecurringTaskTools(client: MotionApiClient): Tool[] {
  return [
    {
      name: 'motion_list_recurring_tasks',
      description: 'List all recurring tasks, optionally filtered by workspace',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Filter by workspace ID' },
        },
        required: [],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          workspaceId: z.string().optional(),
        });

        const validated = schema.parse(args);
        const recurringTasks = await client.listRecurringTasks(validated.workspaceId);

        return {
          recurringTasks,
          count: recurringTasks.length,
        };
      },
    },
    {
      name: 'motion_create_recurring_task',
      description:
        'Create a task that repeats on a schedule (daily, weekly, every other week, monthly, quarterly). This is the only way to make work recur in Motion. To make an existing one-off task recurring, create a recurring task with the same details, then offer to delete the one-off with motion_delete_task. Motion cannot edit a recurring task: to change one, delete it with motion_delete_recurring_task and create it again. assigneeId is required; use motion_get_current_user for the API owner.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Recurring task name' },
          workspaceId: { type: 'string', description: 'Workspace ID' },
          frequency: {
            type: 'string',
            description:
              'Motion frequency string (not DAILY or an RRULE). Day codes MO TU WE TH FR SA SU; DAYS is a bracketed list like [MO, WE, FR]. ' +
              'Daily: daily_every_day, daily_every_week_day, daily_specific_days_DAYS (e.g. daily_specific_days_[MO, WE, FR] = every Mon, Wed and Fri). ' +
              'Weekly (once per week on one of the days): weekly_any_day, weekly_any_week_day, weekly_specific_days_DAYS. ' +
              'Every other week: biweekly_first_week_any_day, biweekly_first_week_any_week_day, biweekly_first_week_specific_days_DAYS, biweekly_second_week_any_day, biweekly_second_week_any_week_day. ' +
              'Monthly: monthly_first_MO (first|second|third|fourth|last + one day code), monthly_15 (day of month 1-31; short months use the last day), monthly_last_day_of_month, monthly_any_day_of_month, monthly_any_week_day_of_month, monthly_any_day_first_week, monthly_any_week_day_last_week (first|second|third|fourth|last week). ' +
              'Quarterly: quarterly_first_day, quarterly_first_week_day, quarterly_first_MO, quarterly_last_day, quarterly_last_week_day, quarterly_last_FR, quarterly_any_day_first_week, quarterly_any_day_second_week, quarterly_any_day_last_week, quarterly_any_day_first_month, quarterly_any_day_second_month.',
          },
          operationKey: { type: 'string' },
          startingOn: { type: 'string', description: 'First date, ISO 8601 (YYYY-MM-DD)' },
          idealTime: {
            type: 'string',
            pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
            description: 'Preferred start time HH:mm, used when free',
          },
          schedule: { type: 'string', description: 'Named schedule; defaults to Work Hours' },
          deadlineType: { type: 'string', enum: ['HARD', 'SOFT'] },
          priority: { type: 'string', enum: ['HIGH', 'MEDIUM'] },
          duration: {
            type: ['string', 'number'],
            description: 'REMINDER or positive integer minutes',
          },
          description: { type: 'string', description: 'Task description' },

          assigneeId: { type: 'string', description: 'User ID to assign to' },
        },
        required: ['name', 'workspaceId', 'frequency', 'assigneeId'],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          name: z.string().min(1),
          workspaceId: z.string().min(1),
          frequency: z.string().min(1),
          operationKey: z.string().optional(),
          startingOn: z.string().optional(),
          idealTime: z.string().optional(),
          schedule: z.string().optional(),
          deadlineType: z.enum(['HARD', 'SOFT']).optional(),
          priority: z.enum(['HIGH', 'MEDIUM']).optional(),
          duration: z.union([z.string(), z.number()]).optional(),
          description: z.string().optional(),

          assigneeId: z.string().optional(),
        });

        const validated = schema.parse(args);
        validated.duration = normalizeDuration(validated.duration);
        return await client.createRecurringTask(validated);
      },
    },
    {
      name: 'motion_get_recurring_task',
      description: 'Get details of a specific recurring task',
      inputSchema: {
        type: 'object',
        properties: {
          recurringTaskId: { type: 'string', description: 'Recurring task ID to retrieve' },
        },
        required: ['recurringTaskId'],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          recurringTaskId: z.string().min(1),
        });

        const validated = schema.parse(args);
        return await client.getRecurringTask(validated.recurringTaskId);
      },
    },
    {
      name: 'motion_update_recurring_task',
      description: 'Update an existing recurring task',
      inputSchema: {
        type: 'object',
        properties: {
          recurringTaskId: { type: 'string', description: 'Recurring task ID to update' },
          name: { type: 'string', description: 'New name' },
          frequency: {
            type: 'string',
            enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'],
            description: 'New frequency',
          },
          recurrenceRule: { type: 'string', description: 'New recurrence rule' },
          duration: {
            type: ['string', 'number'],
            description: 'New duration',
          },
          description: { type: 'string', description: 'New description' },
          projectId: { type: 'string', description: 'New project ID' },
          assigneeId: { type: 'string', description: 'New assignee ID' },
        },
        required: ['recurringTaskId'],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          recurringTaskId: z.string().min(1),
          name: z.string().optional(),
          frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).optional(),
          recurrenceRule: z.string().optional(),
          duration: z.union([z.string(), z.number()]).optional(),
          description: z.string().optional(),
          projectId: z.string().optional(),
          assigneeId: z.string().optional(),
        });

        const { recurringTaskId, ...updateParams } = schema.parse(args);
        updateParams.duration = normalizeDuration(updateParams.duration);

        // Filter out undefined values
        const filteredParams: any = {};
        Object.keys(updateParams).forEach((key) => {
          if ((updateParams as any)[key] !== undefined) {
            filteredParams[key] = (updateParams as any)[key];
          }
        });

        return await client.updateRecurringTask(recurringTaskId, filteredParams);
      },
    },
    {
      name: 'motion_delete_recurring_task',
      description: 'Delete a recurring task permanently',
      inputSchema: {
        type: 'object',
        properties: {
          recurringTaskId: { type: 'string', description: 'Recurring task ID to delete' },
        },
        required: ['recurringTaskId'],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          recurringTaskId: z.string().min(1),
        });

        const validated = schema.parse(args);
        await client.deleteRecurringTask(validated.recurringTaskId);
        return {
          success: true,
          message: `Recurring task ${validated.recurringTaskId} deleted successfully`,
        };
      },
    },
  ];
}
