import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app/app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';

// M2a Task 5: masked config read API. Same real-auth-flow inject pattern as
// backend-unified-crud.test.ts / management.controller.test.ts so requests
// carry the same orbit-session cookie a browser session would use — the
// /api/config-editor prefix is NOT in PUBLIC_ROUTES, so it sits behind the
// same mandatory-auth hooks as /api/management.
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

describe('config editor controller: masked read API', () => {
  let db: StatsDatabase;
  let cleanupDb: () => void;
  let app: FastifyInstance;
  let sessionCookie: string;

  beforeEach(async () => {
    ({ db, cleanup: cleanupDb } = createTestDatabase());
    app = await createApp({ port: 0, db, realtimeStore, logger: false, autoListen: false });
    sessionCookie = await enableAuthForTest(app, 'a-16-char-token-1');
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    cleanupDb();
  });

  async function authed(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string) {
    return app.inject({ method, url, cookies: { 'orbit-session': sessionCookie } });
  }

  // agent_id non-empty: mkAgentBackendWithBinding
  function mkAgentBackendWithBinding(token: string, agentId: string): number {
    return db.createBackend({ name: `agent-bound-${token}`, url: `agent://${token}`, token, agentToken: token, agentId });
  }

  // agent_id empty (api-only backend, no bound agent): capability gate must 409
  function mkApiOnlyBackend(name: string): number {
    return db.createBackend({ name, url: `http://10.0.0.1:9090`, apiUrl: 'http://10.0.0.1:9090', apiSecret: 'sek' });
  }

  function ingestConfig(backendId: number, content: string): void {
    db.configVersions.insertIfChanged({
      backendId,
      hash: createHash('sha256').update(content).digest('hex'),
      content,
      size: Buffer.byteLength(content, 'utf8'),
      source: 'agent-report',
      filePath: '/etc/mihomo/config.yaml',
    });
  }

  it('GET current returns masked content for a configEdit-capable backend', async () => {
    const id = mkAgentBackendWithBinding('t1', 'agent-x');
    ingestConfig(id, 'secret: s1\nport: 7890\n');
    const res = await authed('GET', `/api/config-editor/${id}/current`);
    expect(res.statusCode).toBe(200);
    expect(res.json().maskedContent).toContain('__ORBIT_MASKED__');
    expect(res.json().maskedContent).not.toContain('s1');
    expect(res.json().maskedContent).toContain('7890');
    expect(res.json().maskedPaths).toEqual(['secret']);
    expect(res.json()).toMatchObject({
      hash: expect.any(String),
      size: expect.any(Number),
      filePath: '/etc/mihomo/config.yaml',
      createdAt: expect.any(String),
      versionId: expect.any(Number),
      parseError: false,
    });
  });

  // Additive beyond the plan's literal /current response shape (which lists
  // only maskedContent/maskedPaths): surfaces maskYamlSecrets's parseError
  // so a client can tell "empty config" apart from "stored content no
  // longer parses as YAML, do not offer editing" instead of silently losing
  // that signal at the controller boundary. Reachable in practice if a
  // future write path (M2b) ever stores non-YAML content.
  it('surfaces parseError:true (with empty maskedContent) for a stored version that fails to parse', async () => {
    const id = mkAgentBackendWithBinding('t5', 'agent-v');
    ingestConfig(id, 'a: [unclosed');
    const res = await authed('GET', `/api/config-editor/${id}/current`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ parseError: true, maskedContent: '', maskedPaths: [] });
  });

  it('409 NO_CONFIG_EDIT_CAPABILITY for a backend without a bound agent', async () => {
    const id = mkApiOnlyBackend('api-only-b');
    const res = await authed('GET', `/api/config-editor/${id}/current`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NO_CONFIG_EDIT_CAPABILITY', backendId: id });
  });

  it('404 for a nonexistent backend takes priority over the capability check', async () => {
    const res = await authed('GET', '/api/config-editor/999999/current');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).not.toBe('NO_CONFIG_EDIT_CAPABILITY');
  });

  it('404 NO_CONFIG_REPORTED before any report', async () => {
    const id = mkAgentBackendWithBinding('t2', 'agent-y');
    const res = await authed('GET', `/api/config-editor/${id}/current`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NO_CONFIG_REPORTED', backendId: id });
  });

  it('versions list excludes content', async () => {
    const id = mkAgentBackendWithBinding('t3', 'agent-z');
    ingestConfig(id, 'port: 1\n');
    ingestConfig(id, 'port: 2\n');
    const res = await authed('GET', `/api/config-editor/${id}/versions`);
    expect(res.statusCode).toBe(200);
    const { versions } = res.json();
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    for (const v of versions) {
      expect(v).not.toHaveProperty('content');
      expect(v).toMatchObject({
        versionId: expect.any(Number),
        hash: expect.any(String),
        size: expect.any(Number),
        source: expect.any(String),
        createdAt: expect.any(String),
      });
    }
  });

  it('versions list is empty for a bound backend with no reports yet', async () => {
    const id = mkAgentBackendWithBinding('t6', 'agent-empty');
    const res = await authed('GET', `/api/config-editor/${id}/versions`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ versions: [] });
  });

  it('409 NO_CONFIG_EDIT_CAPABILITY on /versions for an unbound backend too', async () => {
    const id = mkApiOnlyBackend('api-only-versions');
    const res = await authed('GET', `/api/config-editor/${id}/versions`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NO_CONFIG_EDIT_CAPABILITY');
  });

  it('unauthenticated request is rejected (401) — /api/config-editor is NOT public', async () => {
    const id = mkAgentBackendWithBinding('t4', 'agent-w');
    ingestConfig(id, 'port: 1\n');
    const res = await app.inject({ method: 'GET', url: `/api/config-editor/${id}/current` });
    expect(res.statusCode).toBe(401);
  });
});
