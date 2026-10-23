import { RejectedError, ServiceUnavailableError } from '../../data-access/egress/errors.js';
import { errorMessage, NoAnswerError, sendJson } from '../../data-access/egress/http.js';
import type { Embedder } from './embedding.js';

/**
 * Follows the Qwen3-VL-Embedding model card: the same system instruction for photos and queries, and the chat
 * template with the generation prompt appended. Measured on 300 COCO val2017 images: caption→image Recall@1
 * 72% with this format, 45% with vLLM's default template setting.
 */
const INSTRUCTION = "Represent the user's input.";

export interface VllmConfig {
  enabled: boolean;
  baseUrl: string;
  servedModel: string;
  modelId: string;
  revision: string;
  dimension: number;
}

/** Qwen3-VL-Embedding served by the local vLLM process, through its /v1/embeddings endpoint with chat messages. */
export class VllmEmbedder implements Embedder {
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;

  constructor(private readonly cfg: VllmConfig) {
    this.modelId = cfg.modelId;
    this.revision = cfg.revision;
    this.dimension = cfg.dimension;
  }

  embedText(text: string): Promise<Float32Array> {
    return this.embed([{ type: 'text', text }], 15_000);
  }

  embedImage(jpeg: Buffer): Promise<Float32Array> {
    return this.embed([{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }], 120_000);
  }

  private async embed(content: unknown[], timeoutMs: number): Promise<Float32Array> {
    if (!this.cfg.enabled) throw new ServiceUnavailableError('The local embedding model is turned off (VLLM_ENABLED=false)', 5 * 60_000);
    let reply;
    try {
      reply = await sendJson(`${this.cfg.baseUrl}/v1/embeddings`, {
        timeoutMs,
        body: {
          model: this.cfg.servedModel,
          messages: [
            { role: 'system', content: [{ type: 'text', text: INSTRUCTION }] },
            { role: 'user', content },
          ],
          add_generation_prompt: true,
          encoding_format: 'float',
        },
      });
    } catch (err) {
      if (err instanceof NoAnswerError) throw new ServiceUnavailableError(`The local embedding model ${err.timedOut ? 'did not answer in time' : 'is not running'}`, 30_000);
      throw err;
    }
    if (!reply.ok) {
      const msg = errorMessage(reply.json) ?? `HTTP ${reply.status}`;
      if (reply.status === 400 || reply.status === 422) throw new RejectedError(`Embedding model rejected the input: ${msg}`);
      if (reply.status === 404) throw new ServiceUnavailableError(`Embedding model "${this.cfg.servedModel}" is not served`, 5 * 60_000);
      throw new Error(`Embedding model error: ${msg}`);
    }
    const embedding = (reply.json as { data?: { embedding?: number[] }[] } | null)?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== this.dimension) {
      throw new ServiceUnavailableError(`The embedding model returned ${embedding?.length ?? 'no'} dimensions instead of ${this.dimension}`, 60 * 60_000);
    }
    return Float32Array.from(embedding);
  }
}
