import type { FastifyInstance } from 'fastify';
import type { ExportScope } from '../../../application/export/export.js';
import { badRequest } from '../../../shared/errors.js';
import type { IngressTargets } from '../http.js';
import { idParams } from '../schemas.js';

const ids = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, minItems: 1, maxItems: 50_000 } as const;

export function registerExportRoutes(app: FastifyInstance, { export: exports }: IngressTargets): void {
  app.post<{ Body: { albumIds?: string[]; assetIds?: string[] } }>(
    '/api/exports',
    { bodyLimit: 4 * 1024 * 1024, schema: { body: { type: 'object', additionalProperties: false, properties: { albumIds: ids, assetIds: ids } } } },
    async (req, reply) => {
      const { albumIds, assetIds } = req.body;
      if (!albumIds === !assetIds) throw badRequest('invalid_scope', 'Export either albums or photos');
      const scope: ExportScope = albumIds ? { albumIds } : { assetIds: assetIds! };
      return reply.code(201).send(exports.create(scope));
    },
  );

  app.get<{ Params: { id: string } }>('/api/exports/:id', { schema: { params: idParams } }, async (req) => exports.progress(req.params.id));

  app.get<{ Params: { id: string } }>('/api/exports/:id/download', { schema: { params: idParams } }, async (req, reply) => {
    const f = await exports.download(req.params.id);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', f.size)
      .header('Content-Disposition', `attachment; filename="album-export.zip"; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
      .send(f.stream);
  });
}
