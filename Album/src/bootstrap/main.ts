import { loadEnv } from '../infra/settings/env.js';
import { createApp } from './app.js';

const env = loadEnv();
const { app, start } = await createApp(env, { level: process.env.LOG_LEVEL ?? 'info' });
await start();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.apiHost, port: env.apiPort });
