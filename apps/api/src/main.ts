import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { reconcileStorage } from './storage/reconcile.js';

const env = loadEnv();
const { app, services } = await createApp(env, { level: process.env.LOG_LEVEL ?? 'info' });

// Startup recovery: requeue interrupted work, clear leftovers of a crash, then resume.
services.tasks.recover();
await reconcileStorage(services.ctx, app.log);
services.imports.recover();
services.exports.recover();
services.tasks.start();
services.gc.start();
services.purge.start();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.apiHost, port: env.apiPort });
