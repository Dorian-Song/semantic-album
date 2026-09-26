import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, used to resolve relative paths such as DATA_DIR=./data. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface Env {
  apiHost: string;
  apiPort: number;
  dataDir: string;
  n8nBaseUrl: string | null;
  vllmEnabled: boolean;
  vllmBaseUrl: string;
  /** Name the vLLM server exposes the model under (--served-model-name). */
  vllmServedModel: string;
  /** Recorded with the vector index, which refuses to mix models. */
  embeddingModelId: string;
  embeddingRevision: string;
  /** Image embedding requests in flight; vLLM batches them on the GPU. */
  embeddingConcurrency: number;
  /** Parallel file ingestions (hash + decode + derivatives). */
  importConcurrency: number;
  /** Files larger than this are skipped as too_large. */
  maxImportBytes: number;
  /** How long an asset with no album membership is kept before cleanup. */
  assetGraceMs: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

function optionalUrl(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  return new URL(raw).toString().replace(/\/$/, '');
}

export function loadEnv(): Env {
  return {
    apiHost: process.env.API_HOST?.trim() || '127.0.0.1',
    apiPort: int('API_PORT', 3200),
    dataDir: path.resolve(REPO_ROOT, process.env.DATA_DIR?.trim() || './data'),
    n8nBaseUrl: optionalUrl('N8N_BASE_URL'),
    vllmEnabled: process.env.VLLM_ENABLED === 'true',
    vllmBaseUrl: `http://127.0.0.1:${int('VLLM_PORT', 8000)}`,
    vllmServedModel: 'qwen3-vl-embedding-2b',
    embeddingModelId: 'Qwen/Qwen3-VL-Embedding-2B',
    embeddingRevision: embeddingRevision(),
    embeddingConcurrency: int('VLLM_CONCURRENCY', 6),
    importConcurrency: int('IMPORT_CONCURRENCY', Math.max(1, os.availableParallelism() - 1)),
    maxImportBytes: int('MAX_IMPORT_MB', 200) * 1024 * 1024,
    assetGraceMs: int('ASSET_GRACE_HOURS', 24) * 3600 * 1000,
  };
}

/** VLLM_REVISION, else the REVISION file written when the model was downloaded into models/. */
function embeddingRevision(): string {
  const explicit = process.env.VLLM_REVISION?.trim();
  if (explicit) return explicit;
  const dir = path.resolve(REPO_ROOT, process.env.VLLM_MODEL?.trim() || 'models/Qwen3-VL-Embedding-2B');
  try {
    return fs.readFileSync(path.join(dir, 'REVISION'), 'utf8').trim() || 'local';
  } catch {
    return 'local';
  }
}
