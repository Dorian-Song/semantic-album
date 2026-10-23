import type { FastifyInstance } from 'fastify';
import type { IngressTargets } from '../http.js';

export function registerBaserowRoutes(app: FastifyInstance, { mirror }: IngressTargets): void {
  /** Sync state, plus row counts and top tags read back from Baserow (null when Baserow is not configured). */
  app.get('/api/baserow', async () => ({ ...mirror.status(), overview: await mirror.overview().catch(() => null) }));

  /** Copies the library's text to Baserow now instead of waiting for the next minute. A failure is reported in lastError. */
  app.post('/api/baserow/sync', async () => {
    const status = await mirror.sync().catch(() => mirror.status());
    return { ...status, overview: await mirror.overview().catch(() => null) };
  });
}
