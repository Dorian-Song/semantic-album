import type { Db } from '../../database/connection.js';
import { AlbumRepository } from './albums.js';
import { AssetRepository } from './assets.js';
import { CloudDeletionRepository } from './cloud-deletions.js';
import { DescriptionRepository } from './descriptions.js';
import { ExportRepository } from './exports.js';
import { IdempotencyRepository } from './idempotency.js';
import { ImportRepository } from './imports.js';
import { MirrorReadRepository } from './mirror-reads.js';
import { PhotoReadRepository } from './photo-reads.js';
import { SettingsRepository } from './settings.js';
import { TaskRepository } from './tasks.js';

/** The only code that knows tables, columns, and SQL. */
export class Repositories {
  readonly assets: AssetRepository;
  readonly albums: AlbumRepository;
  readonly descriptions: DescriptionRepository;
  readonly tasks: TaskRepository;
  readonly imports: ImportRepository;
  readonly exports: ExportRepository;
  readonly settings: SettingsRepository;
  readonly idempotency: IdempotencyRepository;
  readonly cloudDeletions: CloudDeletionRepository;
  readonly photoReads: PhotoReadRepository;
  readonly mirrorReads: MirrorReadRepository;

  constructor(private readonly db: Db) {
    this.assets = new AssetRepository(db);
    this.albums = new AlbumRepository(db);
    this.descriptions = new DescriptionRepository(db);
    this.tasks = new TaskRepository(db);
    this.imports = new ImportRepository(db);
    this.exports = new ExportRepository(db);
    this.settings = new SettingsRepository(db);
    this.idempotency = new IdempotencyRepository(db);
    this.cloudDeletions = new CloudDeletionRepository(db);
    this.photoReads = new PhotoReadRepository(db);
    this.mirrorReads = new MirrorReadRepository(db);
  }

  /** Runs several reads and writes as one all-or-nothing unit. Nested calls join the outer unit. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Whether the database answers. */
  ping(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
}
