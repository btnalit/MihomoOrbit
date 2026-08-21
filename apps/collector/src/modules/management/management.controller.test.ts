import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app/app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';

// Task 2 fix round: controller-level coverage for auth-hook protection and
// unified error mapping — the service test (management.service.test.ts)
// covers ManagementService directly with a stubbed hub; this file covers the
// Fastify wiring (registration behind the global auth hook, resolve() 404/409
// short-circuit, and mapUpstreamError's 502/504 mapping) that only exists at
// the controller layer. Same real-auth-flow inject pattern as
// backend-unified-crud.test.ts (Task 4/M1c) so requests carry the same
// orbit-session cookie a browser would.
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

// Minimal fake Mihomo: only the routes these tests actually exercise
// (GET /proxies, GET /proxies/:name/delay, GET /providers/{rules,proxies},
// PUT /providers/{rules,proxies}/:name). Can be told to hang (never
// respond) to exercise the AbortSignal.timeout -> 504 path, or to reject
// every request with 401 to exercise the UPSTREAM_UNAUTHORIZED -> 502 path.
// `/providers/{rules,proxies}/missing-provider` 404s to exercise the
// reachable-upstream-4xx -> 502 mapping for a bad refresh target name.
function createFakeMihomo(state: { hang: boolean; unauthorized?: boolean }): http.Server {
  return http.createServer((req, res) => {
    if (state.hang) {
      return; // never respond
    }

    if (state.unauthorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }

    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/proxies') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        proxies: {
          GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['A-Group'] },
          'A-Group': { name: 'A-Group', type: 'Selector', all: ['N1', 'N2'] },
          N1: { name: 'N1', type: 'Shadowsocks' },
          N2: { name: 'N2', type: 'Shadowsocks' },
        },
      }));
      return;
    }

    if (req.method === 'GET' && /^\/proxies\/[^/]+\/delay/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ delay: 42 }));
      return;
    }

    if (req.method === 'GET' && url === '/providers/rules') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        providers: {
          Reject: { name: 'Reject', vehicleType: 'Compatible', behavior: 'domain', ruleCount: 1, updatedAt: '2026-01-01T00:00:00Z' },
          MyRules: { name: 'MyRules', vehicleType: 'HTTP', behavior: 'classical', ruleCount: 33, updatedAt: '2026-08-20T10:00:00Z' },
        },
      }));
      return;
    }

    if (req.method === 'GET' && url === '/providers/proxies') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        providers: {
          default: { name: 'default', vehicleType: 'Compatible', proxies: [{ name: 'a' }], updatedAt: '2026-01-01T00:00:00Z' },
          MyProxies: { name: 'MyProxies', vehicleType: 'HTTP', proxies: [{ name: 'p1' }, { name: 'p2' }], updatedAt: '2026-08-20T09:00:00Z' },
        },
      }));
      return;
    }

    if (req.method === 'PUT' && /^\/providers\/(rules|proxies)\/missing-provider$/.test(url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
      return;
    }

    if (req.method === 'PUT' && /^\/providers\/(rules|proxies)\/[^/]+$/.test(url)) {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });
}

describe('management controller: auth protection + error mapping', () => {
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

  async function authed(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: Record<string, unknown>) {
    return app.inject({ method, url, payload, cookies: { 'orbit-session': sessionCookie } });
  }

  it('unauthenticated GET /api/management/:id/groups is rejected by the global auth hook', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/management/1/groups' });
    expect(res.statusCode).toBe(401);
  });

  it('a backend with no api_url is refused with 409 NO_MANAGEMENT_CAPABILITY', async () => {
    const id = db.createBackend({ name: 'agent-only', url: 'agent://a', token: 't', agentToken: 't' });
    const res = await authed('GET', `/api/management/${id}/groups`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NO_MANAGEMENT_CAPABILITY', backendId: id });
  });

  // M1.5: same capability gate applies to the new providers routes — resolve()
  // is shared with every other management route, but the plan explicitly
  // calls this out as an acceptance point for the providers endpoints.
  it('GET providers on a backend with no api_url is refused with 409 NO_MANAGEMENT_CAPABILITY', async () => {
    const id = db.createBackend({ name: 'agent-only-2', url: 'agent://a', token: 't', agentToken: 't' });
    const res = await authed('GET', `/api/management/${id}/providers`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NO_MANAGEMENT_CAPABILITY', backendId: id });
  });

  it('a nonexistent backendId returns 404', async () => {
    const res = await authed('GET', '/api/management/999999/groups');
    expect(res.statusCode).toBe(404);
  });

  describe('against a live fake Mihomo upstream', () => {
    let upstream: http.Server;
    let upstreamState: { hang: boolean };
    let backendId: number;

    beforeEach(async () => {
      upstreamState = { hang: false };
      upstream = createFakeMihomo(upstreamState);
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
      const port = (upstream.address() as AddressInfo).port;
      backendId = db.createBackend({
        name: 'mgmt-controller-test',
        url: `ws://127.0.0.1:${port}/connections`,
        token: '',
        apiUrl: `http://127.0.0.1:${port}`,
        apiSecret: '',
      });
    });

    afterEach(async () => {
      upstream.closeAllConnections?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    it('POST delay-group accepts, fans out, and rejects a duplicate on the same group', async () => {
      const first = await authed('POST', `/api/management/${backendId}/delay-group/A-Group`);
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ accepted: true, group: 'A-Group', total: 2 });

      const second = await authed('POST', `/api/management/${backendId}/delay-group/A-Group`);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ code: 'DELAY_TEST_RUNNING' });
    });

    // M1 follow-ups item 3: pre-fix, a negative timeout reached
    // AbortSignal.timeout(-5) synchronously — a RangeError the generic catch
    // in upstreamFetch/mapUpstreamError could only classify as a 500. Both
    // cases must now resolve normally against the live fake upstream: the
    // clamp (not merely "no 500") is what's under test, so asserting the
    // actual 200 + { delay: 42 } body is the only way this would fail
    // pre-fix and pass post-fix.
    it('GET delay with a negative timeout is clamped to the service default instead of erroring', async () => {
      const res = await authed('GET', `/api/management/${backendId}/delay/N1?timeout=-5`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ delay: 42 });
    });

    it('GET delay with an absurdly large timeout is clamped to the max instead of erroring', async () => {
      const res = await authed('GET', `/api/management/${backendId}/delay/N1?timeout=600000`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ delay: 42 });
    });

    // M1.5: providers management page.
    it('GET providers returns ruleProviders/proxyProviders with vehicleType Compatible filtered out', async () => {
      const res = await authed('GET', `/api/management/${backendId}/providers`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ruleProviders: [
          { name: 'MyRules', behavior: 'classical', ruleCount: 33, updatedAt: '2026-08-20T10:00:00Z', vehicleType: 'HTTP' },
        ],
        proxyProviders: [
          { name: 'MyProxies', proxyCount: 2, updatedAt: '2026-08-20T09:00:00Z', vehicleType: 'HTTP' },
        ],
      });
    });

    it('POST providers/rule/:name/refresh succeeds against a known provider', async () => {
      const res = await authed('POST', `/api/management/${backendId}/providers/rule/MyRules/refresh`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('POST providers/proxy/:name/refresh succeeds against a known provider', async () => {
      const res = await authed('POST', `/api/management/${backendId}/providers/proxy/MyProxies/refresh`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('POST providers refresh with an unknown kind is rejected with 400', async () => {
      const res = await authed('POST', `/api/management/${backendId}/providers/bogus/MyRules/refresh`);
      expect(res.statusCode).toBe(400);
    });

    it('POST providers refresh for a name the upstream 404s on maps to 502 { reachable: true, upstreamStatus: 404 }', async () => {
      const res = await authed('POST', `/api/management/${backendId}/providers/rule/missing-provider/refresh`);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ backendId, reachable: true, upstreamStatus: 404 });
    });
  });

  describe('against an unreachable upstream (connection refused)', () => {
    let backendId: number;

    beforeEach(async () => {
      // Bind then immediately close: yields a port nothing is listening on,
      // so a request against it deterministically fails at the network
      // layer (ECONNREFUSED) rather than merely timing out.
      const probe = http.createServer();
      const port = await new Promise<number>((resolve) => {
        probe.listen(0, '127.0.0.1', () => {
          const p = (probe.address() as AddressInfo).port;
          probe.close(() => resolve(p));
        });
      });
      backendId = db.createBackend({
        name: 'mgmt-unreachable-test',
        url: `ws://127.0.0.1:${port}/connections`,
        token: '',
        apiUrl: `http://127.0.0.1:${port}`,
        apiSecret: '',
      });
    });

    it('GET groups maps a refused connection to 502 { error, backendId, reachable: false }', async () => {
      const res = await authed('GET', `/api/management/${backendId}/groups`);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ backendId, reachable: false });
      expect(typeof res.json().error).toBe('string');
    });
  });

  describe('against a hanging upstream', () => {
    let upstream: http.Server;
    let backendId: number;

    beforeEach(async () => {
      upstream = createFakeMihomo({ hang: true });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
      const port = (upstream.address() as AddressInfo).port;
      backendId = db.createBackend({
        name: 'mgmt-hang-test',
        url: `ws://127.0.0.1:${port}/connections`,
        token: '',
        apiUrl: `http://127.0.0.1:${port}`,
        apiSecret: '',
      });
    });

    afterEach(async () => {
      upstream.closeAllConnections?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    // fetchGroups's upstreamFetch call uses the 5000ms default timeout (GET
    // /proxies takes no timeout override from the client) — this test's
    // runtime is dominated by that wait, not arrangement complexity, so the
    // real end-to-end path is covered directly rather than unit-calling the
    // controller's private mapUpstreamError with a synthetic { timeout: true }.
    it('GET groups maps an upstream timeout to 504 { error, backendId, reachable: false }', async () => {
      const res = await authed('GET', `/api/management/${backendId}/groups`);
      expect(res.statusCode).toBe(504);
      expect(res.json()).toMatchObject({ backendId, reachable: false });
      expect(typeof res.json().error).toBe('string');
    }, 10000);
  });

  describe('against an upstream that rejects the api_secret (401)', () => {
    let upstream: http.Server;
    let backendId: number;

    beforeEach(async () => {
      upstream = createFakeMihomo({ hang: false, unauthorized: true });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
      const port = (upstream.address() as AddressInfo).port;
      backendId = db.createBackend({
        name: 'mgmt-unauthorized-test',
        url: `ws://127.0.0.1:${port}/connections`,
        token: '',
        apiUrl: `http://127.0.0.1:${port}`,
        apiSecret: 'wrong-secret',
      });
    });

    afterEach(async () => {
      upstream.closeAllConnections?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    // Finding 2 of the M1 final-review fix wave: a wrong api_secret must
    // surface as a reachable-but-rejected error, not the generic "backend
    // unreachable" 502 shape — the web side branches on `code` to show a
    // credentials-specific message instead of the offline banner.
    it('GET groups maps an upstream 401 to 502 { code: UPSTREAM_UNAUTHORIZED, reachable: true, upstreamStatus: 401 }', async () => {
      const res = await authed('GET', `/api/management/${backendId}/groups`);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'UPSTREAM_UNAUTHORIZED',
        backendId,
        reachable: true,
        upstreamStatus: 401,
      });
      expect(typeof res.json().error).toBe('string');
    });
  });
});
