import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Services } from '../app.js';
import { BROWSER_NATIVE, type ImageFormat } from '../assets/format-sniff.js';
import { notFound } from '../shared/errors.js';
import { idParams, pageQuery, type PageQuery } from './schemas.js';

type IdParams = { Params: { id: string } };

export function registerPhotoRoutes(app: FastifyInstance, { albums, assets, photos, store }: Services): void {
  // Asset IDs map to fixed bytes, so image responses can be cached indefinitely.
  async function sendFile(reply: FastifyReply, key: string | null, mime: string, filename?: string) {
    if (!key) throw notFound('Image');
    const abs = store.abs(key);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw notFound('Image');
    reply.header('Content-Type', mime).header('Content-Length', stat.size).header('Cache-Control', 'private, max-age=31536000, immutable');
    if (filename) reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return reply.send(createReadStream(abs));
  }

  app.get<{ Querystring: PageQuery & { order: 'date' | 'recent' } }>(
    '/api/photos',
    {
      schema: {
        querystring: {
          ...pageQuery,
          properties: { ...pageQuery.properties, order: { type: 'string', enum: ['date', 'recent'], default: 'date' } },
        },
      },
    },
    async (req) => photos.listAll(req.query.offset, req.query.limit, req.query.order),
  );

  app.get<IdParams & { Querystring: { album?: string } }>(
    '/api/photos/:id',
    { schema: { params: idParams, querystring: { type: 'object', properties: { album: { type: 'string' } } } } },
    async (req) => photos.detail(req.params.id, req.query.album),
  );

  app.get<IdParams & { Querystring: { album?: string } }>(
    '/api/photos/:id/context',
    { schema: { params: idParams, querystring: { type: 'object', properties: { album: { type: 'string' } } } } },
    async (req) => photos.context(req.params.id, req.query.album ? { kind: 'album', albumId: req.query.album } : { kind: 'all' }),
  );

  app.get<IdParams>('/api/photos/:id/original', { schema: { params: idParams } }, async (req, reply) => {
    const f = photos.files(req.params.id);
    return sendFile(reply, f.objectKey, f.mime, f.filename);
  });

  /** Something every browser can render: the original for web formats, otherwise the JPEG derivative. */
  app.get<IdParams>('/api/photos/:id/display', { schema: { params: idParams } }, async (req, reply) => {
    const f = photos.files(req.params.id);
    return BROWSER_NATIVE.has(f.format as ImageFormat) ? sendFile(reply, f.objectKey, f.mime) : sendFile(reply, f.derivativeKey, 'image/jpeg');
  });

  app.get<IdParams>('/api/photos/:id/thumbnail', { schema: { params: idParams } }, async (req, reply) => {
    const f = photos.files(req.params.id);
    return sendFile(reply, f.thumbnailKey, 'image/webp');
  });

  app.patch<IdParams & { Body: { manualCaption: string | null } }>(
    '/api/photos/:id/description',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['manualCaption'], properties: { manualCaption: { type: ['string', 'null'] } } },
      },
    },
    async (req) => {
      assets.setManualCaption(req.params.id, req.body.manualCaption);
      return photos.detail(req.params.id);
    },
  );

  app.post<IdParams & { Body: { albumId: string } }>(
    '/api/photos/:id/albums',
    { schema: { params: idParams, body: { type: 'object', required: ['albumId'], properties: { albumId: { type: 'string' } } } } },
    async (req) => ({ added: albums.addPhoto(req.body.albumId, req.params.id) }),
  );

  app.post<IdParams & { Body: { fromAlbumId: string; toAlbumId: string } }>(
    '/api/photos/:id/move',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['fromAlbumId', 'toAlbumId'],
          properties: { fromAlbumId: { type: 'string' }, toAlbumId: { type: 'string' } },
        },
      },
    },
    async (req) => {
      albums.movePhoto(req.params.id, req.body.fromAlbumId, req.body.toAlbumId);
      return { albums: photos.albumsOf(req.params.id) };
    },
  );

  app.delete<IdParams>('/api/photos/:id', { schema: { params: idParams } }, async (req, reply) => {
    albums.deleteFromLibrary(req.params.id);
    return reply.code(204).send();
  });
}
