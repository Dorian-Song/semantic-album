import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Export } from '../application/export/export.js';
import { Import } from '../application/import/import.js';
import { Library } from '../application/library/library.js';
import { Lifecycle } from '../application/lifecycle/lifecycle.js';
import { Mirror } from '../application/mirror/mirror.js';
import { Processing } from '../application/processing/processing.js';
import { TaskQueue, type QueueOptions } from '../application/processing/queue.js';
import { Query } from '../application/query/query.js';
import { FileStore } from '../data-access/file-store/file-store.js';
import { Repositories } from '../data-access/repositories/index.js';
import { SearchStore } from '../data-access/search-store/search-store.js';
import { openDatabase } from '../database/connection.js';
import { migrate } from '../database/migrate.js';
import { Artifact } from '../infra/artifact/artifact.js';
import type { Embedder } from '../infra/embedding/embedding.js';
import { VllmEmbedder } from '../infra/embedding/vllm.js';
import { Imaging } from '../infra/imaging/imaging.js';
import { createHttpServer, registerRoutes, type LoggerOption } from '../infra/ingress/http.js';
import { removeExpiredIdempotencyKeys } from '../infra/ingress/idempotency.js';
import { Llm } from '../infra/llm/llm.js';
import { Observability } from '../infra/observability/observability.js';
import type { Env } from '../infra/settings/env.js';
import { SecretStore } from '../infra/settings/secrets.js';
import { SettingsService } from '../infra/settings/settings.js';

const CLEANUP_EVERY_MS = 10 * 60_000;
const CLOUD_DELETIONS_EVERY_MS = 60_000;
const BASEROW_MIRROR_EVERY_MS = 60_000;

/** Connects the modules. Background work starts only when `start()` is called. */
export async function createApp(env: Env, logger: LoggerOption = true, queueOptions: Partial<QueueOptions> = {}, embedderOverride?: Embedder) {
  const files = new FileStore(env.dataDir);
  files.prepare();
  const db = openDatabase(path.join(env.dataDir, 'album.sqlite'));
  const applied = migrate(db);
  const repos = new Repositories(db);
  const imaging = await Imaging.create();
  const settings = new SettingsService(repos.settings, new SecretStore(env.secrets, env.envFile));
  const llm = new Llm(settings);
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
  const search = new SearchStore(db, embedder.dimension);

  const app: FastifyInstance = createHttpServer(logger);
  if (applied.length > 0) app.log.info({ applied }, 'database migrations applied');
  app.log.info(Object.fromEntries(Object.entries(imaging.tools).map(([k, v]) => [k, !!v])), 'image decoders detected');

  const queue = new TaskQueue(repos, app.log, queueOptions);
  const processing = new Processing(repos, queue, { files, search, settings, llm, embedder, imaging, embeddingConcurrency: env.embeddingConcurrency });
  const library = new Library(repos, search, processing);
  const artifact = new Artifact(files, imaging, repos, env.maxImportBytes);
  const imports = new Import(repos, files, artifact, library, processing, app.log, { concurrency: env.importConcurrency, maxBytes: env.maxImportBytes });
  const query = new Query(repos, files, search, embedder, settings);
  const exports = new Export(repos, files, app.log);
  const lifecycle = new Lifecycle(repos, files, artifact, search, processing, settings, app.log, env.assetGraceMs);
  const observability = new Observability(env, repos, settings, llm, imaging);
  const mirror = new Mirror(repos, env.baserow && { target: { baseUrl: env.baserow.baseUrl, token: env.baserow.token }, tables: env.baserow.tables }, app.log);

  await registerRoutes(app, { library, query, import: imports, processing, export: exports, lifecycle, settings, observability, mirror, idempotency: repos.idempotency, maxUploadBytes: env.maxImportBytes, apiKey: env.apiKey });

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<unknown>, what: string) => {
    const tick = () => void fn().catch((err) => app.log.error({ err }, `${what} failed`));
    tick();
    const timer = setInterval(tick, ms);
    timer.unref();
    timers.push(timer);
  };

  /**
   * Start-up order: requeue interrupted work, remove leftovers of a crash, load vectors, resume imports and
   * exports, then start background work and timers. (The schema was upgraded when the database opened.)
   */
  async function start(): Promise<void> {
    queue.recover();
    await lifecycle.removeLeftovers();
    search.warm();
    imports.recover();
    exports.recover();
    queue.start();
    every(
      CLEANUP_EVERY_MS,
      async () => {
        await lifecycle.removeUnused();
        await exports.removeExpired();
        removeExpiredIdempotencyKeys(repos.idempotency);
      },
      'clean-up',
    );
    every(CLOUD_DELETIONS_EVERY_MS, () => lifecycle.deleteCloudRecords(), 'cloud record deletion');
    if (env.baserow) every(BASEROW_MIRROR_EVERY_MS, () => mirror.sync(), 'Baserow mirror');
  }

  // Shutdown order: stop accepting requests (Fastify does this first), stop timers, let running work finish, close the database.
  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    await Promise.all([queue.drain(), imports.drain()]);
    db.close();
  });

  return { app, start, modules: { repos, files, search, queue, processing, library, import: imports, query, export: exports, lifecycle, mirror } };
}
