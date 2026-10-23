import type { FastifyInstance } from 'fastify';
import type { ManifestEntry } from '../../../application/import/import.js';
import { badRequest } from '../../../shared/errors.js';
import type { IngressTargets } from '../http.js';
import { idParams } from '../schemas.js';

type IdParams = { Params: { id: string } };

export function registerImportRoutes(app: FastifyInstance, { import: imports }: IngressTargets): void {
  app.post<{ Body: { path: string; albumId?: string } }>(
    '/api/imports/folder',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 }, albumId: { type: 'string' } } } } },
    async (req, reply) => reply.code(201).send(await imports.startFolderImport(req.body.path, req.body.albumId)),
  );

  app.post<{ Body: { albumId?: string; newAlbumName?: string; files: ManifestEntry[] } }>(
    '/api/imports',
    {
      bodyLimit: 16 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['files'],
          properties: {
            albumId: { type: 'string' },
            newAlbumName: { type: 'string', minLength: 1, maxLength: 200 },
            files: {
              type: 'array',
              items: {
                type: 'object',
                required: ['key', 'name', 'size'],
                properties: {
                  key: { type: 'string', minLength: 1, maxLength: 2048 },
                  name: { type: 'string', minLength: 1, maxLength: 1024 },
                  size: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => reply.code(201).send(imports.createFileImport(req.body)),
  );

  app.post<IdParams & { Querystring: { itemKey: string } }>(
    '/api/imports/:id/files',
    { schema: { params: idParams, querystring: { type: 'object', required: ['itemKey'], properties: { itemKey: { type: 'string', minLength: 1, maxLength: 2048 } } } } },
    async (req) => {
      const part = await req.file();
      if (!part) throw badRequest('missing_file', 'Attach the file as multipart form data');
      return imports.receiveFile(req.params.id, req.query.itemKey, part.file);
    },
  );

  app.post<IdParams>('/api/imports/:id/finish', { schema: { params: idParams } }, async (req) => imports.finish(req.params.id));
  app.post<IdParams>('/api/imports/:id/cancel', { schema: { params: idParams } }, async (req) => imports.cancel(req.params.id));

  app.get('/api/jobs', async () => ({ items: imports.recent() }));
  app.get<{ Querystring: { limit: number } }>(
    '/api/jobs/history',
    { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } } } } },
    async (req) => ({ items: imports.history(req.query.limit) }),
  );
  app.get<IdParams>('/api/jobs/:id', { schema: { params: idParams } }, async (req) => imports.progress(req.params.id));
}
