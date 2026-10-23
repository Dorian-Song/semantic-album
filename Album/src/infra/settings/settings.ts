import type { RuntimeSettings, SearchMode, SettingsColumn, SettingsRepository } from '../../data-access/repositories/settings.js';
import { badRequest } from '../../shared/errors.js';
import { nowIso } from '../../shared/ids.js';
import type { SecretStore } from './secrets.js';

export type { SearchMode };

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

export interface SecretState {
  saved: boolean;
  last4: string | null;
}

/** What the browser sees: secrets are replaced by "is one saved" plus its last four characters. */
export interface PublicSettings extends Omit<Settings, 'deepseek' | 'openai' | 'n8n'> {
  deepseek: { baseUrl: string; model: string; apiKey: SecretState };
  openai: { baseUrl: string; model: string | null; apiKey: SecretState; fallbackEnabled: boolean };
  n8n: { webhookUrl: string | null; secret: SecretState };
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

function secretState(value: string | null): SecretState {
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

const cleanSecret = (v: string | null) => (v === null ? null : v.trim() || null);

/**
 * The current configuration for every module. Runtime settings live in the database and apply at once; API
 * keys and the webhook secret live only in .env. Read on every use, so changes need no restart.
 */
export class SettingsService {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly secrets: SecretStore,
  ) {}

  get(): Settings {
    const r: RuntimeSettings = this.repo.get();
    return {
      ...r,
      deepseek: { ...r.deepseek, apiKey: this.secrets.get('DEEPSEEK_API_KEY') },
      openai: { ...r.openai, apiKey: this.secrets.get('OPENAI_API_KEY') },
      n8n: { ...r.n8n, secret: this.secrets.get('N8N_WEBHOOK_SECRET') },
    };
  }

  getPublic(): PublicSettings {
    const s = this.get();
    return {
      ...s,
      deepseek: { ...s.deepseek, apiKey: secretState(s.deepseek.apiKey) },
      openai: { ...s.openai, apiKey: secretState(s.openai.apiKey) },
      n8n: { webhookUrl: s.n8n.webhookUrl, secret: secretState(s.n8n.secret) },
    };
  }

  /** Validates every field first, so an invalid change leaves the settings as they were. */
  update(u: SettingsUpdate): PublicSettings {
    const values: Partial<Record<SettingsColumn, string | number | null>> = {};
    if (u.captionsEnabled !== undefined) values.captions_enabled = u.captionsEnabled ? 1 : 0;
    if (u.deepseek?.baseUrl !== undefined) values.deepseek_base_url = httpUrl(u.deepseek.baseUrl, 'DeepSeek base URL');
    if (u.deepseek?.model !== undefined) values.deepseek_model = u.deepseek.model.trim() || 'deepseek-flash';
    if (u.openai?.baseUrl !== undefined) values.openai_base_url = httpUrl(u.openai.baseUrl, 'OpenAI base URL');
    if (u.openai?.model !== undefined) values.openai_model = u.openai.model?.trim() || null;
    if (u.openai?.fallbackEnabled !== undefined) values.openai_fallback_enabled = u.openai.fallbackEnabled ? 1 : 0;
    if (u.n8n?.webhookUrl !== undefined) values.n8n_webhook_url = u.n8n.webhookUrl?.trim() ? httpUrl(u.n8n.webhookUrl, 'n8n webhook URL') : null;
    if (u.defaultSearchMode !== undefined) values.default_search_mode = u.defaultSearchMode;
    if (u.captionConcurrency !== undefined) values.caption_concurrency = u.captionConcurrency;
    if (u.enrichmentConcurrency !== undefined) values.enrichment_concurrency = u.enrichmentConcurrency;

    this.repo.update(values, nowIso());
    if (u.deepseek?.apiKey !== undefined) this.secrets.set('DEEPSEEK_API_KEY', cleanSecret(u.deepseek.apiKey));
    if (u.openai?.apiKey !== undefined) this.secrets.set('OPENAI_API_KEY', cleanSecret(u.openai.apiKey));
    if (u.n8n?.secret !== undefined) this.secrets.set('N8N_WEBHOOK_SECRET', cleanSecret(u.n8n.secret));
    return this.getPublic();
  }
}
