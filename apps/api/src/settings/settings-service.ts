import type { Db } from '../db/connection.js';
import { badRequest } from '../shared/errors.js';
import { nowIso } from '../shared/ids.js';

export type SearchMode = 'words' | 'meaning' | 'both';

/** Full settings, including secrets. Server-side only. */
export interface Settings {
  captionsEnabled: boolean;
  deepseek: { baseUrl: string; model: string; apiKey: string | null };
  openai: { baseUrl: string; model: string | null; apiKey: string | null; fallbackEnabled: boolean };
  n8n: { webhookUrl: string | null; secret: string | null };
  defaultSearchMode: SearchMode;
  captionConcurrency: number;
  enrichmentConcurrency: number;
}

/** What the browser sees: secrets are replaced by "is one saved" plus its last four characters. */
export interface PublicSettings {
  captionsEnabled: boolean;
  deepseek: { baseUrl: string; model: string; apiKey: SecretState };
  openai: { baseUrl: string; model: string | null; apiKey: SecretState; fallbackEnabled: boolean };
  n8n: { webhookUrl: string | null; secret: SecretState };
  defaultSearchMode: SearchMode;
  captionConcurrency: number;
  enrichmentConcurrency: number;
}

export interface SecretState {
  saved: boolean;
  last4: string | null;
}

/** A secret in an update: a string replaces it, null removes it, absent leaves it unchanged. */
type SecretUpdate = string | null | undefined;

export interface SettingsUpdate {
  captionsEnabled?: boolean;
  deepseek?: { baseUrl?: string; model?: string; apiKey?: SecretUpdate };
  openai?: { baseUrl?: string; model?: string | null; apiKey?: SecretUpdate; fallbackEnabled?: boolean };
  n8n?: { webhookUrl?: string | null; secret?: SecretUpdate };
  defaultSearchMode?: SearchMode;
  captionConcurrency?: number;
  enrichmentConcurrency?: number;
}

interface Row {
  captions_enabled: number;
  deepseek_base_url: string;
  deepseek_model: string;
  deepseek_api_key: string | null;
  openai_base_url: string;
  openai_model: string | null;
  openai_api_key: string | null;
  openai_fallback_enabled: number;
  n8n_webhook_url: string | null;
  n8n_webhook_secret: string | null;
  default_search_mode: SearchMode;
  caption_concurrency: number;
  enrichment_concurrency: number;
}

function secret(value: string | null): SecretState {
  return value ? { saved: true, last4: value.length > 8 ? value.slice(-4) : null } : { saved: false, last4: null };
}

function httpUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw badRequest('invalid_url', `${field} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('invalid_url', `${field} must start with http:// or https://`);
  return url.toString().replace(/\/$/, '');
}

function cleanSecret(v: string): string | null {
  const t = v.trim();
  return t === '' ? null : t;
}

/** The single settings row. Read on every use, so changes apply without a restart. */
export class SettingsService {
  constructor(private readonly db: Db) {}

  get(): Settings {
    const r = this.db.prepare('SELECT * FROM model_config WHERE id = 1').get() as Row;
    return {
      captionsEnabled: r.captions_enabled === 1,
      deepseek: { baseUrl: r.deepseek_base_url, model: r.deepseek_model, apiKey: r.deepseek_api_key },
      openai: { baseUrl: r.openai_base_url, model: r.openai_model, apiKey: r.openai_api_key, fallbackEnabled: r.openai_fallback_enabled === 1 },
      n8n: { webhookUrl: r.n8n_webhook_url, secret: r.n8n_webhook_secret },
      defaultSearchMode: r.default_search_mode,
      captionConcurrency: r.caption_concurrency,
      enrichmentConcurrency: r.enrichment_concurrency,
    };
  }

  getPublic(): PublicSettings {
    const s = this.get();
    return {
      ...s,
      deepseek: { ...s.deepseek, apiKey: secret(s.deepseek.apiKey) },
      openai: { ...s.openai, apiKey: secret(s.openai.apiKey) },
      n8n: { webhookUrl: s.n8n.webhookUrl, secret: secret(s.n8n.secret) },
    };
  }

  update(u: SettingsUpdate): PublicSettings {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (u.captionsEnabled !== undefined) set('captions_enabled', u.captionsEnabled ? 1 : 0);
    if (u.deepseek?.baseUrl !== undefined) set('deepseek_base_url', httpUrl(u.deepseek.baseUrl, 'DeepSeek base URL'));
    if (u.deepseek?.model !== undefined) set('deepseek_model', u.deepseek.model.trim() || 'deepseek-flash');
    if (u.deepseek?.apiKey !== undefined) set('deepseek_api_key', u.deepseek.apiKey === null ? null : cleanSecret(u.deepseek.apiKey));
    if (u.openai?.baseUrl !== undefined) set('openai_base_url', httpUrl(u.openai.baseUrl, 'OpenAI base URL'));
    if (u.openai?.model !== undefined) set('openai_model', u.openai.model?.trim() || null);
    if (u.openai?.apiKey !== undefined) set('openai_api_key', u.openai.apiKey === null ? null : cleanSecret(u.openai.apiKey));
    if (u.openai?.fallbackEnabled !== undefined) set('openai_fallback_enabled', u.openai.fallbackEnabled ? 1 : 0);
    if (u.n8n?.webhookUrl !== undefined) set('n8n_webhook_url', u.n8n.webhookUrl?.trim() ? httpUrl(u.n8n.webhookUrl, 'n8n webhook URL') : null);
    if (u.n8n?.secret !== undefined) set('n8n_webhook_secret', u.n8n.secret === null ? null : cleanSecret(u.n8n.secret));
    if (u.defaultSearchMode !== undefined) set('default_search_mode', u.defaultSearchMode);
    if (u.captionConcurrency !== undefined) set('caption_concurrency', u.captionConcurrency);
    if (u.enrichmentConcurrency !== undefined) set('enrichment_concurrency', u.enrichmentConcurrency);
    if (sets.length > 0) {
      set('updated_at', nowIso());
      this.db.prepare(`UPDATE model_config SET ${sets.join(', ')} WHERE id = 1`).run(...values);
    }
    return this.getPublic();
  }
}
