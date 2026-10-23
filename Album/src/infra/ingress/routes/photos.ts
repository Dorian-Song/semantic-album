import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FileVariant } from '../../../application/query/query.js';
import type { IngressTargets } from '../http.js';
import { idParams, pageQuery, type PageQuery } from '../schemas.js';

type IdParams = { Params: { id: string } };
const albumQuery = { type: 'object', properties: { album: { type: 'string' } } } as const;

export function registerPhotoRoutes(app: FastifyInstance, { library, query, processing }: IngressTargets): void {
  // Photo IDs map to fixed bytes, so image responses can be cached indefinitely.
  async function sendFile(reply: FastifyReply, id: string, variant: FileVariant) {
    const f = await query.openFile(id, variant);
    reply.header('Content-Type', f.mime).header('Content-Length', f.size).header('Cache-Control', 'private, max-age=31536000, immutable');
    if (f.filename) reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    return reply.send(f.stream);
  }

  app.get<{ Querystring: PageQuery & { order: 'date' | 'recent'; kind?: string } }>(
    '/api/photos',
    {
      schema: {
        querystring: {
          ...pageQuery,
          properties: {
            ...pageQuery.properties,
            order: { type: 'string', enum: ['date', 'recent'], default: 'date' },
            kind: { type: 'string', enum: ['photo', 'screenshot', 'document', 'illustration', 'other'] },
          },
        },
      },
    },
    async (req) => query.allPhotos(req.query.offset, req.query.limit, req.query.order, req.query.kind),
  );

  app.get<IdParams & { Querystring: { album?: string } }>('/api/photos/:id', { schema: { params: idParams, querystring: albumQuery } }, async (req) => ({
    ...query.detail(req.params.id, req.query.album),
    processing: processing.statusOf(req.params.id),
  }));

  /** Queue a fresh AI description. A user's description, if any, stays the one shown and searched. */
  app.post<IdParams>('/api/photos/:id/caption', { schema: { params: idParams } }, async (req, reply) =>
    reply.code(202).send({ revision: processing.regenerateDescription(req.params.id) }),
  );

  app.get<IdParams & { Querystring: { album?: string } }>('/api/photos/:id/context', { schema: { params: idParams, querystring: albumQuery } }, async (req) =>
    query.context(req.params.id, req.query.album ?? null),
  );

  app.get<IdParams>('/api/photos/:id/original', { schema: { params: idParams } }, async (req, reply) => sendFile(reply, req.params.id, 'original'));
  app.get<IdParams>('/api/photos/:id/display', { schema: { params: idParams } }, async (req, reply) => sendFile(reply, req.params.id, 'display'));
  app.get<IdParams>('/api/photos/:id/thumbnail', { schema: { params: idParams } }, async (req, reply) => sendFile(reply, req.params.id, 'thumbnail'));

  app.patch<IdParams & { Body: { manualCaption: string | null } }>(
    '/api/photos/:id/description',
    { schema: { params: idParams, body: { type: 'object', required: ['manualCaption'], properties: { manualCaption: { type: ['string', 'null'] } } } } },
    async (req) => {
      library.setDescription(req.params.id, req.body.manualCaption);
      return query.detail(req.params.id);
    },
  );

  app.post<IdParams & { Body: { albumId: string } }>(
    '/api/photos/:id/albums',
    { schema: { params: idParams, body: { type: 'object', required: ['albumId'], properties: { albumId: { type: 'string' } } } } },
    async (req) => ({ added: library.addPhoto(req.body.albumId, req.params.id) }),
  );

  app.post<IdParams & { Body: { fromAlbumId: string; toAlbumId: string } }>(
    '/api/photos/:id/move',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['fromAlbumId', 'toAlbumId'], properties: { fromAlbumId: { type: 'string' }, toAlbumId: { type: 'string' } } },
      },
    },
    async (req) => ({ albums: library.movePhoto(req.params.id, req.body.fromAlbumId, req.body.toAlbumId) }),
  );

  app.delete<IdParams>('/api/photos/:id', { schema: { params: idParams } }, async (req, reply) => {
    library.deleteFromLibrary(req.params.id);
    return reply.code(204).send();
  });
}
