import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getAllSchemaStatements } from '../schema.js';
import { ConfigRepository } from './config.repository.js';

const BACKEND_ID = 1;

function createRawDb(): Database.Database {
  const db = new Database(':memory:');
  for (const stmt of getAllSchemaStatements()) {
    db.exec(stmt);
  }
  db.prepare(`
    INSERT INTO backend_configs (name, url, token, enabled, is_active, listening)
    VALUES ('test', 'http://127.0.0.1:9090', '', 1, 1, 1)
  `).run();
  return db;
}

function seedDimRows(db: Database.Database, isoMinute: string) {
  const hour = isoMinute.slice(0, 13) + ':00:00';
  db.prepare(`
    INSERT INTO minute_dim_stats (backend_id, minute, domain, ip, source_ip, chain, rule, upload, download, connections)
    VALUES (?, ?, 'a.com', '1.1.1.1', '', 'ProxyA', 'RuleA', 1, 1, 1)
  `).run(BACKEND_ID, isoMinute);
  db.prepare(`
    INSERT INTO hourly_dim_stats (backend_id, hour, domain, ip, source_ip, chain, rule, upload, download, connections)
    VALUES (?, ?, 'a.com', '1.1.1.1', '', 'ProxyA', 'RuleA', 1, 1, 1)
  `).run(BACKEND_ID, hour);
  db.prepare(`
    INSERT INTO hourly_country_stats (backend_id, hour, country, country_name, continent, upload, download, connections)
    VALUES (?, ?, 'US', 'United States', 'NA', 1, 1, 1)
  `).run(BACKEND_ID, hour);
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

describe('tiered retention', () => {
  let db: Database.Database;
  let repo: ConfigRepository;

  beforeEach(() => {
    db = createRawDb();
    repo = new ConfigRepository(db, ':memory:');
  });

  it('minute cutoff must not touch hourly dim/country tables', () => {
    seedDimRows(db, '2026-06-01T00:00:00');

    // 7-day style cutoff far after the seeded rows
    repo.deleteOldMinuteStats('2026-06-20T00:00:00.000Z');

    expect(count(db, 'minute_dim_stats')).toBe(0);
    expect(count(db, 'hourly_dim_stats')).toBe(1);
    expect(count(db, 'hourly_country_stats')).toBe(1);
  });

  it('hourly cutoff cleans hourly_stats plus hourly dim/country tables', () => {
    seedDimRows(db, '2026-06-01T00:00:00');
    db.prepare(`INSERT INTO hourly_stats (backend_id, hour, upload, download, connections) VALUES (?, '2026-06-01T00:00:00', 1, 1, 1)`).run(BACKEND_ID);

    repo.deleteOldHourlyStats('2026-06-20T00:00:00');

    expect(count(db, 'hourly_stats')).toBe(0);
    expect(count(db, 'hourly_dim_stats')).toBe(0);
    expect(count(db, 'hourly_country_stats')).toBe(0);
  });

  it('hourly cutoff keeps rows newer than the window', () => {
    seedDimRows(db, '2026-06-25T00:00:00');

    repo.deleteOldHourlyStats('2026-06-20T00:00:00');

    expect(count(db, 'hourly_dim_stats')).toBe(1);
  });
});

describe('cleanupOldData purge-all (days === 0)', () => {
  // M2 regression: config_versions holds plaintext secrets (agent-reported
  // config.yaml content, pre-masking). The purge-all path must clear it
  // along with every other stats table, both scoped to one backend and
  // globally (backendId === null).
  let db: Database.Database;
  let repo: ConfigRepository;

  beforeEach(() => {
    db = createRawDb();
    repo = new ConfigRepository(db, ':memory:');
  });

  function seedConfigVersion(backendId: number, hash: string) {
    db.prepare(`
      INSERT INTO config_versions (backend_id, hash, content, size, source, file_path)
      VALUES (?, ?, 'port: 7890', 11, 'agent-report', '/etc/mihomo/config.yaml')
    `).run(backendId, hash);
  }

  it('clears config_versions for the scoped backend', () => {
    seedConfigVersion(BACKEND_ID, 'h1');
    expect(count(db, 'config_versions')).toBe(1);

    repo.cleanupOldData(BACKEND_ID, 0);

    expect(count(db, 'config_versions')).toBe(0);
  });

  it('does not touch other backends when scoped', () => {
    const otherId = db.prepare(`
      INSERT INTO backend_configs (name, url, token, enabled, is_active, listening)
      VALUES ('other', 'http://127.0.0.1:9091', '', 1, 1, 1)
    `).run().lastInsertRowid as number;
    seedConfigVersion(BACKEND_ID, 'h1');
    seedConfigVersion(otherId, 'h2');

    repo.cleanupOldData(BACKEND_ID, 0);

    expect(count(db, 'config_versions')).toBe(1);
  });

  it('clears config_versions across all backends when unscoped (backendId=null)', () => {
    const otherId = db.prepare(`
      INSERT INTO backend_configs (name, url, token, enabled, is_active, listening)
      VALUES ('other', 'http://127.0.0.1:9091', '', 1, 1, 1)
    `).run().lastInsertRowid as number;
    seedConfigVersion(BACKEND_ID, 'h1');
    seedConfigVersion(otherId, 'h2');

    repo.cleanupOldData(null, 0);

    expect(count(db, 'config_versions')).toBe(0);
  });

  it('the day-windowed (non-purge) path leaves config_versions untouched', () => {
    seedConfigVersion(BACKEND_ID, 'h1');

    repo.cleanupOldData(BACKEND_ID, 7);

    expect(count(db, 'config_versions')).toBe(1);
  });
});
