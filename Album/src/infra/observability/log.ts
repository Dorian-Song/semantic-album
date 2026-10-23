import type { FastifyBaseLogger } from 'fastify';

/** One log format for every module. Callers log metadata only: never photos, descriptions, or secrets. */
export type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
