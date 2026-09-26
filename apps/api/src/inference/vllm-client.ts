import { PermanentTaskError, ServiceUnavailableError } from '../processing/task-service.js';
import type { Embedder } from './embedder.js';

/**
 * Qwen3-VL-Embedding served by the local vLLM process (`vllm serve --runner pooling`), through its
 * OpenAI-style /v1/embeddings endpoint with chat messages.
 *
 * Follows the model card exactly: the same system instruction for photos and queries, and the chat template
 * with the generation prompt appended. Measured on 300 COCO val2017 images, this gives caption→image
 * Recall@1 72% / @5 94%; dropping the generation prompt (vLLM's default) gives 45% / 79%, and a custom query
 * instruction 24–59% / 42–86%. See docs/backend-design.md, "Search contract".
 */
export const INSTRUCTION = "Represent the user's input.";

export interface VllmConfig {
  enabled: boolean;
  baseUrl: string;
  servedModel: string;
  modelId: string;
  revision: string;
  dimension: number;
}

export class VllmEmbedder implements Embedder {
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;

  constructor(private readonly cfg: VllmConfig) {
    this.modelId = cfg.modelId;
    this.revision = cfg.revision;
    this.dimension = cfg.dimension;
  }

  embedQuery(text: string): Promise<Float32Array> {
    return this.embed([{ type: 'text', text }], 15_000);
  }

  embedImage(jpeg: Buffer): Promise<Float32Array> {
    return this.embed([{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }], 120_000);
  }

  private async embed(content: unknown[], timeoutMs: number): Promise<Float32Array> {
    if (!this.cfg.enabled) throw new ServiceUnavailableError('The local embedding model is turned off (VLLM_ENABLED=false)', 5 * 60_000);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.servedModel,
          messages: [
            { role: 'system', content: [{ type: 'text', text: INSTRUCTION }] },
            { role: 'user', content },
          ],
          add_generation_prompt: true,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why = (err as Error).name === 'TimeoutError' ? 'did not answer in time' : 'is not running';
      throw new ServiceUnavailableError(`The local embedding model ${why}`, 30_000);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (JSON.parse(text) as { error?: { message?: string }; message?: string }).error?.message ?? msg;
      } catch {
        // keep status
      }
      if (res.status === 400 || res.status === 422) throw new PermanentTaskError(`Embedding model rejected the input: ${msg.slice(0, 300)}`);
      if (res.status === 404) throw new ServiceUnavailableError(`Embedding model "${this.cfg.servedModel}" is not served`, 5 * 60_000);
      throw new Error(`Embedding model error: ${msg.slice(0, 300)}`);
    }
    const embedding = (JSON.parse(text) as { data?: { embedding?: number[] }[] }).data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== this.dimension) {
      throw new ServiceUnavailableError(`The embedding model returned ${embedding?.length ?? 'no'} dimensions instead of ${this.dimension}`, 60 * 60_000);
    }
    return Float32Array.from(embedding);
  }
}
