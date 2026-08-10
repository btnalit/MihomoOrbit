import { StatsDatabase } from '../modules/db/db.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Create a temporary StatsDatabase backed by a real file (better-sqlite3
 * does not support :memory: with the full schema init).
 * Automatically cleaned up via the returned `cleanup` function.
 *
 * `dbPath` is returned (M2b) so tests can open a short-lived second
 * better-sqlite3 connection to the same file for raw-SQL setup that has no
 * repository-level method (e.g. backdating config_commands.created_at to
 * simulate TTL expiry over HTTP, mirroring config-command.repository.test.ts's
 * backdateCreatedAt at the repository level). Always close that second
 * connection before `cleanup()` runs — an open handle at that point makes
 * `fs.rmSync` fail on Windows.
 */
export function createTestDatabase(): { db: StatsDatabase; dbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new StatsDatabase(dbPath);
  return {
    db,
    dbPath,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a backend and return its ID.
 */
export function createTestBackend(
  db: StatsDatabase,
  name = 'test-backend',
  url = 'http://127.0.0.1:9090',
): number {
  const id = db.createBackend({ name, url, token: '', type: 'clash' });
  db.setActiveBackend(id);
  return id;
}
