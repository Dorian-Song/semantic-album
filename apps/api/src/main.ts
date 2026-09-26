import path from 'node:path';
import { loadEnv } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureDataDir } from './storage/data-dir.js';
import { buildServer } from './ingress/http.js';

const env = loadEnv();
ensureDataDir(env.dataDir);

const db = openDatabase(path.join(env.dataDir, 'album.sqlite'));
const applied = migrate(db);

const app = buildServer(db, env);
if (applied.length > 0) app.log.info({ applied }, 'database migrations applied');

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.apiHost, port: env.apiPort });
