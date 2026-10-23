import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (the folder holding app/, src/ and .env), used to resolve relative paths such as DATA_DIR=./data. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Start-up configuration from .env. Changing any of it needs a restart. */
export interface Env {
  apiHost: string;
  apiPort: number;
  /** Required as X-API-Key on every /api request except the health check; null turns the check off. */
  apiKey: string | null;
  dataDir: string;
  n8nBaseUrl: string | null;
  /** Local Baserow holding a text-only copy of the library; null when BASEROW_URL or BASEROW_TOKEN is unset. */
  baserow: { baseUrl: string; token: string; tables: { albums: number; photos: number; tags: number } } | null;
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
  /** How long a photo with no album membership is kept before cleanup. */
  assetGraceMs: number;
  /** The .env file secrets are saved to; null keeps changed secrets in memory only. */
  envFile: string | null;
  secrets: Secrets;
}

export interface Secrets {
  DEEPSEEK_API_KEY: string | null;
  OPENAI_API_KEY: string | null;
  N8N_WEBHOOK_SECRET: string | null;
}

export const SECRET_NAMES = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'N8N_WEBHOOK_SECRET'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

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

const secret = (name: SecretName) => process.env[name]?.trim() || null;

export function loadEnv(): Env {
  return {
    apiHost: process.env.API_HOST?.trim() || '127.0.0.1',
    apiPort: int('API_PORT', 3200),
    apiKey: process.env.ALBUM_API_KEY?.trim() || null,
    dataDir: path.resolve(PROJECT_ROOT, process.env.DATA_DIR?.trim() || './data'),
    n8nBaseUrl: optionalUrl('N8N_BASE_URL'),
    baserow: baserowConfig(),
    vllmEnabled: process.env.VLLM_ENABLED === 'true',
    vllmBaseUrl: `http://127.0.0.1:${int('VLLM_PORT', 8000)}`,
    vllmServedModel: 'qwen3-vl-embedding-2b',
    embeddingModelId: 'Qwen/Qwen3-VL-Embedding-2B',
    embeddingRevision: embeddingRevision(),
    embeddingConcurrency: int('VLLM_CONCURRENCY', 6),
    importConcurrency: int('IMPORT_CONCURRENCY', Math.max(1, os.availableParallelism() - 1)),
    maxImportBytes: int('MAX_IMPORT_MB', 200) * 1024 * 1024,
    assetGraceMs: int('ASSET_GRACE_HOURS', 24) * 3600 * 1000,
    envFile: path.join(PROJECT_ROOT, '.env'),
    secrets: { DEEPSEEK_API_KEY: secret('DEEPSEEK_API_KEY'), OPENAI_API_KEY: secret('OPENAI_API_KEY'), N8N_WEBHOOK_SECRET: secret('N8N_WEBHOOK_SECRET') },
  };
}

function baserowConfig(): Env['baserow'] {
  const baseUrl = optionalUrl('BASEROW_URL');
  const token = process.env.BASEROW_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  const table = (name: string) => {
    if (!process.env[name]) throw new Error(`${name} must be set when BASEROW_URL and BASEROW_TOKEN are`);
    return int(name, 0);
  };
  return { baseUrl, token, tables: { albums: table('BASEROW_TABLE_ALBUMS'), photos: table('BASEROW_TABLE_PHOTOS'), tags: table('BASEROW_TABLE_TAGS') } };
}

/** VLLM_REVISION, else the REVISION file written when the model was downloaded. */
function embeddingRevision(): string {
  const explicit = process.env.VLLM_REVISION?.trim();
  if (explicit) return explicit;
  const dir = path.resolve(PROJECT_ROOT, process.env.VLLM_MODEL?.trim() || 'models/Qwen3-VL-Embedding-2B');
  try {
    return fs.readFileSync(path.join(dir, 'REVISION'), 'utf8').trim() || 'local';
  } catch {
    return 'local';
  }
}
