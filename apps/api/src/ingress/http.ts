import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.js';
import type { Env } from '../config/env.js';
import { checkHealth } from './health.js';

export function buildServer(db: Db, env: Env): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.get('/api/health', async (_req, reply) => {
    const health = await checkHealth(db, env);
    return reply.code(health.status === 'ok' ? 200 : 503).send(health);
  });

  return app;
}
