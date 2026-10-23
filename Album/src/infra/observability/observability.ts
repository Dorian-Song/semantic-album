import { answers } from '../../data-access/egress/http.js';
import { enrich, purge } from '../../data-access/egress/n8n.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import { badRequest } from '../../shared/errors.js';
import type { Imaging } from '../imaging/imaging.js';
import { InvalidOutputError, type Llm, type ProviderName } from '../llm/llm.js';
import type { Env } from '../settings/env.js';
import type { SettingsService } from '../settings/settings.js';

export type ServiceState = 'ok' | 'unreachable' | 'disabled' | 'not_configured';

export interface Health {
  status: 'ok' | 'degraded';
  services: { database: ServiceState; n8n: ServiceState; embedding: ServiceState };
}

const TEST_ASSET = 'album-connection-test';

/** A small picture with an unambiguous subject, so a provider test proves both the key and image input. */
const TEST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384">
  <rect width="512" height="384" fill="#8ecdf5"/><circle cx="420" cy="80" r="42" fill="#ffd23f"/>
  <rect y="280" width="512" height="104" fill="#5fae4b"/>
  <rect x="150" y="180" width="170" height="110" fill="#d9483b"/><polygon points="135,185 235,110 335,185" fill="#7a3b2e"/>
  <rect x="215" y="230" width="40" height="60" fill="#5b3a29"/></svg>`;

/** Health of the services Album depends on, and connection tests with newly saved settings. Owns no business state. */
export class Observability {
  constructor(
    private readonly env: Env,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly llm: Llm,
    private readonly imaging: Imaging,
  ) {}

  /** Only the database is required; n8n and embedding may be down without breaking browsing or Words search. */
  async health(): Promise<Health> {
    const database: ServiceState = this.repos.ping() ? 'ok' : 'unreachable';
    const probe = async (url: string): Promise<ServiceState> => ((await answers(url)) ? 'ok' : 'unreachable');
    const [n8n, embedding] = await Promise.all([
      this.env.n8nBaseUrl ? probe(`${this.env.n8nBaseUrl}/healthz`) : Promise.resolve<ServiceState>('not_configured'),
      this.env.vllmEnabled ? probe(`${this.env.vllmBaseUrl}/health`) : Promise.resolve<ServiceState>('disabled'),
    ]);
    return { status: database === 'ok' ? 'ok' : 'degraded', services: { database, n8n, embedding } };
  }

  decoders(): { heifDec: boolean; ffmpeg: boolean; magick: boolean } {
    const t = this.imaging.tools;
    return { heifDec: !!t.heifDec, ffmpeg: !!t.ffmpeg, magick: !!t.magick };
  }

  /** Round trip through the n8n workflow with a test caption: Data Table write, read back, then delete. */
  async testN8n(): Promise<{ ok: true; rowId: number; caption: string; categories: string[]; cleanedUp: number } | { ok: false; message: string }> {
    const { webhookUrl, secret } = this.settings.get().n8n;
    if (!webhookUrl || !secret) throw badRequest('missing_n8n', 'Save the n8n webhook URL and secret first');
    const target = { webhookUrl, secret };
    try {
      const r = await enrich(target, {
        assetId: TEST_ASSET,
        taskId: 'connection-test',
        revision: 1,
        caption: 'a brown dog sleeping on a sofa in a living room',
        tags: ['Dog', 'sofa', 'living room'],
      });
      const cleanup = await purge(target, TEST_ASSET);
      return { ok: true, rowId: r.rowId, caption: r.caption, categories: r.categories, cleanedUp: cleanup.deleted };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Describes a generated test picture with one provider's saved settings. Sends only that picture. */
  async testCaption(provider: ProviderName): Promise<{ ok: true; model: string; caption: string; tags: string[] } | { ok: false; message: string }> {
    const s = this.settings.get();
    if (provider === 'deepseek' && !s.deepseek.apiKey) throw badRequest('missing_key', 'Save a DeepSeek API key first');
    if (provider === 'openai' && (!s.openai.apiKey || !s.openai.model)) throw badRequest('missing_key', 'Save an OpenAI API key and model first');
    const image = { mime: 'image/png' as const, data: await this.imaging.svgToPng(TEST_SVG) };
    try {
      const r = await this.llm.generateWith(provider, {
        instructions: 'You describe images.',
        prompt: 'Describe this image. Reply with a JSON object with keys "caption" (one sentence) and "tags" (up to 8 lowercase keywords).',
        images: [image],
        schema: {
          name: 'connection_test',
          schema: { type: 'object', additionalProperties: false, required: ['caption', 'tags'], properties: { caption: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
        },
        parse: (text) => {
          try {
            const v = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { caption?: unknown; tags?: unknown };
            if (typeof v.caption !== 'string') throw new Error();
            return { caption: v.caption, tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : [] };
          } catch {
            throw new InvalidOutputError('The model did not return JSON');
          }
        },
      });
      return { ok: true, model: r.model, caption: r.value.caption, tags: r.value.tags };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
