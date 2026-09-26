import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.js';
import { idParams, pageQuery, type PageQuery } from './schemas.js';

const nameBody = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

export function registerAlbumRoutes(app: FastifyInstance, { albums, photos }: Services): void {
  app.get('/api/albums', async () => ({ items: albums.list() }));

  app.get<{ Querystring: { name: string } }>(
    '/api/albums/name-suggestion',
    { schema: { querystring: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (req) => ({ name: albums.suggestName(req.query.name) }),
  );

  app.post<{ Body: { name: string } }>('/api/albums', { schema: { body: nameBody } }, async (req, reply) =>
    reply.code(201).send(albums.create(req.body.name)),
  );

  app.get<{ Params: { id: string } }>('/api/albums/:id', { schema: { params: idParams } }, async (req) => albums.get(req.params.id));

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/api/albums/:id',
    { schema: { params: idParams, body: nameBody } },
    async (req) => albums.rename(req.params.id, req.body.name),
  );

  app.delete<{ Params: { id: string } }>('/api/albums/:id', { schema: { params: idParams } }, async (req) => albums.delete(req.params.id));

  app.get<{ Params: { id: string }; Querystring: PageQuery }>(
    '/api/albums/:id/photos',
    { schema: { params: idParams, querystring: pageQuery } },
    async (req) => photos.listAlbum(req.params.id, req.query.offset, req.query.limit),
  );

  app.delete<{ Params: { id: string; photoId: string } }>(
    '/api/albums/:id/photos/:photoId',
    {
      schema: {
        params: { type: 'object', required: ['id', 'photoId'], properties: { id: { type: 'string' }, photoId: { type: 'string' } } },
      },
    },
    async (req) => ({ removed: albums.removePhoto(req.params.id, req.params.photoId) }),
  );
}
