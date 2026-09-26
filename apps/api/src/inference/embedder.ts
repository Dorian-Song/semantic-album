/** Turns photos and search text into vectors in one shared space. */
export interface Embedder {
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;
  /** Throws ServiceUnavailableError when the embedding service is disabled or unreachable. */
  embedQuery(text: string): Promise<Float32Array>;
  embedImage(jpeg: Buffer): Promise<Float32Array>;
}
