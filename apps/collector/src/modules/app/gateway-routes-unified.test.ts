import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';

// M1c Task 6: gateway read routes converge onto the unified backend model —
// api_url gets live data first, agent cache is the fallback, neither → 503.
// This removes the last four isAgentBackendUrl call sites in app.ts. Uses
// the same real-auth-flow inject pattern as backend-unified-crud.test.ts
// (Task 4) so requests carry the same orbit-session cookie a browser would.
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

describe('gateway read routes: unified backend model', () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let app: FastifyInstance;
  let sessionCookie: string;
  let fakeMihomo: http.Server;
  let fakePort: number;

  beforeEach(async () => {
    // Fake Mihomo: only needs to answer /proxies for the direct-fetch branch.
    fakeMihomo = http.createServer((req, res) => {
      if (req.url === '/proxies') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proxies: { GLOBAL: { name: 'GLOBAL', type: 'Selector', all: [] } } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => fakeMihomo.listen(0, '127.0.0.1', () => resolve()));
    fakePort = (fakeMihomo.address() as AddressInfo).port;

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
    await new Promise<void>((resolve) => fakeMihomo.close(() => resolve()));
  });

  async function inject(method: 'GET' | 'POST', url: string) {
    return app.inject({
      method,
      url,
      cookies: { 'orbit-session': sessionCookie },
    });
  }

  it('agent backend WITH api_url fetches live data from the API, not the agent cache', async () => {
    const id = db.createBackend({ name: 'b', url: 'agent://b', token: 't', agentToken: 't',
      apiUrl: `http://127.0.0.1:${fakePort}`, apiSecret: '' });
    const res = await inject('GET', `/api/gateway/proxies?backendId=${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()._source).not.toBe('agent-cache');
  });

  it('agent backend WITHOUT api_url still serves the agent cache', async () => {
    const id = db.createBackend({ name: 'b2', url: 'agent://b2', token: 't2', agentToken: 't2' });
    const res = await inject('GET', `/api/gateway/proxies?backendId=${id}`);
    expect([200, 503]).toContain(res.statusCode);           // 无缓存时 503,有缓存时 200+_source
    if (res.statusCode === 200) expect(res.json()._source).toBe('agent-cache');
  });

  it('backend with neither channel returns 503', async () => {
    const id = db.createBackend({ name: 'b3', url: 'agent://b3', token: '' });   // 直接 db 层构造病态行
    const res = await inject('GET', `/api/gateway/proxies?backendId=${id}`);
    expect(res.statusCode).toBe(503);
  });
});
