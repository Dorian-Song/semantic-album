import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { Services } from '../app.js';
import { captionWithDeepSeek } from '../adapters/deepseek-responses.js';
import { captionWithOpenAI } from '../adapters/openai-responses.js';
import type { CaptionImage } from '../adapters/vision-provider.js';
import { postEnrichment, postPurge } from '../egress/n8n-client.js';
import type { SettingsUpdate } from '../settings/settings-service.js';
import { badRequest } from '../shared/errors.js';

const secret = { type: ['string', 'null'], maxLength: 500 } as const;
const url = { type: 'string', minLength: 1, maxLength: 2000 } as const;

const updateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    captionsEnabled: { type: 'boolean' },
    deepseek: {
      type: 'object',
      additionalProperties: false,
      properties: { baseUrl: url, model: { type: 'string', maxLength: 200 }, apiKey: secret },
    },
    openai: {
      type: 'object',
      additionalProperties: false,
      properties: { baseUrl: url, model: { type: ['string', 'null'], maxLength: 200 }, apiKey: secret, fallbackEnabled: { type: 'boolean' } },
    },
    n8n: {
      type: 'object',
      additionalProperties: false,
      properties: { webhookUrl: { type: ['string', 'null'], maxLength: 2000 }, secret },
    },
    defaultSearchMode: { type: 'string', enum: ['words', 'meaning', 'both'] },
    captionConcurrency: { type: 'integer', minimum: 1, maximum: 16 },
    enrichmentConcurrency: { type: 'integer', minimum: 1, maximum: 8 },
  },
} as const;

/** A small picture with an unambiguous subject, so a provider test proves both the key and image input. */
async function testImage(): Promise<CaptionImage> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384">
    <rect width="512" height="384" fill="#8ecdf5"/><circle cx="420" cy="80" r="42" fill="#ffd23f"/>
    <rect y="280" width="512" height="104" fill="#5fae4b"/>
    <rect x="150" y="180" width="170" height="110" fill="#d9483b"/><polygon points="135,185 235,110 335,185" fill="#7a3b2e"/>
    <rect x="215" y="230" width="40" height="60" fill="#5b3a29"/></svg>`;
  return { mime: 'image/png', data: await sharp(Buffer.from(svg)).png().toBuffer() };
}

export function registerSettingsRoutes(app: FastifyInstance, { settings, tasks, ctx, purge }: Services): void {
  app.get('/api/settings', async () => ({
    ...settings.getPublic(),
    imageDecoders: { heifDec: !!ctx.tools.heifDec, ffmpeg: !!ctx.tools.ffmpeg, magick: !!ctx.tools.magick },
  }));

  app.put<{ Body: SettingsUpdate }>('/api/settings', { schema: { body: updateSchema } }, async (req) => {
    const updated = settings.update(req.body);
    tasks.resume(); // a new key or re-enabled feature should not wait out an old pause
    return updated;
  });

  /** Round trip through the n8n workflow with a test caption: Data Table write, read back, then delete. */
  app.post('/api/settings/test-n8n', async () => {
    const { webhookUrl, secret } = settings.get().n8n;
    if (!webhookUrl || !secret) throw badRequest('missing_n8n', 'Save the n8n webhook URL and secret first');
    try {
      const r = await postEnrichment(webhookUrl, secret, {
        assetId: 'album-connection-test',
        taskId: 'connection-test',
        revision: 1,
        caption: 'a brown dog sleeping on a sofa in a living room',
        tags: ['Dog', 'sofa', 'living room'],
      });
      const cleanup = await postPurge(webhookUrl, secret, 'album-connection-test');
      void purge.runOnce();
      return { ok: true, rowId: r.rowId, caption: r.caption, categories: r.categories, cleanedUp: cleanup.deleted };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Captions a generated test picture with the saved settings of one provider. Sends only that picture. */
  app.post<{ Body: { provider: 'deepseek' | 'openai' } }>(
    '/api/settings/test-caption',
    { schema: { body: { type: 'object', required: ['provider'], properties: { provider: { type: 'string', enum: ['deepseek', 'openai'] } } } } },
    async (req) => {
      const s = settings.get();
      const image = await testImage();
      try {
        if (req.body.provider === 'deepseek') {
          if (!s.deepseek.apiKey) throw badRequest('missing_key', 'Save a DeepSeek API key first');
          const r = await captionWithDeepSeek({ baseUrl: s.deepseek.baseUrl, model: s.deepseek.model, apiKey: s.deepseek.apiKey }, image);
          return { ok: true, model: r.model, caption: r.caption, tags: r.tags };
        }
        if (!s.openai.apiKey || !s.openai.model) throw badRequest('missing_key', 'Save an OpenAI API key and model first');
        const r = await captionWithOpenAI({ baseUrl: s.openai.baseUrl, model: s.openai.model, apiKey: s.openai.apiKey }, image);
        return { ok: true, model: r.model, caption: r.caption, tags: r.tags };
      } catch (err) {
        if (err instanceof Error && 'status' in err && (err as { status: number }).status === 400) throw err;
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
