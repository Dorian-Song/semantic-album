import type { Env } from './config/env.js';
import type { Db } from './db/connection.js';
import type { DecoderTools } from './assets/derivatives.js';
import type { ObjectStore } from './storage/object-store.js';
import type { KeyedMutex } from './shared/keyed-mutex.js';

/** Shared infrastructure handed to services. */
export interface AppContext {
  env: Env;
  db: Db;
  store: ObjectStore;
  tools: DecoderTools;
  /** Per-SHA-256 lock shared by ingestion and garbage collection. */
  shaLocks: KeyedMutex;
}
