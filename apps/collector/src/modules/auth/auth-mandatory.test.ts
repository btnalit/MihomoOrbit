import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app/app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';
import type { AuthService } from './auth.service.js';

// M0 plan Task 7: authentication becomes mandatory. Before first-run setup
// completes, every route except a small public/setup allowlist must 401 with
// AUTH_SETUP_REQUIRED — closing both bypass branches (app.ts hook early-exit
// and auth.service.ts verifyToken's old `{ valid: true }` on unconfigured).

/**
 * Drives POST /api/auth/enable using the in-memory one-time setup token, the
 * same way a first-run client would. Fails loudly if setup doesn't succeed
 * so a broken setup path shows up as a clear test failure rather than a
 * confusing downstream 401.
 */
async function enableAuthForTest(app: FastifyInstance, token: string): Promise<void> {
  const setupToken = app.authService.getSetupToken();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/enable',
    headers: setupToken ? { 'x-setup-token': setupToken } : undefined,
    payload: { token },
  });
  if (res.statusCode !== 200) {
    throw new Error(`enableAuthForTest failed: ${res.statusCode} ${res.body}`);
  }
}

describe('mandatory auth', () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let app: FastifyInstance;
  let authService: AuthService;

  beforeEach(async () => {
    ({ db, cleanup } = createTestDatabase());
    app = await createApp({
      port: 0,
      db,
      realtimeStore,
      logger: false,
      autoListen: false,
    });
    authService = app.authService;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    cleanup();
  });

  it('blocks API when auth not configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/backends' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AUTH_SETUP_REQUIRED');
  });

  it('exposes configured=false before setup', async () => {
    const state = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(state.statusCode).toBe(200);
    expect(state.json().configured).toBe(false);
  });

  it('verifyToken must NOT accept arbitrary tokens before setup', async () => {
    // Covers the second bypass branch: auth.service.ts verifyToken() used to
    // return { valid: true } whenever auth wasn't enabled/configured.
    await expect(authService.verifyToken('anything')).resolves.toMatchObject({ valid: false });
  });

  it('requires token after setup', async () => {
    await enableAuthForTest(app, 'a-16-char-token-1');
    const res = await app.inject({ method: 'GET', url: '/api/backends' });
    expect(res.statusCode).toBe(401);
  });

  it('agent ingest is not intercepted by the mandatory-auth hook', async () => {
    // /api/agent/* authenticates independently via parseAgentToken +
    // backend.agent_token (design spec section 3.5e). Assert it was not stopped by
    // the mandatory-auth hook rather than asserting a specific status code —
    // against this empty payload/DB the route itself will 400/404, but it
    // must never be AUTH_SETUP_REQUIRED.
    const res = await app.inject({ method: 'POST', url: '/api/agent/heartbeat', payload: {} });
    expect(res.json().code).not.toBe('AUTH_SETUP_REQUIRED');
  });

  it('disable route is gone', async () => {
    // Exercised under FORCE_ACCESS_CONTROL_OFF so the assertion is purely
    // about routing (no route registered at this path) rather than being
    // entangled with the mandatory-auth hook, which would otherwise 401
    // this unconfigured-state request before Fastify even gets to decide
    // whether the route exists.
    const original = process.env.FORCE_ACCESS_CONTROL_OFF;
    process.env.FORCE_ACCESS_CONTROL_OFF = 'true';
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/disable' });
      expect(res.statusCode).toBe(404);
    } finally {
      if (original === undefined) delete process.env.FORCE_ACCESS_CONTROL_OFF;
      else process.env.FORCE_ACCESS_CONTROL_OFF = original;
    }
  });

  it('publicRoutes matching is exact, not prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/state-not-a-real-route' });
    expect(res.statusCode).not.toBe(200);
  });
});
