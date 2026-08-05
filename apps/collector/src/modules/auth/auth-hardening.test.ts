import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app/app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';
import type { AuthService } from './auth.service.js';

// M0 plan Task 8: first-run setup token (closes the /api/auth/enable TOFU
// window) and credential hardening (16-char minimum, salted scrypt instead
// of bare SHA-256, legacy-hash-as-unconfigured, per-IP rate limiting on
// /verify and /enable).

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

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

describe('auth hardening', () => {
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

  it('rejects /enable without setup token before configuration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/enable',
      payload: { token: 'a-16-char-token-1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts /enable with the printed setup token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/enable',
      headers: { 'x-setup-token': authService.getSetupToken()! },
      payload: { token: 'a-16-char-token-1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects tokens shorter than 16 chars', () => {
    expect(authService.isValidTokenFormat('abc123')).toBe(false);
    expect(authService.isValidTokenFormat('a-16-char-token-1')).toBe(true);
  });

  it('stores salted scrypt hash, not bare sha256', async () => {
    await authService.enableAuth('a-16-char-token-1');
    expect(db.getAuthConfig().tokenHash).toMatch(/^scrypt\$/);
  });

  // A stats.db copied over from an older neko instance may carry a legacy
  // unsalted-SHA-256 hash (frequently backing a token as short as 6 chars).
  // It must NOT be transparently upgraded on next successful verify — that
  // would let the pre-existing weak token remain valid forever and defeat
  // the new 16-char floor for exactly the installs that most need it.
  it('treats a legacy sha256 hash as NOT configured, forcing re-setup', async () => {
    db.updateAuthConfig({ enabled: true, tokenHash: sha256Hex('short1') }); // 6-char legacy token
    expect(authService.isConfigured()).toBe(false);
    await expect(authService.verifyToken('short1')).resolves.toMatchObject({ valid: false });
    const state = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(state.json().configured).toBe(false);
  });

  // The rate limiter must actually run for /api/auth/verify: that route sits
  // on the mandatory-auth hook's PUBLIC_ROUTES allowlist (it has to, so
  // unauthenticated clients can log in), so a limiter placed inside that
  // hook would never execute for it. It has to live in the controller.
  it('locks out an IP after 5 failed verifies on the public /api/auth/verify route', async () => {
    await enableAuthForTest(app, 'a-16-char-token-1');
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: 'wrong-token-000' } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: 'wrong-token-000' } });
    expect(res.statusCode).toBe(429);
  });

  it('memoizes successful verification so scrypt does not run per request', async () => {
    await authService.enableAuth('a-16-char-token-1');

    const t0 = Date.now();
    await authService.verifyToken('a-16-char-token-1');   // 冷:跑 scrypt(~75ms)
    const cold = Date.now() - t0;

    const t1 = Date.now();
    for (let i = 0; i < 20; i++) {
      await authService.verifyToken('a-16-char-token-1'); // 热:走缓存
    }
    const warmAvg = (Date.now() - t1) / 20;

    // 全局认证钩子每个请求都会调用 verifyToken,scryptSync 是同步阻塞的;
    // 若缓存失效,20 次热调用会各付一次 ~75ms,总耗时远超冷调用。
    expect(warmAvg).toBeLessThan(Math.max(cold / 4, 5));
  });

  it('invalidates the verification cache when the token changes', async () => {
    await authService.enableAuth('a-16-char-token-1');
    await expect(authService.verifyToken('a-16-char-token-1')).resolves.toMatchObject({ valid: true });

    await authService.updateToken('b-16-char-token-2');

    // 旧令牌必须立刻失效,不能因缓存 TTL 继续放行
    await expect(authService.verifyToken('a-16-char-token-1')).resolves.toMatchObject({ valid: false });
    await expect(authService.verifyToken('b-16-char-token-2')).resolves.toMatchObject({ valid: true });
  });


  it('does not burn the setup token when the chosen token is rejected', async () => {
    const setupToken = authService.getSetupToken()!;

    // 首次设置时输入了不合规的令牌:应返回 400,但 setup token 必须仍然有效,
    // 否则用户要重启 collector 才能再拿到一个(端到端验收发现的缺陷)。
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/auth/enable',
      headers: { 'x-setup-token': setupToken },
      payload: { token: 'short1' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(authService.getSetupToken()).toBe(setupToken);

    // 同一个 setup token 必须还能完成设置
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/auth/enable',
      headers: { 'x-setup-token': setupToken },
      payload: { token: 'orbit-admin-token-2026' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(authService.isConfigured()).toBe(true);
    // 设置成功后才失效
    expect(authService.getSetupToken()).toBeNull();
  });


  it('invalidates an existing session cookie after the token is changed', async () => {
    const setupToken = authService.getSetupToken()!;
    await app.inject({
      method: 'POST', url: '/api/auth/enable',
      headers: { 'x-setup-token': setupToken },
      payload: { token: 'orbit-admin-token-2026' },
    });

    const login = await app.inject({
      method: 'POST', url: '/api/auth/verify',
      payload: { token: 'orbit-admin-token-2026' },
    });
    const cookie = login.cookies.find((c: { name: string }) => c.name === 'orbit-session');
    expect(cookie).toBeDefined();

    // cookie 携带的是明文访问令牌;换令牌后它必须立刻失效,
    // 而不是靠验证缓存的 TTL continue 放行。
    await authService.updateToken('orbit-admin-token-2099');

    const stale = await app.inject({
      method: 'GET', url: '/api/backends',
      cookies: { 'orbit-session': cookie!.value },
    });
    expect(stale.statusCode).toBe(401);
  });

  // C1: the pre-auth per-IP limiter guards every protected route (not just
  // /verify and /enable), and is registered BEFORE the mandatory-auth hook so
  // a locked-out IP never reaches authService.verifyToken() — meaning scrypt
  // must not run for it either. Threshold is 20 failures/15min, looser than
  // the 5/15min login limiter (auth.controller.ts) that governs /verify.
  it('locks out an IP with 429 on a protected route after repeated bad Bearer tokens, without repeatedly paying scrypt', async () => {
    await enableAuthForTest(app, 'a-16-char-token-1');
    const scryptSpy = vi.spyOn(crypto, 'scrypt');

    const attempts = 25; // > the 20-failure pre-auth threshold
    let lastStatus = 0;
    for (let i = 0; i < attempts; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/backends',
        headers: { authorization: 'Bearer wrong-token-000000' },
      });
      lastStatus = res.statusCode;
    }

    expect(lastStatus).toBe(429);
    // The first bad attempt pays the real scrypt cost; every repeat of the
    // exact same wrong token is served from the short-TTL negative cache
    // (and, once locked out, short-circuited by the pre-auth limiter before
    // verifyToken() is even called) — so scrypt must not run again for it.
    expect(scryptSpy).toHaveBeenCalledTimes(1);

    scryptSpy.mockRestore();
  });

  // C1: the negative-result cache means a repeated identical bad token never
  // re-pays the scrypt cost, independent of the per-IP limiter above.
  it('does not invoke scrypt for a repeated identical bad token (negative cache)', async () => {
    await authService.enableAuth('a-16-char-token-1');
    const scryptSpy = vi.spyOn(crypto, 'scrypt');

    await expect(authService.verifyToken('wrong-token-000000')).resolves.toMatchObject({ valid: false });
    expect(scryptSpy).toHaveBeenCalledTimes(1);

    await expect(authService.verifyToken('wrong-token-000000')).resolves.toMatchObject({ valid: false });
    expect(scryptSpy).toHaveBeenCalledTimes(1);

    scryptSpy.mockRestore();
  });

  // C1 (false-lockout guard): the pre-auth limiter is meant to be looser than
  // the login limiter specifically so a stale session never traps a real
  // user — logging back in with the current token must lift a pre-auth
  // lockout immediately, not just wait out the 15-minute window.
  it('recovers from a pre-auth 429 lockout immediately after a successful /api/auth/verify login', async () => {
    await enableAuthForTest(app, 'a-16-char-token-1');

    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/backends',
        headers: { authorization: 'Bearer wrong-token-000000' },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { token: 'a-16-char-token-1' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c: { name: string }) => c.name === 'orbit-session');
    expect(cookie).toBeDefined();

    const afterLogin = await app.inject({
      method: 'GET',
      url: '/api/backends',
      cookies: { 'orbit-session': cookie!.value },
    });
    expect(afterLogin.statusCode).toBe(200);
  });

  // I1: request.ip must honor X-Forwarded-For only from the trusted loopback
  // proxy (the bundled Next.js server rewrite runs on the same host), and
  // ignore it entirely from any other peer — otherwise a direct LAN client
  // could spoof a fresh X-Forwarded-For on every request to dodge the
  // per-IP limiters above indefinitely. Exercised indirectly through the
  // pre-auth limiter, since it is the observable effect of request.ip.
  it('honors X-Forwarded-For only from the trusted loopback proxy, not from a direct peer', async () => {
    await enableAuthForTest(app, 'a-16-char-token-1');

    // Loopback peer (trusted): each request claims a different real client
    // IP via X-Forwarded-For. If honored, no single apparent IP accumulates
    // past the threshold, so every request just 401s.
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/backends',
        remoteAddress: '127.0.0.1',
        headers: {
          authorization: 'Bearer wrong-token-000000',
          'x-forwarded-for': `203.0.113.${i}`,
        },
      });
      expect(res.statusCode).toBe(401);
    }

    // Direct, non-loopback peer (untrusted): X-Forwarded-For must be
    // ignored, so a forged, ever-changing value cannot dodge the limiter —
    // every request is attributed to the one real peer address and must
    // still lock out past the threshold.
    let lastStatus = 0;
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/backends',
        remoteAddress: '10.20.2.66',
        headers: {
          authorization: 'Bearer wrong-token-000000',
          'x-forwarded-for': `198.51.100.${i}`,
        },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });

});
