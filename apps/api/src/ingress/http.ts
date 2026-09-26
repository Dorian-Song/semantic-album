import multipart from '@fastify/multipart';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Services } from '../app.js';
import { AppError } from '../shared/errors.js';
import { registerAlbumRoutes } from './albums.routes.js';
import { checkHealth } from './health.js';
import { registerImportRoutes } from './imports.routes.js';
import { registerPhotoRoutes } from './photos.routes.js';
import { registerProcessingRoutes } from './processing.routes.js';
import { registerSettingsRoutes } from './settings.routes.js';

export type LoggerOption = NonNullable<FastifyServerOptions['logger']>;

export function createHttpServer(logger: LoggerOption): FastifyInstance {
  // Per-request lines drown out the useful ones (the UI polls progress); errors are still logged.
  return Fastify({ logger, logController: new LogController({ disableRequestLogging: true }) });
}

export async function registerRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { ctx } = services;

  await app.register(multipart, { limits: { files: 1, fields: 0, fileSize: ctx.env.maxImportBytes + 1 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    const e = err as { validation?: unknown; statusCode?: number; code?: string; message: string };
    if (e.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: e.message } });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.get('/api/health', async (_req, reply) => {
    const health = await checkHealth(ctx.db, ctx.env);
    return reply.code(health.status === 'ok' ? 200 : 503).send(health);
  });

  registerAlbumRoutes(app, services);
  registerPhotoRoutes(app, services);
  registerImportRoutes(app, services);
  registerProcessingRoutes(app, services);
  registerSettingsRoutes(app, services);
}
