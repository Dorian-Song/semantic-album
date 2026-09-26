/**
 * Provider-neutral caption contract. Each provider adapter builds its own request and parses its own
 * response, but every one returns this shape, validated here.
 */

export type VisionProviderName = 'deepseek' | 'openai';

export interface CaptionImage {
  mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: Buffer;
}

export interface CaptionResult {
  caption: string;
  tags: string[];
  provider: VisionProviderName;
  model: string;
}

/** Bump when the prompt changes, so drafts can be told apart. */
export const PROMPT_REVISION = 1;

export const SYSTEM_PROMPT =
  'You describe photos for a personal photo library so they can be found later by text search. ' +
  'Be factual and specific. Describe only what is visible; do not guess names, identities, or exact places.';

export const USER_PROMPT = [
  'Describe this photo. Reply with a JSON object with exactly two keys:',
  '"caption": one or two plain English sentences (at most 60 words) covering the main subject, what is happening,',
  'the setting, notable objects and colours, time of day or weather if visible, and any clearly legible text.',
  '"tags": 5 to 12 short lowercase English keywords (single words or two-word phrases) useful for search,',
  'such as objects, scene type, activity, and season. No duplicates.',
].join(' ');

export const CAPTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['caption', 'tags'],
  properties: {
    caption: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** Thrown when a provider answers but the content is unusable. */
export class InvalidCaptionError extends Error {}

/** Validates and normalises model output (JSON, possibly wrapped in a code fence). */
export function parseCaptionJson(text: string): { caption: string; tags: string[] } {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidCaptionError('The model did not return JSON');
  }
  const v = value as { caption?: unknown; tags?: unknown };
  if (typeof v.caption !== 'string' || !v.caption.trim()) throw new InvalidCaptionError('The model returned no caption');
  const caption = v.caption.replace(/\s+/g, ' ').trim().slice(0, 1000);
  const rawTags = Array.isArray(v.tags) ? v.tags : [];
  const tags = [
    ...new Set(
      rawTags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0 && t.length <= 40),
    ),
  ].slice(0, 15);
  return { caption, tags };
}

export function dataUrl(image: CaptionImage): string {
  return `data:${image.mime};base64,${image.data.toString('base64')}`;
}
