import fs from 'node:fs/promises';
import { captionWithDeepSeek } from '../adapters/deepseek-responses.js';
import { captionWithOpenAI } from '../adapters/openai-responses.js';
import { InvalidCaptionError, PROMPT_REVISION, type CaptionImage, type CaptionResult } from '../adapters/vision-provider.js';
import type { AppContext } from '../context.js';
import { refreshPhotoText } from '../search/fts-index.js';
import type { SettingsService } from '../settings/settings-service.js';
import { nowIso } from '../shared/ids.js';
import { PermanentTaskError, ServiceUnavailableError, type ClaimedTask, type TaskHandler, type TaskService } from './task-service.js';

/** Formats both providers accept directly; anything else goes as the JPEG derivative. */
const PROVIDER_FORMATS: Record<string, CaptionImage['mime']> = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
/** Stay well below DeepSeek's 32 MiB per-image limit once base64-encoded. */
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

export class CaptionWorker implements TaskHandler {
  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly tasks: TaskService,
    private readonly maxAttempts: number,
  ) {}

  concurrency(): number {
    return this.settings.get().captionConcurrency;
  }

  async run(task: ClaimedTask): Promise<{ provider: string }> {
    const s = this.settings.get();
    if (!s.captionsEnabled) throw new ServiceUnavailableError('AI descriptions are turned off in Settings', 60_000);
    if (!s.deepseek.apiKey) throw new ServiceUnavailableError('Add a DeepSeek API key in Settings', 60_000);

    const image = await this.loadImage(task.assetId);
    let result: CaptionResult;
    try {
      result = await captionWithDeepSeek({ baseUrl: s.deepseek.baseUrl, model: s.deepseek.model, apiKey: s.deepseek.apiKey }, image);
    } catch (err) {
      if (err instanceof ServiceUnavailableError) throw err; // account-wide: pause, do not spend OpenAI money
      const permanent = err instanceof PermanentTaskError || err instanceof InvalidCaptionError;
      const lastAttempt = permanent || task.attempts >= this.maxAttempts;
      const fb = s.openai;
      if (!lastAttempt || !fb.fallbackEnabled || !fb.apiKey || !fb.model) {
        throw err instanceof InvalidCaptionError ? new PermanentTaskError(err.message) : err;
      }
      try {
        result = await captionWithOpenAI({ baseUrl: fb.baseUrl, model: fb.model, apiKey: fb.apiKey }, image);
      } catch (fallbackErr) {
        const why = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new PermanentTaskError(`${(err as Error).message}; OpenAI fallback also failed: ${why}`);
      }
    }
    this.save(task, result);
    return { provider: result.provider };
  }

  async loadImage(assetId: string): Promise<CaptionImage> {
    const row = this.ctx.db
      .prepare('SELECT format, byte_size AS size, object_key AS objectKey, derivative_key AS derivativeKey FROM assets WHERE id = ?')
      .get(assetId) as { format: string; size: number; objectKey: string; derivativeKey: string | null } | undefined;
    if (!row) throw new PermanentTaskError('The photo no longer exists');
    const mime = PROVIDER_FORMATS[row.format];
    if (mime && row.size <= MAX_ORIGINAL_BYTES) return { mime, data: await fs.readFile(this.ctx.store.abs(row.objectKey)) };
    if (!row.derivativeKey) throw new PermanentTaskError('No browser-compatible copy of this photo exists');
    return { mime: 'image/jpeg', data: await fs.readFile(this.ctx.store.abs(row.derivativeKey)) };
  }

  /** Stores the AI draft (never the manual text), reindexes, and queues n8n enrichment for this revision. */
  private save(task: ClaimedTask, r: CaptionResult): void {
    const { db } = this.ctx;
    db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM assets WHERE id = ?').get(task.assetId)) return;
      db.prepare(
        `INSERT INTO descriptions (asset_id, ai_caption, ai_tags, provider, model, prompt_revision, enrichment_state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (asset_id) DO UPDATE SET
           ai_caption = excluded.ai_caption, ai_tags = excluded.ai_tags, provider = excluded.provider, model = excluded.model,
           prompt_revision = excluded.prompt_revision, enrichment_state = 'pending', updated_at = excluded.updated_at`,
      ).run(task.assetId, r.caption, JSON.stringify(r.tags), r.provider, r.model, PROMPT_REVISION, nowIso());
      refreshPhotoText(db, task.assetId);
      this.tasks.enqueue(task.assetId, ['enrichment'], task.revision);
    })();
    this.tasks.kick();
  }
}
