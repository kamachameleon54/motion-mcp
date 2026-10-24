import { MotionApiClient } from '../api/client.js';
import { z } from 'zod';
import { Tool } from '../types/tool.js';

export function registerProjectTools(client: MotionApiClient): Tool[] {
  return [
    {
      name: 'motion_list_projects',
      description: 'List all projects, optionally filtered by workspace',
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
        const projects = await client.listProjects(validated.workspaceId);

        return {
          projects,
          count: projects.length,
        };
      },
    },
    {
      name: 'motion_get_project',
      description: 'Get detailed information about a specific project',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The ID of the project to retrieve' },
        },
        required: ['projectId'],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          projectId: z.string().min(1),
        });

        const validated = schema.parse(args);
        return await client.getProject(validated.projectId);
      },
    },
    {
      name: 'motion_create_project',
      description: 'Create a new project in Motion',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name' },
          workspaceId: { type: 'string', description: 'Workspace ID' },
          description: { type: 'string', description: 'Project description' },
          operationKey: { type: 'string' },
          dueDate: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          priority: { type: 'string', enum: ['ASAP', 'HIGH', 'MEDIUM', 'LOW'] },
          projectDefinitionId: { type: 'string' },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                stageDefinitionId: { type: 'string' },
                dueDate: { type: 'string' },
                variableInstances: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { variableName: { type: 'string' }, value: { type: 'string' } },
                    required: ['variableName', 'value'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['stageDefinitionId', 'dueDate'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'workspaceId'],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          name: z.string().min(1),
          workspaceId: z.string().min(1),
          description: z.string().optional(),
          operationKey: z.string().optional(),
          dueDate: z.string().datetime({ offset: true }).optional(),
          labels: z.array(z.string()).optional(),
          priority: z.enum(['ASAP', 'HIGH', 'MEDIUM', 'LOW']).optional(),
          projectDefinitionId: z.string().optional(),
          stages: z
            .array(
              z.object({
                stageDefinitionId: z.string(),
                dueDate: z.string().datetime({ offset: true }),
                variableInstances: z
                  .array(z.object({ variableName: z.string(), value: z.string() }))
                  .optional(),
              })
            )
            .optional(),
        });

        const validated = schema.parse(args);
        if (validated.projectDefinitionId && !validated.stages?.length)
          throw new Error('Template projects require stages.');
        return await client.createProject(validated);
      },
    },
    {
      name: 'motion_update_project',
      description: 'Update an existing project',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID to update' },
          name: { type: 'string', description: 'New project name' },
          description: { type: 'string', description: 'New project description' },
          status: { type: 'string', description: 'New project status' },
        },
        required: ['projectId'],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          projectId: z.string().min(1),
          name: z.string().optional(),
          description: z.string().optional(),
          status: z.string().optional(),
        });

        const { projectId, ...updateParams } = schema.parse(args);

        // Only include non-undefined fields
        const filteredParams: any = {};
        if (updateParams.name !== undefined) filteredParams.name = updateParams.name;
        if (updateParams.description !== undefined)
          filteredParams.description = updateParams.description;
        if (updateParams.status !== undefined) filteredParams.status = updateParams.status;

        return await client.updateProject(projectId, filteredParams);
      },
    },
    {
      name: 'motion_delete_project',
      description: 'Delete a project permanently',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID to delete' },
        },
        required: ['projectId'],
      },
      handler: async (args: unknown) => {
        const schema = z.object({
          projectId: z.string().min(1),
        });

        const validated = schema.parse(args);
        await client.deleteProject(validated.projectId);
        return { success: true, message: `Project ${validated.projectId} deleted successfully` };
      },
    },
  ];
}
