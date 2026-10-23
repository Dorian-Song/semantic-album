import type { Db } from '../../database/connection.js';

export type SearchMode = 'words' | 'meaning' | 'both';

/** Settings changed on the settings page (model_config); secrets are not stored here. */
export interface RuntimeSettings {
  captionsEnabled: boolean;
  deepseek: { baseUrl: string; model: string };
  openai: { baseUrl: string; model: string | null; fallbackEnabled: boolean };
  n8n: { webhookUrl: string | null };
  defaultSearchMode: SearchMode;
  captionConcurrency: number;
  enrichmentConcurrency: number;
}

interface Row {
  captions_enabled: number;
  deepseek_base_url: string;
  deepseek_model: string;
  openai_base_url: string;
  openai_model: string | null;
  openai_fallback_enabled: number;
  n8n_webhook_url: string | null;
  default_search_mode: SearchMode;
  caption_concurrency: number;
  enrichment_concurrency: number;
}

export type SettingsColumn = keyof Row;

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  get(): RuntimeSettings {
    const r = this.db.prepare('SELECT * FROM model_config WHERE id = 1').get() as Row;
    return {
      captionsEnabled: r.captions_enabled === 1,
      deepseek: { baseUrl: r.deepseek_base_url, model: r.deepseek_model },
      openai: { baseUrl: r.openai_base_url, model: r.openai_model, fallbackEnabled: r.openai_fallback_enabled === 1 },
      n8n: { webhookUrl: r.n8n_webhook_url },
      defaultSearchMode: r.default_search_mode,
      captionConcurrency: r.caption_concurrency,
      enrichmentConcurrency: r.enrichment_concurrency,
    };
  }

  update(values: Partial<Record<SettingsColumn, string | number | null>>, at: string): void {
    const columns = Object.keys(values) as SettingsColumn[];
    if (columns.length === 0) return;
    this.db
      .prepare(`UPDATE model_config SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = 1`)
      .run(...columns.map((c) => values[c] ?? null), at);
  }
}
