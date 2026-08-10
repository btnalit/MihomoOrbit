import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getAllSchemaStatements } from '../schema.js';
import { ConfigCommandRepository, COMMAND_TTL_MS } from './config-command.repository.js';
import { BackendRepository } from './backend.repository.js';
import { ConfigRepository } from './config.repository.js';

function createRawDb(): Database.Database {
  const db = new Database(':memory:');
  for (const stmt of getAllSchemaStatements()) {
    db.exec(stmt);
  }
  return db;
}

function insertBackend(db: Database.Database, name = 'test'): number {
  const result = db.prepare(`
    INSERT INTO backend_configs (name, url, token, enabled, is_active, listening)
    VALUES (?, 'http://127.0.0.1:9090', '', 1, 1, 1)
  `).run(name);
  return Number(result.lastInsertRowid);
}

// Directly backdates a row's created_at to simulate TTL expiry without
// depending on wall-clock time or fake timers — the repository takes nowMs
// as an explicit parameter precisely so tests can do this.
function backdateCreatedAt(db: Database.Database, commandId: string, sqliteDatetime: string) {
  db.prepare(`UPDATE config_commands SET created_at = ? WHERE command_id = ?`).run(sqliteDatetime, commandId);
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

describe('ConfigCommandRepository state machine', () => {
  let db: Database.Database;
  let repo: ConfigCommandRepository;
  let backendId: number;

  beforeEach(() => {
    db = createRawDb();
    repo = new ConfigCommandRepository(db);
    backendId = insertBackend(db);
  });

  it('create() inserts a pending command visible via getInFlight', () => {
    repo.create({ commandId: 'cmd_1', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });

    const inFlight = repo.getInFlight(backendId, Date.now());

    expect(inFlight).toBeDefined();
    expect(inFlight?.command_id).toBe('cmd_1');
    expect(inFlight?.backend_id).toBe(backendId);
    expect(inFlight?.version_id).toBe(1);
    expect(inFlight?.base_hash).toBe('h1');
    expect(inFlight?.state).toBe('pending');
    expect(inFlight?.reason).toBe('');
    expect(inFlight?.dispatched_at).toBeNull();
    expect(inFlight?.resolved_at).toBeNull();
  });

  it('markDispatched transitions pending -> dispatched and is idempotent (first dispatched_at wins)', () => {
    repo.create({ commandId: 'cmd_2', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });

    repo.markDispatched('cmd_2', '2026-01-01T00:00:00.000Z');
    let row = repo.getLatest(backendId);
    expect(row?.state).toBe('dispatched');
    expect(row?.dispatched_at).toBe('2026-01-01T00:00:00.000Z');

    // Second dispatch heartbeat for the same command must not overwrite
    // dispatched_at nor regress state.
    repo.markDispatched('cmd_2', '2026-01-01T00:05:00.000Z');
    row = repo.getLatest(backendId);
    expect(row?.state).toBe('dispatched');
    expect(row?.dispatched_at).toBe('2026-01-01T00:00:00.000Z');

    // Still counted as in-flight after dispatch.
    expect(repo.getInFlight(backendId, Date.now())?.command_id).toBe('cmd_2');
  });

  it('markDispatched on an unknown commandId is a no-op', () => {
    expect(() => repo.markDispatched('does-not-exist', '2026-01-01T00:00:00.000Z')).not.toThrow();
  });

  it.each(['applied', 'conflict', 'rolled-back', 'failed'] as const)(
    'resolve() transitions to terminal state "%s" and a repeat resolve is idempotent (first-wins)',
    (result) => {
      const commandId = `cmd_${result}`;
      repo.create({ commandId, backendId, versionId: 1, baseHash: 'h1', payload: '{}' });

      const first = repo.resolve(commandId, result, 'reason-1', '2026-01-01T00:10:00.000Z');
      expect(first).toBe(true);

      const row = repo.getLatest(backendId);
      expect(row?.state).toBe(result);
      expect(row?.reason).toBe('reason-1');
      expect(row?.resolved_at).toBe('2026-01-01T00:10:00.000Z');

      // Repeat receipt with a different outcome must not change anything.
      const second = repo.resolve(commandId, 'failed', 'reason-2', '2026-01-01T00:20:00.000Z');
      expect(second).toBe(false);

      const rowAfter = repo.getLatest(backendId);
      expect(rowAfter?.state).toBe(result);
      expect(rowAfter?.reason).toBe('reason-1');
      expect(rowAfter?.resolved_at).toBe('2026-01-01T00:10:00.000Z');

      // A terminal command is no longer in-flight.
      expect(repo.getInFlight(backendId, Date.now())).toBeUndefined();
    },
  );

  it('resolve() on an unknown commandId returns false', () => {
    expect(repo.resolve('does-not-exist', 'applied', '', '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('TTL-expired command is excluded from getInFlight but a late resolve() still lands', () => {
    repo.create({ commandId: 'cmd_ttl', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
    backdateCreatedAt(db, 'cmd_ttl', '2020-01-01 00:00:00');

    const nowMs = Date.now();
    expect(repo.getInFlight(backendId, nowMs)).toBeUndefined();

    // Late receipt: state is still 'pending' in storage (expired is a
    // read-time UI concept only), so the resolve must succeed.
    const resolved = repo.resolve('cmd_ttl', 'applied', 'late-receipt', new Date(nowMs).toISOString());
    expect(resolved).toBe(true);
    expect(repo.getLatest(backendId)?.state).toBe('applied');
  });

  it('a fresh command within the TTL window is visible via getInFlight', () => {
    repo.create({ commandId: 'cmd_fresh', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });

    const nowMs = Date.now();
    expect(repo.getInFlight(backendId, nowMs)?.command_id).toBe('cmd_fresh');
    // Still within the window just before the boundary.
    expect(repo.getInFlight(backendId, nowMs + COMMAND_TTL_MS - 1000)?.command_id).toBe('cmd_fresh');
  });

  it('TTL boundary: a command drops out of getInFlight once its age exceeds COMMAND_TTL_MS', () => {
    repo.create({ commandId: 'cmd_boundary', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
    backdateCreatedAt(db, 'cmd_boundary', '2026-01-01 00:00:00');

    const justBeforeTtl = new Date('2026-01-01T00:09:59.000Z').getTime();
    expect(repo.getInFlight(backendId, justBeforeTtl)?.command_id).toBe('cmd_boundary');

    const justAfterTtl = new Date('2026-01-01T00:10:01.000Z').getTime();
    expect(repo.getInFlight(backendId, justAfterTtl)).toBeUndefined();
  });

  it('create() before an in-flight command resolves keeps both rows but getLatest is unaffected by unrelated backends', () => {
    const backendB = insertBackend(db, 'other-backend');
    repo.create({ commandId: 'cmd_a', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
    repo.create({ commandId: 'cmd_b', backendId: backendB, versionId: 1, baseHash: 'h1', payload: '{}' });

    expect(repo.getInFlight(backendId, Date.now())?.command_id).toBe('cmd_a');
    expect(repo.getInFlight(backendB, Date.now())?.command_id).toBe('cmd_b');

    repo.resolve('cmd_a', 'applied', '', new Date().toISOString());

    // Resolving backend A's command must not affect backend B's in-flight command.
    expect(repo.getInFlight(backendId, Date.now())).toBeUndefined();
    expect(repo.getInFlight(backendB, Date.now())?.command_id).toBe('cmd_b');
  });

  it('getLatest orders by created_at DESC with a tiebreak for same-second inserts', () => {
    repo.create({ commandId: 'cmd_old', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
    backdateCreatedAt(db, 'cmd_old', '2026-01-01 00:00:00');
    repo.create({ commandId: 'cmd_new', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
    backdateCreatedAt(db, 'cmd_new', '2026-01-01 00:00:00');

    // Both rows share the same second-granularity created_at; the later
    // insert (cmd_new) must still be reported as latest.
    expect(repo.getLatest(backendId)?.command_id).toBe('cmd_new');
  });

  it('getLatest returns undefined when the backend has no commands', () => {
    expect(repo.getLatest(backendId)).toBeUndefined();
  });

  // M2b Task 6: isExpired() backs the commands/latest read endpoint's
  // `expired` field. Exercised directly here (string-cutoff comparison,
  // never Date-parses created_at — see the method's docstring and Task 4's
  // binding ledger note) as well as through the HTTP layer in
  // config-editor-write.test.ts.
  describe('isExpired', () => {
    it('a fresh pending command within the TTL window is not expired', () => {
      repo.create({ commandId: 'cmd_exp_fresh', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
      const row = repo.getLatest(backendId)!;
      expect(repo.isExpired(row, Date.now())).toBe(false);
    });

    it('a pending command older than COMMAND_TTL_MS is expired', () => {
      repo.create({ commandId: 'cmd_exp_old', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
      backdateCreatedAt(db, 'cmd_exp_old', '2020-01-01 00:00:00');
      const row = repo.getLatest(backendId)!;
      expect(repo.isExpired(row, Date.now())).toBe(true);
    });

    it('a dispatched command older than COMMAND_TTL_MS is also expired', () => {
      repo.create({ commandId: 'cmd_exp_disp', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
      repo.markDispatched('cmd_exp_disp', '2020-01-01T00:00:00.000Z');
      backdateCreatedAt(db, 'cmd_exp_disp', '2020-01-01 00:00:00');
      const row = repo.getLatest(backendId)!;
      expect(row.state).toBe('dispatched');
      expect(repo.isExpired(row, Date.now())).toBe(true);
    });

    it('a terminal command is never expired regardless of age', () => {
      repo.create({ commandId: 'cmd_exp_term', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
      backdateCreatedAt(db, 'cmd_exp_term', '2020-01-01 00:00:00');
      repo.resolve('cmd_exp_term', 'applied', '', new Date().toISOString());
      const row = repo.getLatest(backendId)!;
      expect(repo.isExpired(row, Date.now())).toBe(false);
    });

    it('boundary: matches getInFlight exactly on either side of COMMAND_TTL_MS', () => {
      repo.create({ commandId: 'cmd_exp_boundary', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
      backdateCreatedAt(db, 'cmd_exp_boundary', '2026-01-01 00:00:00');
      const row = repo.getLatest(backendId)!;

      const justBeforeTtl = new Date('2026-01-01T00:09:59.000Z').getTime();
      expect(repo.isExpired(row, justBeforeTtl)).toBe(false);
      expect(repo.getInFlight(backendId, justBeforeTtl)).toBeDefined();

      const justAfterTtl = new Date('2026-01-01T00:10:01.000Z').getTime();
      expect(repo.isExpired(row, justAfterTtl)).toBe(true);
      expect(repo.getInFlight(backendId, justAfterTtl)).toBeUndefined();
    });
  });
});

describe('config_commands multi-registry cleanup', () => {
  let db: Database.Database;
  let repo: ConfigCommandRepository;
  let backendRepo: BackendRepository;
  let configRepo: ConfigRepository;
  let backendId: number;

  beforeEach(() => {
    db = createRawDb();
    repo = new ConfigCommandRepository(db);
    backendRepo = new BackendRepository(db);
    configRepo = new ConfigRepository(db, ':memory:');
    backendId = insertBackend(db);
  });

  it('deleteBackendData clears config_commands for that backend (cascade substitute)', () => {
    repo.create({ commandId: 'cmd_x', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
    expect(count(db, 'config_commands')).toBe(1);

    backendRepo.deleteBackendData(backendId);

    expect(count(db, 'config_commands')).toBe(0);
  });

  it('cleanupOldData purge-all (days=0) clears config_commands for the scoped backend', () => {
    repo.create({ commandId: 'cmd_y', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });

    configRepo.cleanupOldData(backendId, 0);

    expect(count(db, 'config_commands')).toBe(0);
  });

  it('cleanupOldData purge-all (days=0) does not touch other backends when scoped', () => {
    const otherId = insertBackend(db, 'other');
    repo.create({ commandId: 'cmd_y1', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
    repo.create({ commandId: 'cmd_y2', backendId: otherId, versionId: 1, baseHash: 'h1', payload: '{}' });

    configRepo.cleanupOldData(backendId, 0);

    expect(count(db, 'config_commands')).toBe(1);
  });

  it('cleanupOldData purge-all (days=0, unscoped) clears config_commands across all backends', () => {
    const otherId = insertBackend(db, 'other');
    repo.create({ commandId: 'cmd_z1', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });
    repo.create({ commandId: 'cmd_z2', backendId: otherId, versionId: 1, baseHash: 'h1', payload: '{}' });

    configRepo.cleanupOldData(null, 0);

    expect(count(db, 'config_commands')).toBe(0);
  });

  it('cleanupOldData day-windowed (non-purge) path leaves config_commands untouched', () => {
    repo.create({ commandId: 'cmd_w', backendId, versionId: 1, baseHash: 'h1', payload: '{}' });

    configRepo.cleanupOldData(backendId, 7);

    expect(count(db, 'config_commands')).toBe(1);
  });
});
