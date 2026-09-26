import { assertCompleted, outputText, postResponses } from '../egress/responses-client.js';
import { COMPACT_NOTE, dataUrl, parseCaptionJson, SYSTEM_PROMPT, USER_PROMPT, type CaptionImage, type CaptionResult } from './vision-provider.js';

export interface DeepSeekConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * DeepSeek Responses API (https://api-docs.deepseek.com/api/create-response). Images go in as
 * `input_image` data URLs (JPEG/PNG/GIF/WebP); DeepSeek resizes them itself. JSON mode is `json_object`,
 * and thinking is disabled because a caption does not need it.
 */
export async function captionWithDeepSeek(cfg: DeepSeekConfig, image: CaptionImage, compact = false): Promise<CaptionResult> {
  const body = {
    model: cfg.model,
    instructions: SYSTEM_PROMPT,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: compact ? `${USER_PROMPT} ${COMPACT_NOTE}` : USER_PROMPT },
          { type: 'input_image', image_url: dataUrl(image) },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
    reasoning: { effort: 'none' },
    max_output_tokens: 1500,
    temperature: 0.2,
  };
  const json = await postResponses('DeepSeek', `${cfg.baseUrl}/responses`, cfg.apiKey, body);
  assertCompleted('DeepSeek', json);
  const parsed = parseCaptionJson(outputText(json));
  return { ...parsed, provider: 'deepseek', model: typeof json.model === 'string' ? json.model : cfg.model };
}
