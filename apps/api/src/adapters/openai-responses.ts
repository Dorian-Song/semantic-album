import { assertCompleted, outputText, postResponses } from '../egress/responses-client.js';
import { CAPTION_JSON_SCHEMA, dataUrl, parseCaptionJson, SYSTEM_PROMPT, USER_PROMPT, type CaptionImage, type CaptionResult } from './vision-provider.js';

export interface OpenAIConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * OpenAI Responses API, used only as the fallback. Structured output uses a strict JSON schema.
 * No temperature or reasoning options are sent, because not every model accepts them.
 */
export async function captionWithOpenAI(cfg: OpenAIConfig, image: CaptionImage): Promise<CaptionResult> {
  const body = {
    model: cfg.model,
    instructions: SYSTEM_PROMPT,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: USER_PROMPT },
          { type: 'input_image', image_url: dataUrl(image), detail: 'auto' },
        ],
      },
    ],
    text: { format: { type: 'json_schema', name: 'photo_description', schema: CAPTION_JSON_SCHEMA, strict: true } },
    max_output_tokens: 2000,
  };
  const json = await postResponses('OpenAI', `${cfg.baseUrl}/responses`, cfg.apiKey, body);
  assertCompleted('OpenAI', json);
  const parsed = parseCaptionJson(outputText(json));
  return { ...parsed, provider: 'openai', model: typeof json.model === 'string' ? json.model : cfg.model };
}
