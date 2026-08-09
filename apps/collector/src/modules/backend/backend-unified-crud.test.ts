import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app/app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';

// M1c Task 4: unified backend model CRUD (apiUrl/apiSecret/withAgent) —
// converges the 9 isAgentBackendUrl call sites in backend.service.ts onto
// the new api_url/api_secret/agent_token/agent_id columns. Authenticates
// via the real flow (first-run enable, then /api/auth/verify) so requests
// carry the same orbit-session cookie a browser session would use.
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

describe('unified backend CRUD', () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let app: FastifyInstance;
  let sessionCookie: string;

  beforeEach(async () => {
    ({ db, cleanup } = createTestDatabase());
    app = await createApp({
      port: 0,
      db,
      realtimeStore,
      logger: false,
      autoListen: false,
    });
    sessionCookie = await enableAuthForTest(app, 'a-16-char-token-1');
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    cleanup();
  });

  async function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url,
      payload,
      cookies: { 'orbit-session': sessionCookie },
    });
  }

  it('creates an api-only backend: management yes, no agent token in response', async () => {
    const res = await inject('POST', '/api/backends', { name: 'n1', apiUrl: 'http://10.0.0.1:9090', apiSecret: 's' });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentToken).toBeUndefined();
    const list = (await inject('GET', '/api/backends')).json();
    const b = list.find((x: { name: string }) => x.name === 'n1');
    expect(b.capabilities).toEqual({ monitoring: true, management: true, configEdit: false });
    expect(JSON.stringify(b)).not.toContain('"s"');       // api_secret 不泄漏
  });

  it('creates an agent-only backend and returns the token exactly once', async () => {
    const res = await inject('POST', '/api/backends', { name: 'n2', withAgent: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentToken).toMatch(/\w{16,}/);
    const b = (await inject('GET', '/api/backends')).json().find((x: { name: string }) => x.name === 'n2');
    expect(b.hasAgent).toBe(true);
    expect(b.capabilities.management).toBe(false);         // api_url 未填，管理置灰
    expect(JSON.stringify(b)).not.toContain(res.json().agentToken);
  });

  it('rejects a backend with neither apiUrl nor agent', async () => {
    expect((await inject('POST', '/api/backends', { name: 'n3' })).statusCode).toBe(400);
  });

  it('rejects agent:// as apiUrl', async () => {
    expect((await inject('POST', '/api/backends', { name: 'n4', apiUrl: 'agent://n4' })).statusCode).toBe(400);
  });

  it('filling apiUrl on a migrated agent backend unlocks management', async () => {
    const id = db.createBackend({ name: 'legacy', url: 'agent://legacy', token: 't', agentToken: 't' });
    const res = await inject('PUT', `/api/backends/${id}`, { apiUrl: 'http://10.0.0.9:9090', apiSecret: 'sec' });
    expect(res.statusCode).toBe(200);
    const b = (await inject('GET', '/api/backends')).json().find((x: { id: number }) => x.id === id);
    expect(b.capabilities.management).toBe(true);
    expect(b.hasAgent).toBe(true);                         // agent 通道不受影响
  });

  it('unbind clears agent_id but keeps the token', async () => {
    const id = db.createBackend({ name: 'b', url: 'agent://b', token: 't2', agentToken: 't2', agentId: 'agent-x' });
    await inject('POST', `/api/backends/${id}/agent/unbind`, {});
    const row = db.getBackend(id)!;
    expect(row.agent_id).toBe('');
    expect(row.agent_token).toBe('t2');
  });

  // Code review finding: deleting testConnection's old isAgentBackendUrl
  // short-circuit made an unsupported-scheme URL reach testClashConnection's
  // `new WebSocket(...)`, which throws synchronously inside the `new
  // Promise` executor. The executor turns that into an unhandled rejection
  // rather than a caught error, and POST /api/backends/test has no
  // surrounding try/catch — so it must come back as a graceful
  // { success: false } instead of a 500.
  it('POST /api/backends/test gracefully rejects unsupported/invalid URL schemes instead of crashing', async () => {
    const agentRes = await inject('POST', '/api/backends/test', { url: 'agent://x', token: '' });
    expect(agentRes.statusCode).toBe(200);
    expect(agentRes.json().success).toBe(false);

    const fileRes = await inject('POST', '/api/backends/test', { url: 'file:///etc/passwd', token: '' });
    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.json().success).toBe(false);
  });
});
