import { createApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const { app, services } = await createApp(env, { level: process.env.LOG_LEVEL ?? 'info' });

services.imports.recover();
services.gc.start();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.apiHost, port: env.apiPort });
