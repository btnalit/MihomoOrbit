/**
 * Auth Service
 *
 * Handles authentication configuration and token verification.
 *
 * Tokens are stored as a per-token salted scrypt derivation
 * (`scrypt$<salt-hex>$<derived-key-hex>`). A hash that instead looks like a
 * bare 64-hex-char SHA-256 digest is a "legacy" hash carried over from an
 * older install; it is treated as if auth were never configured rather than
 * transparently upgraded on next successful verify. Transparent upgrade
 * would let a pre-existing (likely short) legacy token remain valid forever
 * and defeat the 16-character floor for exactly the installs that most need
 * it. See M0 plan Task 8 / design spec section 3.5.
 */

import crypto from 'crypto';
import type { StatsDatabase } from '../db/db.js';
import type { AuthConfig, AuthVerifyResult, AuthState } from './auth.types.js';

const MIN_TOKEN_LENGTH = 16;
const SCRYPT_KEY_LENGTH = 32;
const LEGACY_SHA256_HEX = /^[0-9a-f]{64}$/i;
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Derives a salted scrypt hash for token storage: `scrypt$<salt>$<derivedKey>`. */
function hashTokenScrypt(token: string, salt: string = crypto.randomBytes(16).toString('hex')): string {
  const derivedKey = crypto.scryptSync(token, salt, SCRYPT_KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

/** Recomputes the scrypt hash for `token` using the salt embedded in `stored` and compares. */
function verifyScryptHash(token: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedDerivedKey] = parts;
  const candidate = crypto.scryptSync(token, salt, SCRYPT_KEY_LENGTH).toString('hex');
  return timingSafeStringEqual(candidate, expectedDerivedKey);
}

/** A legacy unsalted-SHA-256 hash (pre-M0 installs) is recognized by shape and treated as unset. */
function isLegacyHash(hash: string | null): boolean {
  return !!hash && LEGACY_SHA256_HEX.test(hash);
}

export class AuthService {
  private db: StatsDatabase;

  /**
   * One-time setup token for the first-run `/api/auth/enable` call, held
   * only in memory. Generated on construction while auth is not yet
   * configured (or read from ORBIT_SETUP_TOKEN), regenerated every restart,
   * and invalidated the moment setup succeeds. See design spec section 3.5(b).
   */
  private setupToken: string | null;

  /**
   * Memoizes *successful* verifications, keyed by a cheap SHA-256 of the token.
   *
   * The global auth hook calls verifyToken() on every authenticated request, and
   * scryptSync costs ~75ms of blocking CPU — without this, a polling dashboard
   * would stall the event loop continuously. Only successes are cached, so a
   * wrong token always pays the full scrypt cost; that, plus the per-IP lockout
   * in auth.controller.ts, is what keeps online brute force expensive. At most
   * one token is ever valid, so the map stays tiny.
   */
  private verifiedTokens = new Map<string, number>();

  constructor(db: StatsDatabase) {
    this.db = db;
    this.setupToken = this.isConfigured()
      ? null
      : process.env.ORBIT_SETUP_TOKEN || crypto.randomBytes(32).toString('hex');
  }

  /**
   * Get current auth configuration
   */
  getAuthConfig(): AuthConfig {
    const config = this.db.getAuthConfig();
    return config;
  }

  /**
   * Check if access control is forced off via environment variable
   */
  isForceAccessControlOff(): boolean {
    return process.env.FORCE_ACCESS_CONTROL_OFF === 'true';
  }

  /**
   * Get auth state (for public API - doesn't expose hash)
   */
  getAuthState(): AuthState {
    const config = this.db.getAuthConfig();
    const forcedOff = this.isForceAccessControlOff();

    return {
      enabled: forcedOff ? false : config.enabled,
      hasToken: !!config.tokenHash,
      forceAccessControlOff: forcedOff,
      showcaseMode: this.isShowcaseMode(),
    };
  }

  /**
   * Check if showcase mode is enabled via environment variable
   */
  isShowcaseMode(): boolean {
    return process.env.SHOWCASE_SITE_MODE === 'true';
  }

  /**
   * Whether initial setup has completed: enabled, has a token hash, and that
   * hash is not a legacy unsalted-SHA-256 value. A legacy hash reads as
   * "not configured" so the first-run setup flow (and its setup-token gate)
   * triggers again, forcing a re-set onto a compliant scrypt token instead
   * of silently accepting whatever weak token was carried over.
   */
  isConfigured(): boolean {
    const config = this.db.getAuthConfig();
    return config.enabled && !!config.tokenHash && !isLegacyHash(config.tokenHash);
  }

  /**
   * 存储的哈希是否为 M0 之前的未加盐 sha256。isConfigured() 已把它当作未配置,
   * 但 FORCE_ACCESS_CONTROL_OFF 会绕过整个设置流程,导致弱令牌被无限期沿用
   * 且毫无提示——启动告警据此点名(见 index.ts)。
   */
  hasLegacyTokenHash(): boolean {
    return isLegacyHash(this.db.getAuthConfig().tokenHash);
  }

  /** Returns the current one-time setup token, or null once configured/consumed. */
  getSetupToken(): string | null {
    return this.setupToken;
  }

  /**
   * Timing-safe comparison against the current setup token. Deliberately
   * side-effect free: the token is invalidated by enableAuth() once setup
   * actually succeeds, not merely because it was presented. Consuming it here
   * would mean a single rejected token (e.g. too short) burns the one-time
   * setup token and forces a collector restart to get a new one.
   */
  verifySetupToken(token: string): boolean {
    if (!this.setupToken || !token) {
      return false;
    }
    return timingSafeStringEqual(token, this.setupToken);
  }

  /**
   * Verified token if valid
   */
  async verifyToken(token: string): Promise<AuthVerifyResult> {
    if (this.isForceAccessControlOff()) {
      return { valid: true };
    }

    if (!this.isConfigured()) {
      return { valid: false, message: 'Authentication setup required' };
    }

    const cacheKey = crypto.createHash('sha256').update(token).digest('hex');
    const cachedUntil = this.verifiedTokens.get(cacheKey);
    if (cachedUntil !== undefined) {
      if (cachedUntil > Date.now()) {
        return { valid: true };
      }
      this.verifiedTokens.delete(cacheKey);
    }

    const config = this.db.getAuthConfig();
    // isConfigured() already guarantees tokenHash is a non-null, non-legacy
    // (i.e. scrypt-formatted) value, but the check is defensive.
    if (config.tokenHash && verifyScryptHash(token, config.tokenHash)) {
      this.verifiedTokens.set(cacheKey, Date.now() + VERIFY_CACHE_TTL_MS);
      return { valid: true };
    }

    return { valid: false, message: 'Invalid token' };
  }

  /**
   * Enable authentication with a new token
   */
  async enableAuth(token: string): Promise<void> {
    if (!this.isValidTokenFormat(token)) {
      throw new Error(
        `Invalid token format. Token must be at least ${MIN_TOKEN_LENGTH} characters and contain both letters and numbers.`,
      );
    }

    this.db.updateAuthConfig({
      enabled: true,
      tokenHash: hashTokenScrypt(token),
    });
    this.verifiedTokens.clear();
    this.setupToken = null;
  }

  /**
   * Disable authentication
   */
  disableAuth(): void {
    this.verifiedTokens.clear();
    this.db.updateAuthConfig({
      enabled: false,
      tokenHash: null,
    });
  }

  /**
   * Update token (when auth is already enabled)
   */
  async updateToken(token: string): Promise<void> {
    if (!this.isValidTokenFormat(token)) {
      throw new Error(
        `Invalid token format. Token must be at least ${MIN_TOKEN_LENGTH} characters and contain both letters and numbers.`,
      );
    }

    this.db.updateAuthConfig({
      tokenHash: hashTokenScrypt(token),
    });
    this.verifiedTokens.clear();
  }

  /**
   * Validate token format
   * - At least 16 characters
   * - Contains at least one letter
   * - Contains at least one number
   * - Not purely numbers or purely letters
   */
  isValidTokenFormat(token: string): boolean {
    if (!token || token.length < MIN_TOKEN_LENGTH) {
      return false;
    }

    // Check for at least one letter
    const hasLetter = /[a-zA-Z]/.test(token);
    // Check for at least one number
    const hasNumber = /[0-9]/.test(token);

    return hasLetter && hasNumber;
  }

  /**
   * Check if authentication is required
   */
  isAuthRequired(): boolean {
    if (this.isForceAccessControlOff()) {
      return false;
    }
    return this.isConfigured();
  }
}
