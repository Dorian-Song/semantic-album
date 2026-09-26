import { api } from './client';

export interface SecretState {
  saved: boolean;
  last4: string | null;
}

export type SearchMode = 'words' | 'meaning' | 'both';

export interface Settings {
  captionsEnabled: boolean;
  deepseek: { baseUrl: string; model: string; apiKey: SecretState };
  openai: { baseUrl: string; model: string | null; apiKey: SecretState; fallbackEnabled: boolean };
  n8n: { webhookUrl: string | null; secret: SecretState };
  defaultSearchMode: SearchMode;
  captionConcurrency: number;
  enrichmentConcurrency: number;
  imageDecoders: { heifDec: boolean; ffmpeg: boolean; magick: boolean };
}

/** Secrets: a string replaces, null removes, omitted keeps. */
export interface SettingsUpdate {
  captionsEnabled?: boolean;
  deepseek?: { baseUrl?: string; model?: string; apiKey?: string | null };
  openai?: { baseUrl?: string; model?: string | null; apiKey?: string | null; fallbackEnabled?: boolean };
  n8n?: { webhookUrl?: string | null; secret?: string | null };
  defaultSearchMode?: SearchMode;
  captionConcurrency?: number;
  enrichmentConcurrency?: number;
}

export type TestResult = { ok: true; model: string; caption: string; tags: string[] } | { ok: false; message: string };

export const getSettings = () => api<Settings>('/api/settings');
export const updateSettings = (u: SettingsUpdate) => api<Settings>('/api/settings', { method: 'PUT', body: u });
export const testCaption = (provider: 'deepseek' | 'openai') => api<TestResult>('/api/settings/test-caption', { method: 'POST', body: { provider } });
