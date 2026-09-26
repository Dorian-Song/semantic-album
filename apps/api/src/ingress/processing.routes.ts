import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.js';
import { PROMPT_REVISION } from '../adapters/vision-provider.js';
import { TASK_KINDS, type TaskKind } from '../processing/task-service.js';
import { idParams } from './schemas.js';

export function registerProcessingRoutes(app: FastifyInstance, { tasks, ctx }: Services): void {
  app.get('/api/processing', async () => ({ kinds: tasks.summary(), outdatedDescriptions: outdated().length }));

  /** Photos whose AI description predates the current prompt (or that have none). */
  const outdated = () =>
    ctx.db
      .prepare(
        `SELECT a.id FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
          WHERE a.orphaned_at IS NULL AND EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id)
            AND (d.asset_id IS NULL OR d.ai_caption IS NULL OR COALESCE(d.prompt_revision, 0) < ?)`,
      )
      .pluck()
      .all(PROMPT_REVISION) as string[];

  /** Re-describe outdated photos with the current prompt. Manual descriptions are kept. */
  app.post('/api/processing/caption/refresh-outdated', async () => {
    const ids = outdated();
    for (const id of ids) tasks.enqueueNextRevision(id, 'caption');
    return { queued: ids.length };
  });

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
