import multipart from '@fastify/multipart';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Export } from '../../application/export/export.js';
import type { Import } from '../../application/import/import.js';
import type { Library } from '../../application/library/library.js';
import type { Lifecycle } from '../../application/lifecycle/lifecycle.js';
import type { Mirror } from '../../application/mirror/mirror.js';
import type { Processing } from '../../application/processing/processing.js';
import type { Query } from '../../application/query/query.js';
import type { IdempotencyRepository } from '../../data-access/repositories/idempotency.js';
import { AppError } from '../../shared/errors.js';
import type { Observability } from '../observability/observability.js';
import type { SettingsService } from '../settings/settings.js';
import { registerApiKey } from './auth.js';
import { registerIdempotency } from './idempotency.js';
import { registerAlbumRoutes } from './routes/albums.js';
import { registerBaserowRoutes } from './routes/baserow.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerPhotoRoutes } from './routes/photos.js';
import { registerProcessingRoutes } from './routes/processing.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSettingsRoutes } from './routes/settings.js';

export type LoggerOption = NonNullable<FastifyServerOptions['logger']>;

/** The modules requests are handed to. */
export interface IngressTargets {
  library: Library;
  query: Query;
  import: Import;
  processing: Processing;
  export: Export;
  lifecycle: Lifecycle;
  settings: SettingsService;
  observability: Observability;
  mirror: Mirror;
  idempotency: IdempotencyRepository;
  maxUploadBytes: number;
  apiKey: string | null;
}

export function createHttpServer(logger: LoggerOption): FastifyInstance {
  // Per-request lines drown out the useful ones (the UI polls progress); errors are still logged.
  // Fastify's default silently drops fields a schema does not allow; reject them instead so a typo is a 400.
  return Fastify({ logger, logController: new LogController({ disableRequestLogging: true }), ajv: { customOptions: { removeAdditional: false } } });
}

/**
 * The only entry point for requests: checks their form, hands them to the right module, and turns results and
 * errors into one reply format without exposing internal details.
 */
export async function registerRoutes(app: FastifyInstance, t: IngressTargets): Promise<void> {
  registerApiKey(app, t.apiKey);
  await app.register(multipart, { limits: { files: 1, fields: 0, fileSize: t.maxUploadBytes + 1 } });
  registerIdempotency(app, t.idempotency);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    const e = err as { validation?: unknown; statusCode?: number; code?: string; message: string };
    if (e.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: e.message } });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.get('/api/health', async (_req, reply) => {
    const health = await t.observability.health();
    return reply.code(health.status === 'ok' ? 200 : 503).send(health);
  });

  registerAlbumRoutes(app, t);
  registerPhotoRoutes(app, t);
  registerImportRoutes(app, t);
  registerProcessingRoutes(app, t);
  registerSettingsRoutes(app, t);
  registerSearchRoutes(app, t);
  registerExportRoutes(app, t);
  registerBaserowRoutes(app, t);
}
