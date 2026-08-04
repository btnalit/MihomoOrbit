import { StatsDatabase } from '../modules/db/db.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Create a temporary StatsDatabase backed by a real file (better-sqlite3
 * does not support :memory: with the full schema init).
 * Automatically cleaned up via the returned `cleanup` function.
 */
export function createTestDatabase(): { db: StatsDatabase; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new StatsDatabase(dbPath);
  return {
    db,
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
