import type { FastifyInstance } from 'fastify';
import type { ImageSearchScope, SearchRequest } from '../../../application/query/query.js';
import { AppError, badRequest } from '../../../shared/errors.js';
import type { IngressTargets } from '../http.js';

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

export function registerSearchRoutes(app: FastifyInstance, { query }: IngressTargets): void {
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
            kind: { type: 'string', enum: ['photo', 'screenshot', 'document', 'illustration', 'other'] },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 60 },
          },
        },
      },
    },
    async (req) => query.searchPhotos(req.body),
  );

  /**
   * Search by an uploaded or pasted image (multipart, one file). The scope travels in the query string, like the
   * text search's URL. The image is read into memory and never written to disk; multipart requests also skip
   * the idempotency store, so no copy of the answer is kept either.
   */
  app.post<{ Querystring: { albums?: string; from?: string; to?: string; camera?: string; kind?: string } }>(
    '/api/search/image',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            albums: { type: 'string', maxLength: 40_000 },
            from: date,
            to: date,
            camera: { type: 'string', maxLength: 200 },
            kind: { type: 'string', enum: ['photo', 'screenshot', 'document', 'illustration', 'other'] },
          },
        },
      },
    },
    async (req) => {
      const part = await req.file();
      if (!part) throw badRequest('missing_file', 'Attach the image as multipart form data');
      const bytes = await part.toBuffer();
      if (part.file.truncated) throw new AppError(413, 'too_large', 'The image is larger than the upload limit');
      const albums = (req.query.albums ?? '').split(',').filter(Boolean);
      const scope: ImageSearchScope = {
        albumIds: albums.length ? albums : null,
        takenFrom: req.query.from,
        takenTo: req.query.to,
        camera: req.query.camera,
        kind: req.query.kind,
      };
      return query.searchByImage(bytes, scope);
    },
  );

  app.get('/api/search/facets', async () => query.facets());
}
