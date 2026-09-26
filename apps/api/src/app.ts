import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AlbumService } from './albums/album-service.js';
import { AssetService } from './assets/asset-service.js';
import { detectDecoderTools } from './assets/derivatives.js';
import type { Env } from './config/env.js';
import type { AppContext } from './context.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ImportService } from './imports/import-service.js';
import { createHttpServer, registerRoutes, type LoggerOption } from './ingress/http.js';
import { pruneIdempotencyKeys } from './ingress/idempotency.js';
import { ExportService } from './exports/export-service.js';
import { PhotoQueries } from './photos/photo-queries.js';
import { EnrichmentWorker, PurgeWorker } from './automation/enrichment-service.js';
import { VllmEmbedder } from './inference/vllm-client.js';
import type { Embedder } from './inference/embedder.js';
import { CaptionWorker } from './processing/caption-worker.js';
import { EmbeddingWorker } from './processing/embedding-worker.js';
import { SearchService } from './search/search-service.js';
import { VectorIndex } from './search/vector-index.js';
import { TaskService, type TaskOptions } from './processing/task-service.js';
import { SettingsService } from './settings/settings-service.js';
import { KeyedMutex } from './shared/keyed-mutex.js';
import { ensureDataDir } from './storage/data-dir.js';
import { GarbageCollector } from './storage/garbage-collector.js';
import { ObjectStore } from './storage/object-store.js';

export interface Services {
  ctx: AppContext;
  store: ObjectStore;
  albums: AlbumService;
  assets: AssetService;
  photos: PhotoQueries;
  imports: ImportService;
  tasks: TaskService;
  settings: SettingsService;
  purge: PurgeWorker;
  search: SearchService;
  exports: ExportService;
  gc: GarbageCollector;
}

/** Composition root: storage, database, services, and routes. Background work is started by the caller. */
export async function createApp(
  env: Env,
  logger: LoggerOption = true,
  taskOptions: Partial<TaskOptions> = {},
  embedderOverride?: Embedder,
): Promise<{ app: FastifyInstance; services: Services }> {
  ensureDataDir(env.dataDir);
  const db = openDatabase(path.join(env.dataDir, 'album.sqlite'));
  const applied = migrate(db);
  const store = new ObjectStore(env.dataDir);
  const tools = await detectDecoderTools();
  const ctx: AppContext = { env, db, store, tools, shaLocks: new KeyedMutex() };

  const app = createHttpServer(logger);
  if (applied.length > 0) app.log.info({ applied }, 'database migrations applied');
  app.log.info({ heifDec: !!tools.heifDec, ffmpeg: !!tools.ffmpeg, magick: !!tools.magick }, 'image decoders detected');

  const albums = new AlbumService(db);
  const tasks = new TaskService(ctx, app.log, taskOptions);
  const settings = new SettingsService(db);
  tasks.register('caption', new CaptionWorker(ctx, settings, tasks, tasks.maxAttempts));
  tasks.register('enrichment', new EnrichmentWorker(ctx, settings));
  const embedder =
    embedderOverride ??
    new VllmEmbedder({
      enabled: env.vllmEnabled,
      baseUrl: env.vllmBaseUrl,
      servedModel: env.vllmServedModel,
      modelId: env.embeddingModelId,
      revision: env.embeddingRevision,
      dimension: 2048,
    });
  const vectors = new VectorIndex(db, embedder.dimension);
  const exports = new ExportService(ctx, app.log);
  tasks.register('embedding', new EmbeddingWorker(ctx, embedder, vectors, env.embeddingConcurrency));
  const assets = new AssetService(ctx, albums, tasks);
  const services: Services = {
    ctx,
    store,
    albums,
    assets,
    photos: new PhotoQueries(db),
    imports: new ImportService(ctx, albums, assets, app.log),
    tasks,
    settings,
    purge: new PurgeWorker(ctx, settings, app.log),
    search: new SearchService(db, settings, vectors, embedder),
    exports,
    gc: new GarbageCollector(ctx, app.log, [() => exports.removeExpired(), async () => pruneIdempotencyKeys(db)]),
  };
  await registerRoutes(app, services);
  app.addHook('onClose', async () => {
    services.gc.stop();
    services.purge.stop();
    await Promise.all([services.tasks.drain(), services.imports.drain()]);
    db.close();
  });
  return { app, services };
}
