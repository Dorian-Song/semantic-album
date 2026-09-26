import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.js';
import { TASK_KINDS, type TaskKind } from '../processing/task-service.js';
import { idParams } from './schemas.js';

export function registerProcessingRoutes(app: FastifyInstance, { tasks }: Services): void {
  app.get('/api/processing', async () => ({ kinds: tasks.summary() }));

  app.post<{ Params: { kind: TaskKind } }>(
    '/api/processing/:kind/retry-failed',
    { schema: { params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: [...TASK_KINDS] } } } } },
    async (req) => ({ requeued: tasks.retryFailed(req.params.kind) }),
  );

  app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', { schema: { params: idParams } }, async (req, reply) => {
    tasks.retry(req.params.id);
    return reply.code(204).send();
  });
}
