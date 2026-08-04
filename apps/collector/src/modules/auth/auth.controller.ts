/**
 * Auth Controller
 *
 * Fastify routes for authentication management.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthService } from './auth.service.js';

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
// design spec section 3.5(c).
const FAILURE_LIMIT = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failuresByIp = new Map<string, { count: number; lockedUntil: number }>();

function isLockedOut(ip: string): boolean {
  const entry = failuresByIp.get(ip);
  if (!entry) return false;
  // Not locked yet (still under the failure threshold) — leave the counter
  // alone so it keeps accumulating across requests.
  if (entry.lockedUntil === 0) return false;
  if (entry.lockedUntil > Date.now()) return true;
  // Lockout window has elapsed; drop the stale entry so failures start fresh.
  failuresByIp.delete(ip);
  return false;
}

function recordFailure(ip: string): void {
  const entry = failuresByIp.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= FAILURE_LIMIT) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
  }
  failuresByIp.set(ip, entry);
}

function recordSuccess(ip: string): void {
  failuresByIp.delete(ip);
}

const RATE_LIMITED_RESPONSE = { error: 'Too many failed attempts. Try again later.' };

export async function authController(app: FastifyInstance) {
  const authService = app.authService;

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
      if (typeof setupToken !== 'string' || !authService.consumeSetupToken(setupToken)) {
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
      recordFailure(request.ip);
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
