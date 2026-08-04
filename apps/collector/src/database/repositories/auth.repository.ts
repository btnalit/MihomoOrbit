/**
 * Auth Repository
 *
 * Handles authentication configuration storage.
 */
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.repository.js';

export class AuthRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  getAuthConfig(): { enabled: boolean; tokenHash: string | null; updatedAt: string } {
    const enabledStmt = this.db.prepare(`SELECT value, updated_at FROM auth_config WHERE key = 'enabled'`);
    const tokenStmt = this.db.prepare(`SELECT value, updated_at FROM auth_config WHERE key = 'token_hash'`);

    const enabledRow = enabledStmt.get() as { value: string; updated_at: string } | undefined;
    const tokenRow = tokenStmt.get() as { value: string; updated_at: string } | undefined;

    return {
      enabled: enabledRow?.value === '1',
      tokenHash: tokenRow?.value || null,
      updatedAt: tokenRow?.updated_at || enabledRow?.updated_at || new Date().toISOString(),
    };
  }

  updateAuthConfig(updates: { enabled?: boolean; tokenHash?: string | null }): void {
    if (updates.enabled !== undefined) {
      this.db.prepare(`
        INSERT INTO auth_config (key, value) VALUES ('enabled', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(updates.enabled ? '1' : '0');
    }

    if (updates.tokenHash !== undefined) {
      this.db.prepare(`
        INSERT INTO auth_config (key, value) VALUES ('token_hash', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(updates.tokenHash || '');
    }
  }

  /**
   * Cookie-signing secret persisted across restarts. Generated on first use
   * when COOKIE_SECRET is not provided via the environment.
   */
  getOrCreateCookieSecret(generate: () => string): string {
    const row = this.db.prepare(`SELECT value FROM auth_config WHERE key = 'cookie_secret'`).get() as
      | { value: string }
      | undefined;
    if (row?.value) {
      return row.value;
    }
    const secret = generate();
    this.db.prepare(`
      INSERT INTO auth_config (key, value) VALUES ('cookie_secret', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(secret);
    return secret;
  }
}
