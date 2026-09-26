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
  };
}
