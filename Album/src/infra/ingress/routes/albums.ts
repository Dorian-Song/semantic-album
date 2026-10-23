import type { FastifyInstance } from 'fastify';
import type { IngressTargets } from '../http.js';
import { idParams, pageQuery, type PageQuery } from '../schemas.js';

const name = { type: 'string', minLength: 1, maxLength: 200 } as const;
const nameBody = { type: 'object', required: ['name'], properties: { name } } as const;

export function registerAlbumRoutes(app: FastifyInstance, { library, query, processing }: IngressTargets): void {
  app.get('/api/albums', async () => ({ items: library.list() }));

  app.get<{ Querystring: { name: string } }>(
    '/api/albums/name-suggestion',
    { schema: { querystring: { type: 'object', required: ['name'], properties: { name } } } },
    async (req) => ({ name: library.suggestName(req.query.name) }),
  );

  app.post<{ Body: { name: string } }>('/api/albums', { schema: { body: nameBody } }, async (req, reply) => reply.code(201).send(library.create(req.body.name)));

  app.get<{ Params: { id: string } }>('/api/albums/:id', { schema: { params: idParams } }, async (req) => library.get(req.params.id));
  app.get<{ Params: { id: string } }>('/api/albums/:id/processing', { schema: { params: idParams } }, async (req) => processing.albumProgress(req.params.id));

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/api/albums/:id',
    { schema: { params: idParams, body: nameBody } },
    async (req) => library.rename(req.params.id, req.body.name),
  );

  app.delete<{ Params: { id: string } }>('/api/albums/:id', { schema: { params: idParams } }, async (req) => library.delete(req.params.id));

  app.get<{ Params: { id: string }; Querystring: PageQuery }>(
    '/api/albums/:id/photos',
    { schema: { params: idParams, querystring: pageQuery } },
    async (req) => query.albumPhotos(req.params.id, req.query.offset, req.query.limit),
  );

  app.delete<{ Params: { id: string; photoId: string } }>(
    '/api/albums/:id/photos/:photoId',
    { schema: { params: { type: 'object', required: ['id', 'photoId'], properties: { id: { type: 'string' }, photoId: { type: 'string' } } } } },
    async (req) => ({ removed: library.removePhoto(req.params.id, req.params.photoId) }),
  );
}
