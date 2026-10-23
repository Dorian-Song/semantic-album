import type { FastifyInstance } from 'fastify';
import { TASK_KINDS, type TaskKind } from '../../../data-access/repositories/tasks.js';
import type { IngressTargets } from '../http.js';
import { idParams } from '../schemas.js';

export function registerProcessingRoutes(app: FastifyInstance, { processing }: IngressTargets): void {
  app.get('/api/processing', async () => ({ kinds: processing.summary(), outdatedDescriptions: processing.outdatedCount() }));

  /** Re-describe outdated photos with the current prompt. User descriptions are kept. */
  app.post('/api/processing/caption/refresh-outdated', async () => ({ queued: processing.refreshOutdated() }));

  app.post<{ Params: { kind: TaskKind } }>(
    '/api/processing/:kind/retry-failed',
    { schema: { params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: [...TASK_KINDS] } } } } },
    async (req) => ({ requeued: processing.retryFailed(req.params.kind) }),
  );

  app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', { schema: { params: idParams } }, async (req, reply) => {
    processing.retry(req.params.id);
    return reply.code(204).send();
  });
}
