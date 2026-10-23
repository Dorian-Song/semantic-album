import { outputText, postResponses } from './responses-api.js';

export type ProviderName = 'deepseek' | 'openai';

export interface LlmImage {
  mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: Buffer;
}

/** One provider-neutral call: instructions, a prompt with optional images, and a JSON answer. */
export interface ProviderCall {
  instructions: string;
  prompt: string;
  images: readonly LlmImage[];
  schema: { name: string; schema: object };
}

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const dataUrl = (image: LlmImage) => `data:${image.mime};base64,${image.data.toString('base64')}`;

/** Returns the answer text and the model that wrote it. */
export type Provider = (cfg: ProviderConfig, call: ProviderCall) => Promise<{ text: string; model: string }>;

/**
 * DeepSeek Responses API. Images go in as `input_image` data URLs; JSON mode is `json_object`; thinking is
 * disabled because these answers do not need it.
 */
export const deepseek: Provider = async (cfg, call) => {
  const json = await postResponses('DeepSeek', `${cfg.baseUrl}/responses`, cfg.apiKey, {
    model: cfg.model,
    instructions: call.instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: call.prompt }, ...call.images.map((i) => ({ type: 'input_image', image_url: dataUrl(i) }))] }],
    text: { format: { type: 'json_object' } },
    reasoning: { effort: 'none' },
    max_output_tokens: 1500,
    temperature: 0.2,
  });
  return { text: outputText(json), model: typeof json.model === 'string' ? json.model : cfg.model };
};

/**
 * OpenAI Responses API, used only as the fallback. Structured output uses a strict JSON schema. No temperature
 * or reasoning options are sent, because not every model accepts them.
 */
export const openai: Provider = async (cfg, call) => {
  const json = await postResponses('OpenAI', `${cfg.baseUrl}/responses`, cfg.apiKey, {
    model: cfg.model,
    instructions: call.instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: call.prompt }, ...call.images.map((i) => ({ type: 'input_image', image_url: dataUrl(i), detail: 'auto' }))] }],
    text: { format: { type: 'json_schema', name: call.schema.name, schema: call.schema.schema, strict: true } },
    max_output_tokens: 3000,
  });
  return { text: outputText(json), model: typeof json.model === 'string' ? json.model : cfg.model };
};
