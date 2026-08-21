/**
 * Config Version Repository
 *
 * Stores agent-reported (and, from M2b, editor-applied) config file
 * snapshots. Writes dedupe against the latest row by content hash and
 * prune older rows so at most CONFIG_VERSIONS_KEEP versions are kept per
 * backend.
 */
import type Database from 'better-sqlite3';

export interface ConfigVersion {
  id: number;
  backend_id: number;
  hash: string;
  content: string;
  size: number;
  source: string;
  file_path: string;
  file_mod_time_ms: number | null;
  created_at: string;
}

export const CONFIG_VERSIONS_KEEP = 20;

export class ConfigVersionRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert a new version unless its hash matches the current latest version
   * for the backend, in which case nothing is written (idempotent dedup).
   * On insert, prunes older rows beyond CONFIG_VERSIONS_KEEP for that backend.
   */
  insertIfChanged(v: {
    backendId: number;
    hash: string;
    content: string;
    size: number;
    source: string;
    filePath: string;
    fileModTimeMs?: number;
  }): { stored: boolean; id: number } {
    const insert = this.db.prepare(`
      INSERT INTO config_versions (backend_id, hash, content, size, source, file_path, file_mod_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const prune = this.db.prepare(`
      DELETE FROM config_versions
      WHERE backend_id = ? AND id NOT IN (
        SELECT id FROM config_versions WHERE backend_id = ? ORDER BY id DESC LIMIT ?
      )
    `);

    // Dedup read + insert + prune run inside one transaction so the decision
    // to skip a write is atomic with the write itself — otherwise a
    // concurrent caller could insert between our getLatest() read and the
    // insert below, and this write's dedup check would be stale.
    const run = this.db.transaction((): { stored: boolean; id: number } => {
      const latest = this.getLatest(v.backendId);
      if (latest && latest.hash === v.hash) {
        return { stored: false, id: latest.id };
      }

      const result = insert.run(
        v.backendId,
        v.hash,
        v.content,
        v.size,
        v.source,
        v.filePath,
        v.fileModTimeMs ?? null,
      );
      const id = Number(result.lastInsertRowid);
      prune.run(v.backendId, v.backendId, CONFIG_VERSIONS_KEEP);
      return { stored: true, id };
    });

    return run();
  }

  /**
   * C2 fix (M2b whole-branch final review, CRITICAL): deletes a
   * config_versions row IFF it is STILL the backend's latest row AND its
   * `source` is 'editor' — both conditions checked atomically in one
   * statement, no separate read-then-delete race.
   *
   * Why this exact guard: a non-applied receipt (conflict/rolled-back/
   * failed) means the disk was never actually updated to the editor
   * content this command's own config_versions row holds — left in place,
   * that row keeps masquerading as "the latest", so every subsequent
   * apply bases its staleness check off content that was never written,
   * producing a conflict loop that only self-heals when the agent's next
   * unrelated config-file report happens to land (up to ~1h). Deleting the
   * row reverts the staleness baseline to whatever IS actually on disk.
   *
   * The double guard exists because `insertIfChanged` can hand a command a
   * versionId that ISN'T a row created for it: a no-op apply (finalContent
   * hash equal to the current latest) reuses the EXISTING latest row's id
   * without writing a new one — that existing row could be a prior
   * 'agent-report' snapshot, or an unrelated earlier 'editor' apply that is
   * still meaningful on its own. `source = 'editor'` alone would still risk
   * deleting a reused prior editor row; `id = latest` alone would still
   * risk deleting a same-hash reused agent-report row. Both together only
   * ever remove a row that (a) is still the most recent thing this backend
   * has and (b) is unambiguously an editor-sourced row — which is exactly
   * the shape of "this specific non-applied command's own write, still
   * unsuperseded".
   */
  deleteIfLatestEditorVersion(backendId: number, id: number): boolean {
    const res = this.db.prepare(`
      DELETE FROM config_versions
      WHERE backend_id = ? AND id = ? AND source = 'editor'
        AND id = (SELECT id FROM config_versions WHERE backend_id = ? ORDER BY id DESC LIMIT 1)
    `).run(backendId, id, backendId);
    return res.changes > 0;
  }

  getLatest(backendId: number): ConfigVersion | undefined {
    return this.db.prepare(`
      SELECT id, backend_id, hash, content, size, source, file_path, file_mod_time_ms, created_at
      FROM config_versions
      WHERE backend_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(backendId) as ConfigVersion | undefined;
  }

  getById(backendId: number, id: number): ConfigVersion | undefined {
    return this.db.prepare(`
      SELECT id, backend_id, hash, content, size, source, file_path, file_mod_time_ms, created_at
      FROM config_versions
      WHERE backend_id = ? AND id = ?
    `).get(backendId, id) as ConfigVersion | undefined;
  }

  listMeta(backendId: number): Omit<ConfigVersion, 'content'>[] {
    return this.db.prepare(`
      SELECT id, backend_id, hash, size, source, file_path, file_mod_time_ms, created_at
      FROM config_versions
      WHERE backend_id = ?
      ORDER BY id DESC
    `).all(backendId) as Omit<ConfigVersion, 'content'>[];
  }
}
