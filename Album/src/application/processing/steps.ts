import { RejectedError, ServiceUnavailableError } from '../../data-access/egress/errors.js';
import { enrich } from '../../data-access/egress/n8n.js';
import type { FileStore } from '../../data-access/file-store/file-store.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import type { ClaimedTask } from '../../data-access/repositories/tasks.js';
import type { SearchStore } from '../../data-access/search-store/search-store.js';
import type { Embedder } from '../../infra/embedding/embedding.js';
import type { Imaging } from '../../infra/imaging/imaging.js';
import type { Llm, LlmImage } from '../../infra/llm/llm.js';
import type { SettingsService } from '../../infra/settings/settings.js';
import { nowIso } from '../../shared/ids.js';
import { DESCRIPTION_SCHEMA, parseDescription, PROMPT_REVISION, SHORT_PROMPT, SYSTEM_PROMPT, USER_PROMPT } from './prompt.js';
import { DeferredError, type StepHandler, type TaskQueue } from './queue.js';

export interface StepDeps {
  repos: Repositories;
  files: FileStore;
  search: SearchStore;
  settings: SettingsService;
  llm: Llm;
  embedder: Embedder;
  imaging: Imaging;
  queue: TaskQueue;
  embeddingConcurrency: number;
}

/** Formats both providers accept directly; anything else goes as the JPEG display copy. */
const PROVIDER_FORMATS: Record<string, LlmImage['mime']> = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
/**
 * Larger originals go as the 2560 px JPEG display copy. This keeps well under DeepSeek's 32 MiB image limit and
 * bounds memory: with hundreds of requests in flight, each holds its image and its base64 copy.
 */
const MAX_ORIGINAL_BYTES = 5 * 1024 * 1024;
/** The embedding model resizes images to about 1.3 megapixels anyway. */
const EMBED_LONG_EDGE = 1280;

/** Describes the photo with the AI model and stores the draft (never the user's text). */
export class DescribeStep implements StepHandler {
  constructor(private readonly d: StepDeps) {}

  concurrency(): number {
    return this.d.settings.get().captionConcurrency;
  }

  async run(task: ClaimedTask): Promise<{ provider: string }> {
    const { repos, settings, llm, search, queue } = this.d;
    if (!settings.get().captionsEnabled) throw new ServiceUnavailableError('AI descriptions are turned off in Settings', 60_000);
    // Checked right before the photo leaves the machine: a photo removed from the library is never sent.
    if (!repos.assets.isInUse(task.assetId)) throw new DeferredError('The photo is no longer in the library');

    const image = await this.loadImage(task.assetId);
    const r = await llm.generate(
      { instructions: SYSTEM_PROMPT, prompt: USER_PROMPT, shortPrompt: SHORT_PROMPT, images: [image], schema: DESCRIPTION_SCHEMA, parse: parseDescription },
      { lastTry: task.attempts >= queue.opts.maxAttempts },
    );
    repos.tx(() => {
      if (!repos.assets.exists(task.assetId)) return;
      repos.descriptions.saveAi(task.assetId, { ...r.value, provider: r.provider, model: r.model, promptRevision: PROMPT_REVISION }, nowIso());
      search.refreshText(task.assetId);
      queue.add(task.assetId, ['enrichment'], task.revision);
    });
    queue.nextRevision(task.assetId, 'text_embedding');
    return { provider: r.provider };
  }

  private async loadImage(assetId: string): Promise<LlmImage> {
    const f = this.d.repos.assets.files(assetId);
    if (!f) throw new RejectedError('The photo no longer exists');
    const mime = PROVIDER_FORMATS[f.format];
    if (mime && f.byteSize <= MAX_ORIGINAL_BYTES) return { mime, data: await this.d.files.read(f.objectKey) };
    if (!f.derivativeKey) throw new RejectedError('No browser-compatible copy of this photo exists');
    return { mime: 'image/jpeg', data: await this.d.files.read(f.derivativeKey) };
  }
}

/**
 * Sends a finished AI caption through the n8n workflow, which normalises it, writes a Data Table row, reads it
 * back, and returns it. The result updates the AI draft only; a user's description is never touched.
 */
export class NormalizeStep implements StepHandler {
  constructor(private readonly d: StepDeps) {}

  concurrency(): number {
    return this.d.settings.get().enrichmentConcurrency;
  }

  async run(task: ClaimedTask): Promise<{ provider: string } | void> {
    const { repos, settings, search, queue } = this.d;
    const { webhookUrl, secret } = settings.get().n8n;
    if (!webhookUrl || !secret) throw new ServiceUnavailableError('Connect n8n in Settings', 60_000);
    const superseded = () => {
      const latest = repos.tasks.latestSucceededRevision(task.assetId, 'caption');
      return latest !== null && task.revision < latest;
    };
    if (superseded()) return;
    const d = repos.descriptions.aiCaption(task.assetId);
    if (!d?.caption) return;

    const r = await enrich({ webhookUrl, secret }, { assetId: task.assetId, taskId: task.id, revision: task.revision, caption: d.caption, tags: d.tags });
    repos.tx(() => {
      if (superseded()) return;
      repos.descriptions.applyEnrichment(task.assetId, r, nowIso());
      search.refreshText(task.assetId);
    });
    queue.nextRevision(task.assetId, 'text_embedding');
    return { provider: 'n8n' };
  }
}

/** Computes the image vector from the display copy. */
export class ImageEmbeddingStep implements StepHandler {
  constructor(private readonly d: StepDeps) {}

  concurrency(): number {
    return this.d.embeddingConcurrency;
  }

  async run(task: ClaimedTask): Promise<{ provider: string }> {
    const { repos, files, search, embedder, imaging } = this.d;
    search.assertModel(embedder);
    const f = repos.assets.files(task.assetId);
    if (!f) throw new RejectedError('The photo no longer exists');
    if (!f.derivativeKey) throw new RejectedError('No decodable copy of this photo exists');
    const jpeg = await imaging.resizeJpeg(await files.read(f.derivativeKey), EMBED_LONG_EDGE, 90);
    const vector = await embedder.embedImage(jpeg);
    repos.tx(() => {
      if (repos.assets.exists(task.assetId)) search.putImageVector(task.assetId, vector, embedder);
    });
    return { provider: embedder.modelId };
  }
}

/** Text of a photo's description as embedded: what it shows, its keywords, and the start of any text in it. */
function descriptionDocument(d: { manual: string | null; ai: string | null; tags: string; text: string | null }): string | null {
  const caption = d.manual ?? d.ai;
  if (!caption) return null;
  const parts = [caption.trim()];
  const tags = JSON.parse(d.tags) as string[];
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}.`);
  if (d.text?.trim()) parts.push(`Text: ${d.text.trim().slice(0, 400)}`);
  return parts.join(' ');
}

/**
 * Embeds the description text into the same space as the image. Meaning search blends the two: on 5,000 COCO
 * photos an even blend lifted caption-query Recall@1 from 26% (image only) to 34%.
 */
export class DescriptionEmbeddingStep implements StepHandler {
  constructor(private readonly d: StepDeps) {}

  concurrency(): number {
    return this.d.embeddingConcurrency;
  }

  async run(task: ClaimedTask): Promise<{ provider: string } | void> {
    const { repos, search, embedder } = this.d;
    if (repos.tasks.newerExists(task.assetId, 'text_embedding', task.revision)) return; // a later change will be embedded instead
    const source = repos.descriptions.source(task.assetId);
    const doc = source ? descriptionDocument(source) : null;
    if (!doc) {
      search.deleteDescriptionVector(task.assetId);
      return;
    }
    const vector = await embedder.embedText(doc);
    repos.tx(() => {
      if (repos.assets.exists(task.assetId)) search.putDescriptionVector(task.assetId, vector);
    });
    return { provider: embedder.modelId };
  }
}
