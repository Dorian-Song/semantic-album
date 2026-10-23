import { InvalidOutputError } from '../../infra/llm/llm.js';

export type ImageKind = 'photo' | 'screenshot' | 'document' | 'illustration' | 'other';
const KINDS: readonly ImageKind[] = ['photo', 'screenshot', 'document', 'illustration', 'other'];

export interface DescriptionFields {
  caption: string;
  tags: string[];
  /** Distinct visible things, singular nouns. */
  objects: string[];
  /** Legible text transcribed from the image, or null. */
  text: string | null;
  kind: ImageKind | null;
}

/**
 * Bump when the prompt or schema changes, so drafts can be told apart and refreshed.
 * 2: structured objects, transcribed text, and image kind next to caption and tags.
 */
export const PROMPT_REVISION = 2;

export const SYSTEM_PROMPT =
  'You describe images for a personal photo library so they can be found later by text search. ' +
  'Be factual and specific. Describe only what is visible; do not guess names, identities, or exact places. ' +
  'When unsure whether something is there, leave it out.';

/**
 * One schema for every kind of image. Fields that do not apply stay empty rather than being filled in, which
 * keeps screenshots from being described like landscapes and photos from being treated like documents.
 */
export const USER_PROMPT = [
  'Describe this image. Reply with a JSON object with exactly these keys:',
  '"caption": one or two plain English sentences (at most 60 words): the main subject, what is happening, the setting,',
  'notable objects and colours, time of day or weather if visible, and what any prominent text is about.',
  '"objects": the distinct things clearly visible, including small ones such as utensils, bags, or signs, as short',
  'singular English nouns, most prominent first, at most 25.',
  '"tags": 5 to 12 short lowercase keywords for search: scene type, activity, event, season, style or mood, and a common',
  'synonym for the main subject when one exists (for example both "sofa" and "couch"). No duplicates of objects.',
  '"kind": one of "photo", "screenshot", "document", "illustration", "other".',
  '"text": the legible text in the image, transcribed exactly in reading order with line breaks, at most about 300 words;',
  'write text that repeats (logos, banners, patterns) only once; for ordinary photos only prominent text such as signs',
  'and labels; an empty string when there is none.',
].join(' ');

/** Used when an answer ran past the output limit (for example walls of repeated logos), and for the fallback provider. */
export const SHORT_PROMPT = `${USER_PROMPT} Keep the answer short: at most 15 objects, and at most 50 words of "text".`;

export const DESCRIPTION_SCHEMA = {
  name: 'photo_description',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['caption', 'objects', 'tags', 'kind', 'text'],
    properties: {
      caption: { type: 'string' },
      objects: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      kind: { type: 'string', enum: [...KINDS] },
      text: { type: 'string' },
    },
  },
};

function keywords(value: unknown, max: number): string[] {
  const raw = Array.isArray(value) ? value : [];
  return [
    ...new Set(
      raw
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0 && t.length <= 40),
    ),
  ].slice(0, max);
}

/** Validates and normalises model output (JSON, possibly wrapped in a code fence). Missing optional fields are empty. */
export function parseDescription(text: string): DescriptionFields {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidOutputError('The model did not return JSON');
  }
  const v = value as { caption?: unknown; tags?: unknown; objects?: unknown; kind?: unknown; text?: unknown };
  if (typeof v.caption !== 'string' || !v.caption.trim()) throw new InvalidOutputError('The model returned no caption');
  const caption = v.caption.replace(/\s+/g, ' ').trim().slice(0, 1000);
  const objects = keywords(v.objects, 25);
  const tags = keywords(v.tags, 15).filter((t) => !objects.includes(t));
  const kind = typeof v.kind === 'string' && (KINDS as readonly string[]).includes(v.kind.toLowerCase()) ? (v.kind.toLowerCase() as ImageKind) : null;
  const transcript = typeof v.text === 'string' ? v.text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, 4000) : '';
  return { caption, tags, objects, kind, text: transcript || null };
}
