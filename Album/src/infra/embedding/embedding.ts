import type { ModelIdentity } from '../../data-access/search-store/search-store.js';

/** Turns photos and text into vectors in one shared space. */
export interface Embedder extends ModelIdentity {
  /** Throws ServiceUnavailableError when the embedding service is disabled or unreachable. */
  embedText(text: string): Promise<Float32Array>;
  embedImage(jpeg: Buffer): Promise<Float32Array>;
}
