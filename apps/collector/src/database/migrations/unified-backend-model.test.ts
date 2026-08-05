import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateBackendConfigsToUnifiedModel } from './unified-backend-model.js';

// 模拟 v0.1.0 库:旧 schema(无 4 新列)+ 存量 agent/直连行 + 心跳
describe('unified backend model migration', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-m1c-'));
    db = new Database(path.join(tmpDir, 'legacy.db'));
    db.exec(`
      CREATE TABLE backend_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, url TEXT NOT NULL, token TEXT DEFAULT '',
        type TEXT DEFAULT 'clash', enabled BOOLEAN DEFAULT 1,
        is_active BOOLEAN DEFAULT 0, listening BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE agent_heartbeats (
        backend_id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL,
        last_seen DATETIME NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO backend_configs (name, url, token) VALUES
        ('router',  'agent://router',          'agent-secret-1'),
        ('orphan',  'agent://orphan',          'agent-secret-2'),
        ('direct1', 'http://10.20.2.1:9090',   'mihomo-secret');
      INSERT INTO agent_heartbeats (backend_id, agent_id, last_seen)
        VALUES (1, 'agent-abc123', datetime('now'));
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('splits agent rows: token -> agent_token, heartbeat agent adopted as explicit binding', () => {
    migrateBackendConfigsToUnifiedModel(db);
    const row = db.prepare('SELECT * FROM backend_configs WHERE id = 1').get() as Record<string, string>;
    expect(row.agent_token).toBe('agent-secret-1');
    expect(row.agent_id).toBe('agent-abc123');   // 现役绑定固化为显式绑定
    expect(row.api_url).toBe('');                // API 地址待用户补全
    expect(row.api_secret).toBe('');
  });

  it('leaves agent rows without heartbeat unbound (first valid heartbeat will claim)', () => {
    migrateBackendConfigsToUnifiedModel(db);
    const row = db.prepare('SELECT * FROM backend_configs WHERE id = 2').get() as Record<string, string>;
    expect(row.agent_token).toBe('agent-secret-2');
    expect(row.agent_id).toBe('');
  });

  it('splits direct rows: url -> api_url, token -> api_secret, no agent', () => {
    migrateBackendConfigsToUnifiedModel(db);
    const row = db.prepare('SELECT * FROM backend_configs WHERE id = 3').get() as Record<string, string>;
    expect(row.api_url).toBe('http://10.20.2.1:9090');
    expect(row.api_secret).toBe('mihomo-secret');
    expect(row.agent_token).toBe('');
    expect(row.agent_id).toBe('');
  });

  it('is idempotent: running twice changes nothing', () => {
    migrateBackendConfigsToUnifiedModel(db);
    const before = db.prepare('SELECT * FROM backend_configs ORDER BY id').all();
    migrateBackendConfigsToUnifiedModel(db);
    expect(db.prepare('SELECT * FROM backend_configs ORDER BY id').all()).toEqual(before);
  });

  it('keeps url/token untouched as rollback mirror', () => {
    migrateBackendConfigsToUnifiedModel(db);
    const row = db.prepare('SELECT url, token FROM backend_configs WHERE id = 1').get() as Record<string, string>;
    expect(row.url).toBe('agent://router');
    expect(row.token).toBe('agent-secret-1');
  });
});

// Fresh-schema shape: backend_configs is created WITH the 4 new columns already
// (as schema.ts now does), but rows can still land in legacy shape afterward —
// e.g. an ancient-DB upgrade's performMigration() inserting the 'Default' backend
// relying on column defaults, or a pre-Task-2 createBackend({name,url,token}) call.
// The column-existence check must not skip backfilling these.
describe('unified backend model migration — late-inserted legacy rows (fresh-schema shape)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-m1c-late-'));
    db = new Database(path.join(tmpDir, 'fresh.db'));
    db.exec(`
      CREATE TABLE backend_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, url TEXT NOT NULL, token TEXT DEFAULT '',
        type TEXT DEFAULT 'clash', enabled BOOLEAN DEFAULT 1,
        is_active BOOLEAN DEFAULT 0, listening BOOLEAN DEFAULT 1,
        api_url TEXT DEFAULT '', api_secret TEXT DEFAULT '',
        agent_token TEXT DEFAULT '', agent_id TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE agent_heartbeats (
        backend_id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL,
        last_seen DATETIME NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO backend_configs (name, url, token) VALUES
        ('legacy-direct', 'http://192.168.1.1:9090', 'mihomo-secret'),
        ('legacy-agent',  'agent://legacy',          'agent-secret-3');
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills legacy-shaped rows even though the columns already exist', () => {
    migrateBackendConfigsToUnifiedModel(db);

    const direct = db.prepare('SELECT * FROM backend_configs WHERE name = ?').get('legacy-direct') as Record<string, string>;
    expect(direct.api_url).toBe('http://192.168.1.1:9090');
    expect(direct.api_secret).toBe('mihomo-secret');
    expect(direct.agent_token).toBe('');
    expect(direct.agent_id).toBe('');

    const agent = db.prepare('SELECT * FROM backend_configs WHERE name = ?').get('legacy-agent') as Record<string, string>;
    expect(agent.agent_token).toBe('agent-secret-3');
    expect(agent.agent_id).toBe('');
    expect(agent.api_url).toBe('');
  });
});
