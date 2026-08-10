import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';

// M2b Task 6: heartbeat-only command dispatch + commandResults receipt
// ingestion. Verifies the dual-contract invariant from the plan's global
// constraints: ONLY POST /api/agent/heartbeat may attach a `commands` field
// to its response — /agent/report, /agent/config, /agent/policy-state and
// /agent/config-file (M2a) must never gain it, no matter what protocolVersion
// they're sent with.

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function heartbeat(
  app: FastifyInstance,
  opts: { backendId: number; token: string; agentId: string; protocolVersion?: number; commandResults?: unknown[] },
) {
  return app.inject({
    method: 'POST',
    url: '/api/agent/heartbeat',
    headers: { authorization: `Bearer ${opts.token}` },
    payload: {
      backendId: opts.backendId,
      agentId: opts.agentId,
      protocolVersion: opts.protocolVersion ?? 1,
      commandResults: opts.commandResults,
    },
  });
}

describe('heartbeat command dispatch + receipt ingestion (M2b)', () => {
  let db: StatsDatabase;
  let dbPath: string;
  let cleanup: () => void;
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ db, dbPath, cleanup } = createTestDatabase());
    app = await createApp({ port: 0, db, realtimeStore, logger: false, autoListen: false });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    cleanup();
  });

  function mkBoundBackend(token: string, agentId: string): number {
    const id = db.createBackend({ name: `b-${token}`, url: `agent://${token}`, token, agentToken: token, type: 'clash' });
    db.claimAgentBinding(id, agentId);
    return id;
  }

  function seedCommand(backendId: number, commandId: string): { versionId: number } {
    const content = `port: 7890\n# ${commandId}\n`;
    const { id: versionId } = db.configVersions.insertIfChanged({
      backendId,
      hash: sha256(content),
      content,
      size: Buffer.byteLength(content, 'utf8'),
      source: 'editor',
      filePath: '/etc/mihomo/config.yaml',
    });
    db.configCommands.create({
      commandId,
      backendId,
      versionId,
      baseHash: 'base-hash-x',
      payload: JSON.stringify({
        commandId,
        type: 'apply-config',
        baseHash: 'base-hash-x',
        content,
        verify: { port: 7890 },
        issuedAtMs: Date.now(),
      }),
    });
    return { versionId };
  }

  function backdateCommand(commandId: string, sqliteDatetime: string): void {
    const raw = new Database(dbPath);
    try {
      raw.prepare(`UPDATE config_commands SET created_at = ? WHERE command_id = ?`).run(sqliteDatetime, commandId);
    } finally {
      raw.close();
    }
  }

  describe('dispatch (scenario 4)', () => {
    it('protocolVersion 2 with an in-flight command attaches commands and marks it dispatched', async () => {
      const id = mkBoundBackend('d1', 'agent-d1');
      seedCommand(id, 'cmd_d1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const res = await heartbeat(app, { backendId: id, token: 'd1', agentId: 'agent-d1', protocolVersion: 2 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0]).toMatchObject({ commandId: 'cmd_d1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: 'apply-config' });

      expect(db.configCommands.getLatest(id)?.state).toBe('dispatched');
    });

    it('a second protocolVersion 2 heartbeat re-dispatches the same still-pending/dispatched command', async () => {
      const id = mkBoundBackend('d2', 'agent-d2');
      seedCommand(id, 'cmd_d2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      await heartbeat(app, { backendId: id, token: 'd2', agentId: 'agent-d2', protocolVersion: 2 });
      const second = await heartbeat(app, { backendId: id, token: 'd2', agentId: 'agent-d2', protocolVersion: 2 });

      expect(second.json().commands).toHaveLength(1);
      expect(second.json().commands[0].commandId).toBe('cmd_d2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      // Idempotent dispatch marker: state stays 'dispatched', not regressed.
      expect(db.configCommands.getLatest(id)?.state).toBe('dispatched');
    });

    it('protocolVersion 1 never attaches commands, and leaves command state untouched', async () => {
      const id = mkBoundBackend('d3', 'agent-d3');
      seedCommand(id, 'cmd_d3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const res = await heartbeat(app, { backendId: id, token: 'd3', agentId: 'agent-d3', protocolVersion: 1 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('commands');
      expect(db.configCommands.getLatest(id)?.state).toBe('pending');
    });

    it('an expired (past-TTL) in-flight command is not re-dispatched even at protocolVersion 2', async () => {
      const id = mkBoundBackend('d4', 'agent-d4');
      seedCommand(id, 'cmd_d4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      backdateCommand('cmd_d4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2020-01-01 00:00:00');

      const res = await heartbeat(app, { backendId: id, token: 'd4', agentId: 'agent-d4', protocolVersion: 2 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('commands');
      // Still 'pending' in storage — expired is read-time only, never
      // written back, so a still-in-window future heartbeat is unaffected.
      expect(db.configCommands.getLatest(id)?.state).toBe('pending');
    });

    it('no in-flight command at all -> protocolVersion 2 response still has no commands key', async () => {
      const id = mkBoundBackend('d5', 'agent-d5');
      const res = await heartbeat(app, { backendId: id, token: 'd5', agentId: 'agent-d5', protocolVersion: 2 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('commands');
    });
  });

  describe('receipt ingestion (scenario 5)', () => {
    it('a commandResults entry with result "applied" resolves the command and sets resolved_at', async () => {
      const id = mkBoundBackend('e1', 'agent-e1');
      seedCommand(id, 'cmd_e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      const res = await heartbeat(app, {
        backendId: id,
        token: 'e1',
        agentId: 'agent-e1',
        protocolVersion: 2,
        commandResults: [{ commandId: 'cmd_e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result: 'applied', reason: '', completedAtMs: Date.now() }],
      });
      expect(res.statusCode).toBe(200);

      const stored = db.configCommands.getLatest(id)!;
      expect(stored.state).toBe('applied');
      expect(stored.resolved_at).not.toBeNull();
      // A resolved (terminal) command must not be re-dispatched in the very
      // same response — ingestion runs before the dispatch decision.
      expect(res.json()).not.toHaveProperty('commands');
    });

    it('a late receipt for a TTL-expired command still lands (expired is read-time only)', async () => {
      const id = mkBoundBackend('e2', 'agent-e2');
      seedCommand(id, 'cmd_e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      backdateCommand('cmd_e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2020-01-01 00:00:00');

      const res = await heartbeat(app, {
        backendId: id,
        token: 'e2',
        agentId: 'agent-e2',
        protocolVersion: 2,
        commandResults: [{ commandId: 'cmd_e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result: 'rolled-back', reason: 'reload failed', completedAtMs: Date.now() }],
      });
      expect(res.statusCode).toBe(200);

      const stored = db.configCommands.getLatest(id)!;
      expect(stored.state).toBe('rolled-back');
      expect(stored.reason).toBe('reload failed');
    });

    it('an unknown commandId in commandResults is ignored without failing the heartbeat', async () => {
      const id = mkBoundBackend('e3', 'agent-e3');
      const res = await heartbeat(app, {
        backendId: id,
        token: 'e3',
        agentId: 'agent-e3',
        protocolVersion: 2,
        commandResults: [{ commandId: 'cmd_does_not_exist', result: 'applied', reason: '', completedAtMs: Date.now() }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('an unrecognized result string is ignored without failing the heartbeat or resolving the command', async () => {
      const id = mkBoundBackend('e4', 'agent-e4');
      seedCommand(id, 'cmd_e4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      // protocolVersion 1 here so the dispatch step (pending -> dispatched)
      // never runs, isolating this assertion to "ingestion left the command
      // non-terminal" rather than conflating it with dispatch's own state
      // transition (see the protocolVersion-2 dispatch tests above for that).
      const res = await heartbeat(app, {
        backendId: id,
        token: 'e4',
        agentId: 'agent-e4',
        protocolVersion: 1,
        commandResults: [{ commandId: 'cmd_e4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result: 'bogus-outcome', reason: '', completedAtMs: Date.now() }],
      });
      expect(res.statusCode).toBe(200);
      expect(db.configCommands.getLatest(id)?.state).toBe('pending');
    });
  });

  describe('dual-contract: only /api/agent/heartbeat may attach commands (scenario 6)', () => {
    it('/api/agent/report response has no commands key', async () => {
      const id = mkBoundBackend('f1', 'agent-f1');
      seedCommand(id, 'cmd_f1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/report',
        headers: { authorization: 'Bearer f1' },
        payload: { backendId: id, agentId: 'agent-f1', protocolVersion: 2, requestId: 'r1', updates: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('commands');
    });

    it('/api/agent/config response has no commands key', async () => {
      const id = mkBoundBackend('f2', 'agent-f2');
      seedCommand(id, 'cmd_f2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/config',
        headers: { authorization: 'Bearer f2' },
        payload: {
          backendId: id,
          agentId: 'agent-f2',
          config: { rules: [], proxies: {}, providers: {}, timestamp: Date.now(), hash: 'h1' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('commands');
    });

    it('/api/agent/policy-state response has no commands key', async () => {
      const id = mkBoundBackend('f3', 'agent-f3');
      seedCommand(id, 'cmd_f3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/policy-state',
        headers: { authorization: 'Bearer f3' },
        payload: {
          backendId: id,
          agentId: 'agent-f3',
          policyState: { proxies: {}, providers: {}, timestamp: Date.now() },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('commands');
    });

    it('/api/agent/config-file response has no commands key', async () => {
      const id = mkBoundBackend('f4', 'agent-f4');
      seedCommand(id, 'cmd_f4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const content = 'port: 1\n';
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/config-file',
        headers: { authorization: 'Bearer f4' },
        payload: {
          backendId: id,
          agentId: 'agent-f4',
          protocolVersion: 2,
          configFile: { path: '/etc/mihomo/config.yaml', hash: sha256(content), content, size: Buffer.byteLength(content, 'utf8') },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('commands');
    });
  });
});
