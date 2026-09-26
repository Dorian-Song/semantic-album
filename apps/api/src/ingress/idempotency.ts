import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/connection.js';
import { nowIso } from '../shared/ids.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY = /^[\w-]{8,200}$/;

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { key: string; fingerprint: string };
  }
}

function fingerprint(req: FastifyRequest): string {
  return createHash('sha256')
    .update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`)
    .digest('hex');
}

/**
 * A repeated mutating request with the same `Idempotency-Key` gets the first response again instead of acting
 * twice; reusing a key for a different request is a 409. Database uniqueness stays the final guard. File
 * uploads are skipped: they are already idempotent per import item.
 */
export function registerIdempotency(app: FastifyInstance, db: Db): void {
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !MUTATING.has(req.method) || req.isMultipart()) return;
    if (!KEY.test(key)) return reply.code(400).send({ error: { code: 'invalid_idempotency_key', message: 'Idempotency-Key must be 8-200 letters, digits, - or _' } });
    const fp = fingerprint(req);
    const saved = db.prepare('SELECT fingerprint, response FROM idempotency_keys WHERE key = ?').get(key) as { fingerprint: string; response: string } | undefined;
    if (saved) {
      if (saved.fingerprint !== fp) {
        return reply.code(409).send({ error: { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' } });
      }
      const { status, body } = JSON.parse(saved.response) as { status: number; body: string };
      return reply.code(status).header('Idempotent-Replayed', 'true').type('application/json; charset=utf-8').send(body);
    }
    req.idempotency = { key, fingerprint: fp };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.idempotency || reply.statusCode >= 500 || reply.getHeader('Idempotent-Replayed')) return payload;
    if (payload !== undefined && typeof payload !== 'string') return payload; // streams are not stored
    db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, operation, fingerprint, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
      req.idempotency.key,
      `${req.method} ${req.routeOptions.url ?? req.url}`,
      req.idempotency.fingerprint,
      JSON.stringify({ status: reply.statusCode, body: payload ?? '' }),
      nowIso(),
    );
    return payload;
  });
}

/** Keys only need to outlive client retries. */
export function pruneIdempotencyKeys(db: Db, olderThanMs = 24 * 3600_000): number {
  return db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(new Date(Date.now() - olderThanMs).toISOString()).changes;
}
