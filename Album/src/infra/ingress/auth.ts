import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Every /api request except the health check must carry `X-API-Key`. The web app never sees the key: the
 * Vite dev proxy adds it. A null key turns the check off.
 */
export function registerApiKey(app: FastifyInstance, apiKey: string | null): void {
  if (!apiKey) {
    app.log.warn('ALBUM_API_KEY is not set; the API accepts requests without a key');
    return;
  }
  const expected = digest(apiKey);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    const given = req.headers['x-api-key'];
    if (typeof given === 'string' && timingSafeEqual(digest(given), expected)) return;
    req.log.warn({ method: req.method, url: req.url, ip: req.ip }, 'rejected request without a valid API key');
    return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid X-API-Key' } });
  });
}
