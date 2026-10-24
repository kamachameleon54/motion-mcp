import { MotionApiClient } from '../api/client.js';
import { z } from 'zod';
import { Tool } from '../types/tool.js';

export function registerScheduleTools(client: MotionApiClient): Tool[] {
  return [
    {
      name: 'motion_get_schedule',
      description:
        'Get the API owner’s named weekly working windows and time zones. These are not calendar events, busy intervals, or bookable slots.',
      inputSchema: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'User ID to get schedule for' },
          startDate: {
            type: 'string',
            description: 'Start date in YYYY-MM-DD format',
          },
          endDate: {
            type: 'string',
            description: 'End date in YYYY-MM-DD format',
          },
        },
        required: [],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          userId: z.string().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
        });

        const validated = schema.parse(args);
        const schedules = await client.getSchedule(validated);

        return {
          schedules,
          count: schedules.length,
        };
      },
    },
  ];
}
