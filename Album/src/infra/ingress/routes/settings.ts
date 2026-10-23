import type { FastifyInstance } from 'fastify';
import type { SettingsUpdate } from '../../settings/settings.js';
import type { IngressTargets } from '../http.js';

const secret = { type: ['string', 'null'], maxLength: 500 } as const;
const url = { type: 'string', minLength: 1, maxLength: 2000 } as const;

const updateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    captionsEnabled: { type: 'boolean' },
    deepseek: { type: 'object', additionalProperties: false, properties: { baseUrl: url, model: { type: 'string', maxLength: 200 }, apiKey: secret } },
    openai: {
      type: 'object',
      additionalProperties: false,
      properties: { baseUrl: url, model: { type: ['string', 'null'], maxLength: 200 }, apiKey: secret, fallbackEnabled: { type: 'boolean' } },
    },
    n8n: { type: 'object', additionalProperties: false, properties: { webhookUrl: { type: ['string', 'null'], maxLength: 2000 }, secret } },
    defaultSearchMode: { type: 'string', enum: ['words', 'meaning', 'both'] },
    captionConcurrency: { type: 'integer', minimum: 1, maximum: 1000 },
    enrichmentConcurrency: { type: 'integer', minimum: 1, maximum: 64 },
  },
} as const;

export function registerSettingsRoutes(app: FastifyInstance, { settings, processing, lifecycle, observability }: IngressTargets): void {
  app.get('/api/settings', async () => ({ ...settings.getPublic(), imageDecoders: observability.decoders() }));

  app.put<{ Body: SettingsUpdate }>('/api/settings', { schema: { body: updateSchema } }, async (req) => {
    const updated = settings.update(req.body);
    processing.settingsChanged();
    return updated;
  });

  /** Round trip through the n8n workflow with a test caption: Data Table write, read back, then delete. */
  app.post('/api/settings/test-n8n', async () => {
    const result = await observability.testN8n();
    void lifecycle.deleteCloudRecords(); // a working connection can clear deletions that were waiting
    return result;
  });

  /** Describes a generated test picture with one provider's saved settings. Sends only that picture. */
  app.post<{ Body: { provider: 'deepseek' | 'openai' } }>(
    '/api/settings/test-caption',
    { schema: { body: { type: 'object', required: ['provider'], properties: { provider: { type: 'string', enum: ['deepseek', 'openai'] } } } } },
    async (req) => observability.testCaption(req.body.provider),
  );
}
