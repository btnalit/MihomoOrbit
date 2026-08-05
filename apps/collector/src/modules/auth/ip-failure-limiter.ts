/**
 * Per-IP failure limiter.
 *
 * Tracks failed-attempt counts per IP inside a sliding window and locks an
 * IP out for a configurable duration once it crosses the failure threshold.
 * Shared logic behind two independent limiters in this codebase:
 *
 *  - auth.controller.ts: a strict 5-failures/15-minute limiter guarding the
 *    public /api/auth/verify and /api/auth/enable routes (login + first-run
 *    setup).
 *  - AuthService's pre-auth limiter: a looser 20-failures/15-minute limiter
 *    guarding every other protected route (and the WebSocket handshake) so a
 *    locked-out IP is rejected with 429 *before* authService.verifyToken()
 *    (and its scrypt cost) ever runs. See C1 in the M0 review findings.
 *
 * Each call site owns its own instance — state is intentionally not shared
 * at module scope, since a module-level Map would leak lockouts across
 * unrelated createApp() instances in the same process (notably in tests).
 */

interface FailureEntry {
  count: number;
  /** When the current sliding window started (ms since epoch). */
  windowStartedAt: number;
  /** 0 while under the threshold; otherwise the ms timestamp the lockout ends. */
  lockedUntil: number;
}

export interface IpFailureLimiterOptions {
  /** Failures within one window before an IP is locked out. */
  failureLimit: number;
  /** How long a lockout lasts once triggered. */
  lockoutMs: number;
  /**
   * Sliding window for counting failures. Once a window elapses without the
   * IP crossing the threshold, its counter resets — so a handful of failures
   * spread out over weeks (e.g. an admin mistyping a token a few times over
   * months) never accumulates toward a lockout. Defaults to `lockoutMs`.
   */
  windowMs?: number;
}

// Bounds memory for the failure map independent of the TTL-based sweep below
// (e.g. a burst of many distinct source IPs within one sweep interval).
const MAX_TRACKED_IPS = 10_000;
// How often maybeSweep() does a full pass to drop stale entries. Keeps the
// per-call cost O(1) in the common case instead of scanning the map on every
// recordFailure()/isLockedOut() call.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class IpFailureLimiter {
  private readonly failuresByIp = new Map<string, FailureEntry>();
  private readonly failureLimit: number;
  private readonly lockoutMs: number;
  private readonly windowMs: number;
  private lastSweepAt = Date.now();

  constructor(options: IpFailureLimiterOptions) {
    this.failureLimit = options.failureLimit;
    this.lockoutMs = options.lockoutMs;
    this.windowMs = options.windowMs ?? options.lockoutMs;
  }

  isLockedOut(ip: string): boolean {
    const entry = this.failuresByIp.get(ip);
    if (!entry) return false;
    // Not locked yet (still under the failure threshold) — leave the counter
    // alone so it keeps accumulating across requests within the window.
    if (entry.lockedUntil === 0) return false;
    if (entry.lockedUntil > Date.now()) return true;
    // Lockout window has elapsed; drop the stale entry so failures start fresh.
    this.failuresByIp.delete(ip);
    return false;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    let entry = this.failuresByIp.get(ip);
    if (!entry || now - entry.windowStartedAt > this.windowMs) {
      // No entry yet, or the sliding window has elapsed: start counting
      // fresh rather than letting long-stale failures accumulate forever.
      entry = { count: 0, windowStartedAt: now, lockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= this.failureLimit) {
      entry.lockedUntil = now + this.lockoutMs;
    }
    this.failuresByIp.set(ip, entry);
    this.maybeSweep();
  }

  recordSuccess(ip: string): void {
    this.failuresByIp.delete(ip);
  }

  /** Periodically evicts stale/expired entries so memory stays bounded. */
  private maybeSweep(): void {
    const now = Date.now();
    const dueForTimeSweep = now - this.lastSweepAt >= SWEEP_INTERVAL_MS;
    if (!dueForTimeSweep && this.failuresByIp.size <= MAX_TRACKED_IPS) {
      return;
    }

    if (dueForTimeSweep) {
      this.lastSweepAt = now;
      for (const [ip, entry] of this.failuresByIp) {
        const staleUnlocked = entry.lockedUntil === 0 && now - entry.windowStartedAt > this.windowMs;
        const staleLocked = entry.lockedUntil !== 0 && entry.lockedUntil <= now;
        if (staleUnlocked || staleLocked) {
          this.failuresByIp.delete(ip);
        }
      }
    }

    // Hard cap fallback: if still oversized (e.g. many distinct IPs with
    // still-active windows), drop the oldest entries by window start.
    if (this.failuresByIp.size > MAX_TRACKED_IPS) {
      const excess = this.failuresByIp.size - MAX_TRACKED_IPS;
      const sorted = Array.from(this.failuresByIp.entries()).sort(
        (a, b) => a[1].windowStartedAt - b[1].windowStartedAt,
      );
      for (let i = 0; i < excess; i++) {
        this.failuresByIp.delete(sorted[i][0]);
      }
    }
  }
}
