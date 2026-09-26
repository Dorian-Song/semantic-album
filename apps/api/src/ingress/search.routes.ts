import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.js';
import type { SearchRequest } from '../search/search-service.js';

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

export function registerSearchRoutes(app: FastifyInstance, { search }: Services): void {
  app.post<{ Body: SearchRequest }>(
    '/api/search',
    {
      schema: {
        body: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 500 },
            mode: { type: 'string', enum: ['words', 'meaning', 'both'] },
            albumIds: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 1000 },
            takenFrom: date,
            takenTo: date,
            camera: { type: 'string', maxLength: 200 },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 60 },
          },
        },
      },
    },
    async (req) => search.search(req.body),
  );

  app.get('/api/search/facets', async () => search.facets());
}
