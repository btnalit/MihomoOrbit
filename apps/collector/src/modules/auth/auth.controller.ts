/**
 * Auth Controller
 *
 * Fastify routes for authentication management.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthService } from './auth.service.js';
import { IpFailureLimiter } from './ip-failure-limiter.js';

// Extend Fastify instance
declare module 'fastify' {
  interface FastifyInstance {
    authService: AuthService;
  }
}

// Per-IP failure tracking for /verify and /enable: 5 failures locks the IP
// out for 15 minutes. This CANNOT live in the global auth hook (app.ts) —
// both routes sit on that hook's pre-auth allowlist so it can serve the
// unauthenticated login/first-run flows, and a limiter placed inside the
// hook would `return` before ever running for them. See M0 plan Task 8 /
// design spec section 3.5(c). (A second, looser limiter guards every other
// protected route and the WS handshake — see AuthService's pre-auth limiter.)
const FAILURE_LIMIT = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const RATE_LIMITED_RESPONSE = { error: 'Too many failed attempts. Try again later.' };

export async function authController(app: FastifyInstance) {
  const authService = app.authService;

  // Limiter state is created per plugin registration, not module-level: a
  // module-level instance would let multiple createApp() instances in the
  // same process (and neighboring test cases) share lockout counts.
  const limiter = new IpFailureLimiter({ failureLimit: FAILURE_LIMIT, lockoutMs: LOCKOUT_MS });
  const isLockedOut = (ip: string) => limiter.isLockedOut(ip);
  const recordFailure = (ip: string) => limiter.recordFailure(ip);
  const recordSuccess = (ip: string) => limiter.recordSuccess(ip);

  /**
   * GET /api/auth/state
   * Get current auth state (public - no token required)
   */
  app.get('/state', async () => {
    return {
      ...authService.getAuthState(),
      configured: authService.isConfigured(),
    };
  });

  /**
   * POST /api/auth/verify
   * Verify a token (public - used for login)
   */
  app.post('/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isLockedOut(request.ip)) {
      return reply.status(429).send({ valid: false, ...RATE_LIMITED_RESPONSE });
    }

    const body = request.body as { token?: string };
    const token = body?.token;

    if (!token) {
      return reply.status(400).send({
        valid: false,
        message: 'Token is required'
      });
    }

    const result = await authService.verifyToken(token);

    if (result.valid) {
      recordSuccess(request.ip);
      // Also clears the separate, looser pre-auth per-IP limiter that guards
      // every other protected route (see AuthService.recordPreAuthSuccess).
      // Without this, a dashboard whose session cookie went stale after a
      // token rotation racks up a pre-auth failure on every protected
      // request it fires, can get 429-locked out for the full 15 minutes —
      // and logging back in here would otherwise NOT clear that lockout,
      // since only this route's own 5/15 limiter was reset. Proving a fresh
      // token here is exactly the signal that should lift the other
      // limiter too. Brute force against /verify itself is unaffected: it
      // still costs 5 failures under this route's own stricter limiter.
      authService.recordPreAuthSuccess(request.ip);
      // Set valid token as HttpOnly cookie
      // Only use secure if the connection is actually HTTPS
      const isSecure = request.protocol === 'https';
      reply.setCookie('orbit-session', token, {
        path: '/',
        httpOnly: true,
        secure: isSecure, // Only use secure on HTTPS connections
        sameSite: 'strict',
        maxAge: 60 * 60 * 24 * 7, // 7 days
      });
    } else {
      recordFailure(request.ip);
    }

    return result;
  });

  /**
   * POST /api/auth/logout
   * Clear session cookie
   */
  app.post('/logout', async (request, reply) => {
    reply.clearCookie('orbit-session', { path: '/' });
    return { success: true };
  });

  /**
   * POST /api/auth/enable
   * First-run: requires the one-time X-Setup-Token header (see AuthService).
   * Already configured: gated by the global auth hook like any other route
   * (valid session cookie/Bearer token), so no extra check is needed here.
   */
  app.post('/enable', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isLockedOut(request.ip)) {
      return reply.status(429).send(RATE_LIMITED_RESPONSE);
    }

    if (authService.isShowcaseMode()) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    if (!authService.isConfigured()) {
      const setupToken = request.headers['x-setup-token'];
      if (typeof setupToken !== 'string' || !authService.verifySetupToken(setupToken)) {
        recordFailure(request.ip);
        return reply.status(401).send({
          error: 'A valid X-Setup-Token header is required to complete first-run setup',
        });
      }
    }

    const body = request.body as { token?: string };
    const token = body?.token;

    if (!token) {
      return reply.status(400).send({
        error: 'Token is required'
      });
    }

    try {
      await authService.enableAuth(token);
      recordSuccess(request.ip);
      return {
        success: true,
        message: 'Authentication enabled successfully'
      };
    } catch (error: unknown) {
      // 令牌格式不合规不是凭据猜测,不计入每 IP 锁定计数——否则管理员
      // 连试几次弱令牌就会把自己锁在首次设置流程之外。
      const message = error instanceof Error ? error.message : 'Failed to enable authentication';
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * PUT /api/auth/token
   * Update token (requires valid existing token)
   */
  app.put('/token', async (request, reply) => {
    if (authService.isShowcaseMode()) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const body = request.body as { currentToken?: string; newToken?: string };
    const { currentToken, newToken } = body;

    // Verify current token if auth is enabled
    // Skip verification if forced off
    if (authService.isAuthRequired() && !authService.isForceAccessControlOff()) {
      // Check cookie first
      let valid = false;
      const cookieToken = request.cookies?.['orbit-session'];

      if (cookieToken) {
        const verifyResult = await authService.verifyToken(cookieToken);
        if (verifyResult.valid) {
          valid = true;
        }
      }

      if (!valid) {
        if (!currentToken) {
          return reply.status(401).send({
            error: 'Current token is required'
          });
        }

        const verifyResult = await authService.verifyToken(currentToken);
        if (!verifyResult.valid) {
          return reply.status(401).send({
            error: verifyResult.message || 'Invalid current token'
          });
        }
      }
    }

    if (!newToken) {
      return reply.status(400).send({
        error: 'New token is required'
      });
    }

    try {
      await authService.updateToken(newToken);
      return {
        success: true,
        message: 'Token updated successfully'
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to update token';
      return reply.status(400).send({ error: message });
    }
  });
}
