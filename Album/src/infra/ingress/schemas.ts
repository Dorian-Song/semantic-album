/** Shared JSON-schema fragments for route validation. */

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

export const pageQuery = {
  type: 'object',
  properties: {
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 60 },
  },
} as const;

export interface PageQuery {
  offset: number;
  limit: number;
}
