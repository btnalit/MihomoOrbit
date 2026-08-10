import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app/app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';
import { MASK_SENTINEL } from './yaml-mask.js';

// M2b Task 6: write-side endpoints (apply/rollback/commands/latest/reveal).
// Same real-auth-flow inject pattern as config-editor.controller.test.ts
// (M2a) — /api/config-editor is NOT in PUBLIC_ROUTES.
async function enableAuthForTest(app: FastifyInstance, token: string): Promise<string> {
  const setupToken = app.authService.getSetupToken();
  const enableRes = await app.inject({
    method: 'POST',
    url: '/api/auth/enable',
    headers: setupToken ? { 'x-setup-token': setupToken } : undefined,
    payload: { token },
  });
  if (enableRes.statusCode !== 200) {
    throw new Error(`enableAuthForTest failed: ${enableRes.statusCode} ${enableRes.body}`);
  }

  const verifyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    payload: { token },
  });
  const cookie = verifyRes.cookies.find((c: { name: string }) => c.name === 'orbit-session');
  if (!cookie) {
    throw new Error(`enableAuthForTest: /api/auth/verify did not set orbit-session cookie (${verifyRes.statusCode} ${verifyRes.body})`);
  }
  return cookie.value;
}

const BASE_CONFIG = [
  'port: 7890',
  'socks-port: 7891',
  'mode: rule',
  'log-level: info',
  'allow-lan: false',
  'external-controller: 127.0.0.1:9090',
  'secret: base-secret-value',
  'bind-address: "*"',
  'external-ui: ui',
  'password: real-password-value',
].join('\n') + '\n';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('config editor controller: write endpoints (M2b)', () => {
  let db: StatsDatabase;
  let dbPath: string;
  let cleanupDb: () => void;
  let app: FastifyInstance;
  let sessionCookie: string;

  beforeEach(async () => {
    ({ db, dbPath, cleanup: cleanupDb } = createTestDatabase());
    app = await createApp({ port: 0, db, realtimeStore, logger: false, autoListen: false });
    sessionCookie = await enableAuthForTest(app, 'a-16-char-token-1');
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    cleanupDb();
  });

  async function authed(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) {
    return app.inject({ method, url, cookies: { 'orbit-session': sessionCookie }, payload });
  }

  function mkAgentBackendWithBinding(token: string, agentId: string, type: 'clash' | 'surge' = 'clash'): number {
    return db.createBackend({ name: `agent-bound-${token}`, url: `agent://${token}`, token, agentToken: token, agentId, type });
  }

  function mkApiOnlyBackend(name: string): number {
    return db.createBackend({ name, url: `http://10.0.0.1:9090`, apiUrl: 'http://10.0.0.1:9090', apiSecret: 'sek' });
  }

  function ingestConfig(backendId: number, content: string, filePath = '/etc/mihomo/config.yaml'): number {
    return db.configVersions.insertIfChanged({
      backendId,
      hash: sha256(content),
      content,
      size: Buffer.byteLength(content, 'utf8'),
      source: 'agent-report',
      filePath,
    }).id;
  }

  // Backdates config_commands.created_at over a raw second connection to the
  // same test db file, to simulate TTL expiry without wall-clock delays —
  // mirrors config-command.repository.test.ts's backdateCreatedAt, needed
  // here because the repository has no public "backdate" method and the
  // HTTP layer only ever sees Date.now(). Opened and closed within the same
  // call so no handle is left open at cleanup() time (Windows fs.rmSync).
  function backdateCommand(commandId: string, sqliteDatetime: string): void {
    const raw = new Database(dbPath);
    try {
      raw.prepare(`UPDATE config_commands SET created_at = ? WHERE command_id = ?`).run(sqliteDatetime, commandId);
    } finally {
      raw.close();
    }
  }

  describe('POST /:backendId/apply', () => {
    it('scenario 1: happy path returns 202 {commandId, versionId} and stores a source=editor version', async () => {
      const id = mkAgentBackendWithBinding('a1', 'agent-a1');
      ingestConfig(id, BASE_CONFIG);
      const baseHash = sha256(BASE_CONFIG);
      const submitted = BASE_CONFIG.replace('port: 7890', 'port: 7899');

      const res = await authed('POST', `/api/config-editor/${id}/apply`, { content: submitted, baseHash });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toMatchObject({ commandId: expect.any(String), versionId: expect.any(Number) });
      expect(body.commandId).toMatch(/^cmd_[0-9a-f]{32}$/);

      const versions = db.configVersions.listMeta(id);
      const editorVersion = versions.find((v) => v.id === body.versionId);
      expect(editorVersion).toMatchObject({ source: 'editor' });

      // Full envelope shape assertion — this is the protocol contract both
      // the agent (Task 1-3) and web (Task 7-11) consume verbatim.
      const stored = db.configCommands.getLatest(id)!;
      expect(stored.command_id).toBe(body.commandId);
      expect(stored.state).toBe('pending');
      const envelope = JSON.parse(stored.payload);
      expect(envelope.commandId).toBe(body.commandId);
      expect(envelope.type).toBe('apply-config');
      expect(envelope.baseHash).toBe(baseHash);
      expect(envelope.content).not.toContain(MASK_SENTINEL);
      expect(envelope.content).toContain('port: 7899');
      expect(envelope.verify).toMatchObject({ port: 7899, mode: 'rule', 'log-level': 'info', 'allow-lan': false });
      expect(typeof envelope.issuedAtMs).toBe('number');
    });

    it('scenario 2: in-flight duplicate apply -> 409 IN_FLIGHT, then succeeds after resolution', async () => {
      const id = mkAgentBackendWithBinding('a2', 'agent-a2');
      ingestConfig(id, BASE_CONFIG);
      const baseHash = sha256(BASE_CONFIG);
      const first = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: BASE_CONFIG.replace('port: 7890', 'port: 7899'),
        baseHash,
      });
      expect(first.statusCode).toBe(202);
      const firstCommandId = first.json().commandId;

      const dup = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: BASE_CONFIG.replace('port: 7890', 'port: 7811'),
        baseHash,
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ code: 'CONFIG_COMMAND_IN_FLIGHT', commandId: firstCommandId });

      // Resolve to a terminal state — using source-agnostic getLatest() as
      // the new baseHash is the discriminating check for the M2a→M2b
      // staleness-baseline decision (see config-editor.controller.ts's
      // module docstring): after this apply, the latest config_versions row
      // is the 'editor' one this test just created, and that row's hash
      // MUST be a valid baseHash for the next apply.
      db.configCommands.resolve(firstCommandId, 'applied', '', new Date().toISOString());

      const newBase = db.configVersions.getLatest(id)!;
      const again = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: newBase.content.replace('port: 7899', 'port: 7822'),
        baseHash: newBase.hash,
      });
      expect(again.statusCode).toBe(202);
    });

    it('YAML_INVALID for malformed submitted YAML', async () => {
      const id = mkAgentBackendWithBinding('a3', 'agent-a3');
      ingestConfig(id, BASE_CONFIG);
      const res = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: 'not: [valid',
        baseHash: sha256(BASE_CONFIG),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('YAML_INVALID');
    });

    it('MASK_PATH_MISSING for a hand-typed sentinel at a path absent from the base', async () => {
      const id = mkAgentBackendWithBinding('a4', 'agent-a4');
      ingestConfig(id, BASE_CONFIG);
      const submitted = BASE_CONFIG + `new-secret-field: ${MASK_SENTINEL}\n`;
      const res = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: submitted,
        baseHash: sha256(BASE_CONFIG),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'MASK_PATH_MISSING', path: 'new-secret-field' });
    });

    it('SELF_LOCK_FIELD_CHANGED for a changed external-controller', async () => {
      const id = mkAgentBackendWithBinding('a5', 'agent-a5');
      ingestConfig(id, BASE_CONFIG);
      const submitted = BASE_CONFIG.replace('external-controller: 127.0.0.1:9090', 'external-controller: 0.0.0.0:9090');
      const res = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: submitted,
        baseHash: sha256(BASE_CONFIG),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'SELF_LOCK_FIELD_CHANGED', field: 'external-controller' });
    });

    it('BASE_HASH_STALE for a baseHash that does not match the latest reported version', async () => {
      const id = mkAgentBackendWithBinding('a6', 'agent-a6');
      ingestConfig(id, BASE_CONFIG);
      const res = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: BASE_CONFIG.replace('port: 7890', 'port: 7899'),
        baseHash: 'not-the-real-hash',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'BASE_HASH_STALE' });
    });

    it('422 UNSUPPORTED_GATEWAY for a surge backend', async () => {
      const id = mkAgentBackendWithBinding('a7', 'agent-a7', 'surge');
      const res = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: BASE_CONFIG,
        baseHash: sha256(BASE_CONFIG),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'UNSUPPORTED_GATEWAY' });
    });

    it('409 NO_CONFIG_EDIT_CAPABILITY for a backend without a bound agent', async () => {
      const id = mkApiOnlyBackend('api-only-apply');
      const res = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: BASE_CONFIG,
        baseHash: sha256(BASE_CONFIG),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'NO_CONFIG_EDIT_CAPABILITY' });
    });

    it('404 NO_CONFIG_REPORTED when the backend has no config version to base an edit on', async () => {
      const id = mkAgentBackendWithBinding('a8', 'agent-a8');
      const res = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: BASE_CONFIG,
        baseHash: sha256(BASE_CONFIG),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NO_CONFIG_REPORTED', backendId: id });
    });

    it('unauthenticated apply is rejected (401) — write path is NOT public either', async () => {
      const id = mkAgentBackendWithBinding('a9', 'agent-a9');
      ingestConfig(id, BASE_CONFIG);
      const res = await app.inject({
        method: 'POST',
        url: `/api/config-editor/${id}/apply`,
        payload: { content: BASE_CONFIG, baseHash: sha256(BASE_CONFIG) },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /:backendId/rollback/:versionId', () => {
    it('scenario 7: rolling back to a prior version content enqueues a command', async () => {
      const id = mkAgentBackendWithBinding('r1', 'agent-r1');
      const v1Id = ingestConfig(id, BASE_CONFIG);

      const apply = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: BASE_CONFIG.replace('port: 7890', 'port: 7899'),
        baseHash: sha256(BASE_CONFIG),
      });
      expect(apply.statusCode).toBe(202);
      db.configCommands.resolve(apply.json().commandId, 'applied', '', new Date().toISOString());

      const res = await authed('POST', `/api/config-editor/${id}/rollback/${v1Id}`);
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toMatchObject({ commandId: expect.any(String), versionId: expect.any(Number) });

      const rolledBackVersion = db.configVersions.getById(id, body.versionId);
      expect(rolledBackVersion?.content).toContain('port: 7890');
      expect(rolledBackVersion?.source).toBe('editor');
    });

    it('404 for a nonexistent target versionId', async () => {
      const id = mkAgentBackendWithBinding('r2', 'agent-r2');
      ingestConfig(id, BASE_CONFIG);
      const res = await authed('POST', `/api/config-editor/${id}/rollback/999999`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /:backendId/reveal', () => {
    it("scenario 8: a masked path resolves to its plaintext value and logs an [AUDIT] line", async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const id = mkAgentBackendWithBinding('v1', 'agent-v1');
        ingestConfig(id, BASE_CONFIG);

        const res = await authed('POST', `/api/config-editor/${id}/reveal`, { path: 'secret' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ value: 'base-secret-value' });

        expect(infoSpy).toHaveBeenCalledWith(
          '[AUDIT] config-reveal',
          expect.objectContaining({ backendId: id, path: 'secret' }),
        );
      } finally {
        infoSpy.mockRestore();
      }
    });

    it('a non-masked path is rejected with 404', async () => {
      const id = mkAgentBackendWithBinding('v2', 'agent-v2');
      ingestConfig(id, BASE_CONFIG);
      const res = await authed('POST', `/api/config-editor/${id}/reveal`, { path: 'nonexistent-field' });
      expect(res.statusCode).toBe(404);
    });

    it('path traversal safety: a path NOT in maskedPaths but validly resolvable in the doc is still 404', async () => {
      const id = mkAgentBackendWithBinding('v3', 'agent-v3');
      // 'mode' is a real, resolvable top-level field but never a masked one.
      ingestConfig(id, BASE_CONFIG);
      const res = await authed('POST', `/api/config-editor/${id}/reveal`, { path: 'mode' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /:backendId/commands/latest', () => {
    it('scenario 9: expired is computed correctly against a backdated created_at', async () => {
      const id = mkAgentBackendWithBinding('c1', 'agent-c1');
      ingestConfig(id, BASE_CONFIG);
      const apply = await authed('POST', `/api/config-editor/${id}/apply`, {
        content: BASE_CONFIG.replace('port: 7890', 'port: 7899'),
        baseHash: sha256(BASE_CONFIG),
      });
      const commandId = apply.json().commandId;

      const fresh = await authed('GET', `/api/config-editor/${id}/commands/latest`);
      expect(fresh.json().command).toMatchObject({ commandId, state: 'pending', expired: false });

      backdateCommand(commandId, '2020-01-01 00:00:00');
      const expired = await authed('GET', `/api/config-editor/${id}/commands/latest`);
      expect(expired.json().command).toMatchObject({ commandId, state: 'pending', expired: true });
    });

    it('returns { command: null } when no command has ever been created', async () => {
      const id = mkAgentBackendWithBinding('c2', 'agent-c2');
      const res = await authed('GET', `/api/config-editor/${id}/commands/latest`);
      expect(res.json()).toEqual({ command: null });
    });
  });
});
