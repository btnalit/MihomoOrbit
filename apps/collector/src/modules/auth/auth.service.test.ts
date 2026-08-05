import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, createTestBackend } from '../../__tests__/helpers.js';
import { AuthService } from './auth.service.js';
import type { StatsDatabase } from '../db/db.js';

describe('AuthService', () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let authService: AuthService;

  beforeEach(() => {
    ({ db, cleanup } = createTestDatabase());
    createTestBackend(db);
    authService = new AuthService(db);
  });

  afterEach(() => {
    cleanup();
  });

  describe('getAuthState', () => {
    it('should return disabled state by default', () => {
      const state = authService.getAuthState();
      expect(state.enabled).toBe(false);
      expect(state.hasToken).toBe(false);
    });
  });

  describe('enableAuth / verifyToken', () => {
    it('should enable auth and verify correct token', async () => {
      // Bumped to 17 chars (was 'test123abc', 10 chars) for the M0 Task 8
      // 16-char minimum.
      await authService.enableAuth('test123abc-longer');

      expect(authService.isAuthRequired()).toBe(true);

      const result = await authService.verifyToken('test123abc-longer');
      expect(result.valid).toBe(true);
    });

    it('should reject incorrect token', async () => {
      await authService.enableAuth('correct1-long-token');

      const result = await authService.verifyToken('wrong-token-1-long');
      expect(result.valid).toBe(false);
    });
  });

  describe('disableAuth', () => {
    // Under mandatory auth (M0 Task 7), disabling auth is no longer "allow
    // all requests" — it puts the service back into the "not yet configured"
    // state, where verifyToken rejects everything until setup runs again.
    // This replaces the old assertion that verifyToken('anything') succeeds
    // once disabled.
    it('should disable auth and require setup again, not allow all requests', async () => {
      await authService.enableAuth('myToken1-long-token');
      expect(authService.isAuthRequired()).toBe(true);

      authService.disableAuth();
      expect(authService.isAuthRequired()).toBe(false);
      expect(authService.isConfigured()).toBe(false);

      const result = await authService.verifyToken('anything');
      expect(result.valid).toBe(false);
    });
  });

  describe('isValidTokenFormat', () => {
    it('should reject tokens shorter than 16 characters', () => {
      expect(authService.isValidTokenFormat('ab1')).toBe(false);
      // 6 chars: passed the old >=6 floor but must fail the new 16-char floor.
      expect(authService.isValidTokenFormat('abc123')).toBe(false);
    });

    it('should reject purely numeric tokens', () => {
      expect(authService.isValidTokenFormat('12345678901234567')).toBe(false);
    });

    it('should reject purely alphabetic tokens', () => {
      expect(authService.isValidTokenFormat('abcdefghijklmnopqr')).toBe(false);
    });

    it('should accept valid mixed tokens of at least 16 characters', () => {
      expect(authService.isValidTokenFormat('abc123-long-token')).toBe(true);
      expect(authService.isValidTokenFormat('MyP4ssw0rd-longer')).toBe(true);
    });
  });

  describe('updateToken', () => {
    it('should update token and verify new one', async () => {
      await authService.enableAuth('oldToken1-long-tok');
      await authService.updateToken('newToken2-long-tok');

      const oldResult = await authService.verifyToken('oldToken1-long-tok');
      expect(oldResult.valid).toBe(false);

      const newResult = await authService.verifyToken('newToken2-long-tok');
      expect(newResult.valid).toBe(true);
    });
  });
});

describe('ORBIT_SETUP_TOKEN validation', () => {
  const originalEnvToken = process.env.ORBIT_SETUP_TOKEN;

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env.ORBIT_SETUP_TOKEN;
    } else {
      process.env.ORBIT_SETUP_TOKEN = originalEnvToken;
    }
  });

  it('warns and falls back to a random token when ORBIT_SETUP_TOKEN is shorter than 16 chars', () => {
    process.env.ORBIT_SETUP_TOKEN = 'short-token';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, cleanup } = createTestDatabase();

    try {
      const service = new AuthService(db);
      expect(service.getSetupToken()).not.toBe('short-token');
      expect(service.getSetupToken()!.length).toBeGreaterThanOrEqual(16);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ORBIT_SETUP_TOKEN'));
    } finally {
      warnSpy.mockRestore();
      cleanup();
    }
  });

  it('honors ORBIT_SETUP_TOKEN once it meets the 16-char minimum', () => {
    process.env.ORBIT_SETUP_TOKEN = 'a-16-char-token-1';
    const { db, cleanup } = createTestDatabase();

    try {
      const service = new AuthService(db);
      expect(service.getSetupToken()).toBe('a-16-char-token-1');
    } finally {
      cleanup();
    }
  });
});
