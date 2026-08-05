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
import { IpFailureLimiter } from './ip-failure-limiter.js';

const MIN_TOKEN_LENGTH = 16;
const SCRYPT_KEY_LENGTH = 32;
const LEGACY_SHA256_HEX = /^[0-9a-f]{64}$/i;
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;
// Short-TTL cache for *failed* verifications, keyed the same way as the
// success cache. Without this, repeatedly presenting the same wrong token
// re-pays the full scrypt cost every time — cheap enough for a legitimate
// mistyped-password retry, but a gift to anyone hammering one guess. See C1.
const NEGATIVE_CACHE_TTL_MS = 45 * 1000;
const NEGATIVE_CACHE_MAX_SIZE = 500;
// Pre-auth per-IP limiter: looser than the /verify and /enable login limiter
// (auth.controller.ts, 5/15min) since this one guards every other protected
// route (and the WS handshake) where a stale/expired session cookie is a
// normal, non-malicious occurrence. 20 failures/15min stops sustained
// scrypt-cost abuse without punishing a browser tab left open past a token
// rotation. See C1.
const PRE_AUTH_FAILURE_LIMIT = 20;
const PRE_AUTH_LOCKOUT_MS = 15 * 60 * 1000;

function timingSafeStringEqual(a: string, b: string): boolean {
  // Returning early on a length mismatch leaks the *length* of `b` (the
  // stored secret) via timing — but not any of its content, and
  // crypto.timingSafeEqual() throws on mismatched-length buffers anyway, so
  // there is no constant-time alternative that accepts variable-length
  // input. For a random token, a length oracle alone gives an attacker
  // nothing usable (it doesn't narrow down any byte), so this is an
  // acceptable tradeoff.
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Promise wrapper around crypto.scrypt (not util.promisify) so `crypto.scrypt`
 * is read fresh on every call — this keeps it mockable via
 * `vi.spyOn(crypto, 'scrypt')` in tests, which a promisified reference
 * captured once at module load would not be.
 */
function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Derives a salted scrypt hash for token storage: `scrypt$<salt>$<derivedKey>`. */
async function hashTokenScrypt(
  token: string,
  salt: string = crypto.randomBytes(16).toString('hex'),
): Promise<string> {
  const derivedKey = (await scryptAsync(token, salt, SCRYPT_KEY_LENGTH)).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

/** Recomputes the scrypt hash for `token` using the salt embedded in `stored` and compares. */
async function verifyScryptHash(token: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedDerivedKey] = parts;
  const candidate = (await scryptAsync(token, salt, SCRYPT_KEY_LENGTH)).toString('hex');
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
   * The global auth hook calls verifyToken() on every authenticated request,
   * and scrypt costs ~75ms of CPU per call. It runs off the main thread (via
   * crypto.scrypt's libuv threadpool, not scryptSync) so it no longer blocks
   * the event loop directly, but a polling dashboard re-deriving it on every
   * request would still burn threadpool capacity needlessly — this cache
   * avoids that. Wrong tokens are additionally short-TTL cached (see
   * failedTokens below) and rate-limited per-IP, which together keep online
   * brute force expensive. At most one token is ever valid, so this map stays
   * tiny.
   */
  private verifiedTokens = new Map<string, number>();

  /**
   * Memoizes *failed* verifications for a short TTL, keyed the same way as
   * verifiedTokens. scrypt now runs async (off the event loop thread via
   * libuv), so it no longer blocks other requests — but it is still real CPU
   * work, and an attacker (or misconfigured client) resubmitting the exact
   * same wrong token in a loop would otherwise re-pay that cost every single
   * time. Bounded to NEGATIVE_CACHE_MAX_SIZE with FIFO eviction so a flood of
   * distinct bad tokens can't grow this unboundedly. See C1.
   */
  private failedTokens = new Map<string, number>();

  /**
   * Pre-auth per-IP failure limiter shared by every protected HTTP route and
   * the WS handshake — both surfaces call verifyToken() through this one
   * AuthService instance (see I2), so a single limiter here throttles both.
   * See C1.
   */
  private readonly preAuthLimiter = new IpFailureLimiter({
    failureLimit: PRE_AUTH_FAILURE_LIMIT,
    lockoutMs: PRE_AUTH_LOCKOUT_MS,
  });

  constructor(db: StatsDatabase) {
    this.db = db;
    this.setupToken = this.isConfigured() ? null : this.resolveInitialSetupToken();
  }

  /**
   * Resolves the one-time setup token: honors ORBIT_SETUP_TOKEN if it meets
   * the same MIN_TOKEN_LENGTH floor as a normal access token, otherwise logs
   * a warning and falls back to a random token — an operator-set token
   * shorter than the floor would otherwise silently hand out a weak,
   * guessable setup credential with no indication anything is wrong.
   */
  private resolveInitialSetupToken(): string {
    const envToken = process.env.ORBIT_SETUP_TOKEN;
    if (envToken) {
      if (envToken.length >= MIN_TOKEN_LENGTH) {
        return envToken;
      }
      console.warn(
        `[SECURITY] ORBIT_SETUP_TOKEN is set but shorter than ${MIN_TOKEN_LENGTH} characters; ` +
          'ignoring it and generating a random one-time setup token instead.',
      );
    }
    return crypto.randomBytes(32).toString('hex');
  }

  /** Pre-auth per-IP lockout check — see `preAuthLimiter`. */
  isPreAuthLockedOut(ip: string): boolean {
    return this.preAuthLimiter.isLockedOut(ip);
  }

  /** Records a failed cookie/Bearer verification against the pre-auth per-IP limiter. */
  recordPreAuthFailure(ip: string): void {
    this.preAuthLimiter.recordFailure(ip);
  }

  /** Clears any accumulated pre-auth failures for an IP after a successful verification. */
  recordPreAuthSuccess(ip: string): void {
    this.preAuthLimiter.recordSuccess(ip);
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

    const negativeCachedUntil = this.failedTokens.get(cacheKey);
    if (negativeCachedUntil !== undefined) {
      if (negativeCachedUntil > Date.now()) {
        return { valid: false, message: 'Invalid token' };
      }
      this.failedTokens.delete(cacheKey);
    }

    const config = this.db.getAuthConfig();
    // isConfigured() already guarantees tokenHash is a non-null, non-legacy
    // (i.e. scrypt-formatted) value, but the check is defensive.
    if (config.tokenHash && (await verifyScryptHash(token, config.tokenHash))) {
      this.verifiedTokens.set(cacheKey, Date.now() + VERIFY_CACHE_TTL_MS);
      this.failedTokens.delete(cacheKey);
      return { valid: true };
    }

    this.recordNegativeVerification(cacheKey);
    return { valid: false, message: 'Invalid token' };
  }

  /** Records a failed verification in the short-TTL negative cache, evicting the oldest entry if full. */
  private recordNegativeVerification(cacheKey: string): void {
    if (this.failedTokens.size >= NEGATIVE_CACHE_MAX_SIZE && !this.failedTokens.has(cacheKey)) {
      const oldestKey = this.failedTokens.keys().next().value;
      if (oldestKey !== undefined) {
        this.failedTokens.delete(oldestKey);
      }
    }
    this.failedTokens.set(cacheKey, Date.now() + NEGATIVE_CACHE_TTL_MS);
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
      tokenHash: await hashTokenScrypt(token),
    });
    this.verifiedTokens.clear();
    this.failedTokens.clear();
    this.setupToken = null;
  }

  /**
   * Disable authentication. Route-less (no HTTP endpoint calls this) — kept
   * for tests/tooling, but if it were ever called after setup, leaving
   * setupToken at null (nulled by enableAuth()) would make the instance
   * unconfigurable without a process restart, since verifySetupToken() always
   * rejects once setupToken is null. Regenerating a fresh one here keeps the
   * first-run setup flow reachable again immediately.
   */
  disableAuth(): void {
    this.verifiedTokens.clear();
    this.failedTokens.clear();
    this.db.updateAuthConfig({
      enabled: false,
      tokenHash: null,
    });
    this.setupToken = this.resolveInitialSetupToken();
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
      tokenHash: await hashTokenScrypt(token),
    });
    this.verifiedTokens.clear();
    this.failedTokens.clear();
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
