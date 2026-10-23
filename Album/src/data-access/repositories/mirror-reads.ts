import type { Db } from '../../database/connection.js';

export interface MirrorAlbum {
  name: string;
  createdAt: string;
  photoCount: number;
}

export interface MirrorPhoto {
  sha256: string;
  fileName: string;
  caption: string | null;
  takenAt: string | null;
  camera: string | null;
  albums: string[];
  tags: string[];
}

/** The text-only view of the library that is copied to Baserow: albums, visible photos, their tags. */
export class MirrorReadRepository {
  constructor(private readonly db: Db) {}

  albums(): MirrorAlbum[] {
    return this.db
      .prepare(
        `SELECT al.name, al.created_at AS createdAt, (SELECT count(*) FROM album_assets WHERE album_id = al.id) AS photoCount
           FROM albums al ORDER BY al.created_at`,
      )
      .all() as MirrorAlbum[];
  }

  photos(): MirrorPhoto[] {
    const rows = this.db
      .prepare(
        `SELECT a.sha256, a.taken_at AS takenAt,
                nullif(trim(coalesce(a.camera_make, '') || ' ' || coalesce(a.camera_model, '')), '') AS camera,
                (SELECT display_filename FROM album_assets WHERE asset_id = a.id ORDER BY added_at LIMIT 1) AS fileName,
                coalesce(d.manual_caption, d.ai_caption) AS caption,
                coalesce(d.ai_tags, '[]') AS tags,
                (SELECT json_group_array(al.name) FROM album_assets aa JOIN albums al ON al.id = aa.album_id WHERE aa.asset_id = a.id) AS albums
           FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
          WHERE a.orphaned_at IS NULL AND EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id)`,
      )
      .all() as (Omit<MirrorPhoto, 'albums' | 'tags'> & { albums: string; tags: string })[];
    return rows.map((r) => ({ ...r, albums: JSON.parse(r.albums) as string[], tags: [...new Set(JSON.parse(r.tags) as string[])] }));
  }
}
