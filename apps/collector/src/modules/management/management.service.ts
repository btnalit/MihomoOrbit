/**
 * Management Service — REST proxy over a backend's Mihomo API for M1's
 * real-time management surface, plus collector-side group delay testing.
 *
 * All outbound upstream calls go through `upstreamFetch`, which always sets
 * an AbortSignal.timeout and normalizes failures into two structured shapes
 * a caller (the controller) can map to an HTTP status without inspecting
 * error internals: `{ reachable: false, timeout: true }` (upstream never
 * answered) and `{ reachable: false }` (upstream unreachable at the network
 * layer, e.g. connection refused). Every other thrown error is a genuine 5xx.
 */

import pLimit from 'p-limit';
import type { StatsDatabase } from '../db/db.js';
import type { TopicHub } from '../websocket/topic-hub.js';
import { getGatewayBaseUrl } from '@mihomo-orbit/shared';
import { clearCoreRestarting, markCoreRestarting } from '../../shared/core-lifecycle.js';

export interface ResolvedOk {
  ok: true;
  backendId: number;
  baseUrl: string;
  headers: Record<string, string>;
}

export type ResolveResult =
  | ResolvedOk
  | { ok: false; status: 404 | 409; body: Record<string, unknown> };

export interface ManagementServiceDeps {
  db: StatsDatabase;
  hub: TopicHub;
}

export type StartGroupDelayTestResult =
  | { accepted: true; group: string; total: number }
  | { accepted: false; code: 'DELAY_TEST_RUNNING' };

export type ProviderKind = 'rule' | 'proxy';

export interface RuleProviderInfo {
  name: string;
  behavior: string;
  ruleCount: number;
  updatedAt: string;
  vehicleType: string;
}

export interface ProxyProviderInfo {
  name: string;
  proxyCount: number;
  updatedAt: string;
  vehicleType: string;
}

export interface ProvidersResult {
  ruleProviders: RuleProviderInfo[];
  proxyProviders: ProxyProviderInfo[];
}

// Poll timing is injectable per call (not just via module-level constants)
// so tests can shrink the restart-recovery window to milliseconds instead of
// waiting out the real 15s production budget — see restartCore below.
export interface RestartCoreOpts {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  probeTimeoutMs?: number;
}

export type RestartCoreResult =
  | { success: true; recovered: true; recoveryMs: number }
  | { success: true; recovered: false };

// Raw upstream shapes (Mihomo `GET /providers/{rules,proxies}`) — only the
// fields this service reads are named; everything else on the upstream
// object (format, type, testUrl, subscriptionInfo, ...) is ignored.
interface RawRuleProvider {
  name: string;
  behavior: string;
  ruleCount: number;
  updatedAt: string;
  vehicleType: string;
}

interface RawProxyProvider {
  name: string;
  proxies?: unknown[];
  updatedAt: string;
  vehicleType: string;
}

const DEFAULT_DELAY_TEST_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_DELAY_TEST_TIMEOUT_MS = 5000;
// Belt-and-suspenders clamp mirroring management.controller.ts's
// parseOptionalTimeout: protects any caller that reaches the service
// directly with an out-of-range value (bypassing the controller's own
// clamp), so a negative/zero/absurd timeout can never reach
// AbortSignal.timeout via upstreamFetch.
const MIN_DELAY_TEST_TIMEOUT_MS = 100;
const MAX_DELAY_TEST_TIMEOUT_MS = 30_000;
// Upstream's own per-proxy delay test can legitimately take up to the
// requested `timeout`; our own AbortSignal.timeout for that call must give
// it room to answer instead of racing it.
const DELAY_FETCH_TIMEOUT_BUFFER_MS = 3000;
const PER_BACKEND_DELAY_CONCURRENCY = 5;
// Default per-request upstream timeout for calls that don't override it
// (matches upstreamFetch's own default parameter) — named here so the
// expectBody:false call sites below don't repeat the bare literal.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5000;
// A provider refresh PUT can trigger a synchronous re-download of the
// ruleset/subscription from its vehicle URL upstream — well beyond what a
// plain proxy/config PUT needs. The default 5000ms would predictably 504 a
// real provider refresh (M1.5 acceptance: "刷新一个 provider 上游 updatedAt 变化").
const PROVIDER_REFRESH_TIMEOUT_MS = 20_000;

// M4 core-ops (plan 2026-09-16-m4-core-ops.md §1): `POST /restart` re-execs
// the Mihomo process; the sandbox measurement was ~3s to `/version`
// recovery, so 15s total budget leaves headroom without letting a genuinely
// dead core hang the caller indefinitely. Poll cadence and per-probe timeout
// are independent of DEFAULT_UPSTREAM_TIMEOUT_MS — this is a recovery check,
// not a normal proxied request.
const CORE_RESTART_POLL_INTERVAL_MS = 500;
const CORE_RESTART_POLL_TIMEOUT_MS = 15_000;
const CORE_RESTART_PROBE_TIMEOUT_MS = 2_000;

function clampDelayTimeout(timeout: number | undefined): number {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return DEFAULT_DELAY_TEST_TIMEOUT_MS;
  }
  return Math.min(MAX_DELAY_TEST_TIMEOUT_MS, Math.max(MIN_DELAY_TEST_TIMEOUT_MS, timeout));
}

// Module-scope, process-wide cap: shared across every ManagementService
// instance and every backend, so one busy backend's group test can't starve
// fetch/timer resources from the rest of the process.
const globalDelayLimit = pLimit(Number(process.env.MGMT_DELAY_GLOBAL_CONCURRENCY || '16') || 16);

export class ManagementService {
  private readonly db: StatsDatabase;
  private readonly hub: TopicHub;

  // In-flight group delay tests, keyed by backendId -> set of group names
  // currently running. Guards against a duplicate POST for the same
  // (backendId, group) pair firing a second fan-out.
  private readonly inFlight = new Map<number, Set<string>>();
  // Per-backend concurrency limiter (lazily created, one per backend that has
  // ever run a group test), shared across concurrent group tests on that
  // backend — a fresh pLimit(5) per call would not actually bound anything.
  private readonly backendLimiters = new Map<number, ReturnType<typeof pLimit>>();

  constructor(deps: ManagementServiceDeps) {
    this.db = deps.db;
    this.hub = deps.hub;
  }

  resolve(backendId: number): ResolveResult {
    const backend = this.db.getBackend(backendId);
    if (!backend) {
      return { ok: false, status: 404, body: { error: 'Backend not found' } };
    }
    const apiUrl = (backend.api_url || '').trim();
    if (!apiUrl) {
      return {
        ok: false,
        status: 409,
        body: { code: 'NO_MANAGEMENT_CAPABILITY', backendId, error: 'Backend has no API URL' },
      };
    }
    return {
      ok: true,
      backendId,
      baseUrl: getGatewayBaseUrl(apiUrl),
      headers: backend.api_secret ? { Authorization: `Bearer ${backend.api_secret}` } : {},
    };
  }

  async fetchGroups(backendId: number): Promise<{ groups: unknown[]; proxies: Record<string, unknown> }> {
    const r = this.requireResolved(backendId);
    const res = await this.upstreamFetch(r, '/proxies');
    const data = (await res.json()) as { proxies?: Record<string, unknown> };
    const proxies = data.proxies ?? {};

    const global = proxies.GLOBAL as { all?: unknown } | undefined;
    const order: string[] = Array.isArray(global?.all) ? (global!.all as string[]) : [];
    const orderIndex = new Map(order.map((name, i) => [name, i]));
    // Contract order (m1-contracts.md): GLOBAL first, stable for API
    // consumers — this is the REST response's own ordering guarantee and is
    // independent of groups-page.tsx's *display-only* re-sort, which moves
    // GLOBAL last for the dashboard's UX (zashboard precedent). Both
    // orderings are intentional; neither should be "fixed" to match the
    // other.
    const rank = (name: string): number => (name === 'GLOBAL' ? -1 : orderIndex.get(name) ?? Infinity);

    const groups = Object.entries(proxies)
      .filter(([, p]) => Array.isArray((p as { all?: unknown }).all))
      .map(([name, p]) => ({ ...(p as object), name }))
      .sort((a, b) => rank(a.name) - rank(b.name));

    return { groups, proxies };
  }

  async selectProxy(backendId: number, group: string, proxy: string): Promise<void> {
    const r = this.requireResolved(backendId);
    await this.upstreamFetch(
      r,
      `/proxies/${encodeURIComponent(group)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: proxy }),
      },
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      { expectBody: false },
    );
  }

  async testDelay(
    backendId: number,
    proxy: string,
    opts: { url?: string; timeout?: number } = {},
  ): Promise<{ delay: number }> {
    const r = this.requireResolved(backendId);
    const url = opts.url ?? DEFAULT_DELAY_TEST_URL;
    const timeout = clampDelayTimeout(opts.timeout);
    const delay = await this.fetchProxyDelay(r, proxy, url, timeout);
    return { delay };
  }

  async startGroupDelayTest(
    backendId: number,
    group: string,
    opts: { url?: string; timeout?: number } = {},
  ): Promise<StartGroupDelayTestResult> {
    const r = this.requireResolved(backendId);

    const running = this.getOrCreateInFlightSet(backendId);
    if (running.has(group)) {
      return { accepted: false, code: 'DELAY_TEST_RUNNING' };
    }
    // Mark in-flight before any await, so a second call arriving while the
    // member-list fetch below is still pending sees it immediately.
    running.add(group);

    let members: string[];
    try {
      const res = await this.upstreamFetch(r, '/proxies');
      const data = (await res.json()) as { proxies?: Record<string, unknown> };
      const entry = data.proxies?.[group] as { all?: unknown } | undefined;
      members = Array.isArray(entry?.all) ? (entry!.all as string[]) : [];
    } catch (err) {
      running.delete(group);
      throw err;
    }

    // Fire-and-forget: the REST response reports `total` immediately, per-
    // member results and the trailing `done` land asynchronously on the
    // `delay` topic.
    void this.runGroupDelayTest(r, backendId, group, members, opts, running);

    return { accepted: true, group, total: members.length };
  }

  async killConnection(backendId: number, connId: string): Promise<void> {
    const r = this.requireResolved(backendId);
    await this.upstreamFetch(
      r,
      `/connections/${encodeURIComponent(connId)}`,
      { method: 'DELETE' },
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      { expectBody: false },
    );
  }

  async getConfigs(backendId: number): Promise<unknown> {
    const r = this.requireResolved(backendId);
    const res = await this.upstreamFetch(r, '/configs');
    return res.json();
  }

  async patchConfigs(backendId: number, patch: Record<string, unknown>): Promise<void> {
    const r = this.requireResolved(backendId);
    await this.upstreamFetch(
      r,
      '/configs',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      { expectBody: false },
    );
  }

  /** Merges Mihomo's `GET /providers/rules` and `GET /providers/proxies`
   *  into one aggregate view for the providers management page (M1.5).
   *  Sequential, not `Promise.all` — if one call rejected while the other's
   *  response was still in flight, the survivor's body would never be read
   *  or cancelled (see `cancelResponseBody`'s rationale above). `vehicleType
   *  === 'Compatible'` entries (inline group noise, not real
   *  file/URL-backed providers) are filtered out of both lists. */
  async fetchProviders(backendId: number): Promise<ProvidersResult> {
    const r = this.requireResolved(backendId);

    const rulesRes = await this.upstreamFetch(r, '/providers/rules');
    const rulesData = (await rulesRes.json()) as { providers?: Record<string, RawRuleProvider> };
    const ruleProviders: RuleProviderInfo[] = Object.values(rulesData.providers ?? {})
      .filter((p) => p.vehicleType !== 'Compatible')
      .map((p) => ({
        name: p.name,
        behavior: p.behavior,
        ruleCount: p.ruleCount,
        updatedAt: p.updatedAt,
        vehicleType: p.vehicleType,
      }));

    const proxiesRes = await this.upstreamFetch(r, '/providers/proxies');
    const proxiesData = (await proxiesRes.json()) as { providers?: Record<string, RawProxyProvider> };
    const proxyProviders: ProxyProviderInfo[] = Object.values(proxiesData.providers ?? {})
      .filter((p) => p.vehicleType !== 'Compatible')
      .map((p) => ({
        name: p.name,
        proxyCount: Array.isArray(p.proxies) ? p.proxies.length : 0,
        updatedAt: p.updatedAt,
        vehicleType: p.vehicleType,
      }));

    return { ruleProviders, proxyProviders };
  }

  async refreshProvider(backendId: number, kind: ProviderKind, name: string): Promise<void> {
    const r = this.requireResolved(backendId);
    const segment = kind === 'rule' ? 'rules' : 'proxies';
    await this.upstreamFetch(
      r,
      `/providers/${segment}/${encodeURIComponent(name)}`,
      { method: 'PUT' },
      PROVIDER_REFRESH_TIMEOUT_MS,
      { expectBody: false },
    );
  }

  /**
   * Core restart (M4 core-ops, plan §2: capability action, not a config
   * setting — it has no "current value", executing it is the whole effect).
   * `POST /restart` re-execs the Mihomo process in place; it answers 200
   * with a real JSON body (`{"status":"ok"}`) *while the old process is
   * still alive*, before the re-exec tears it down — unlike
   * killConnection/patchConfigs/flush*, this call must actually read that
   * body (no `expectBody:false`) rather than merely cancel it, since the
   * response is real and callers of `upstreamFetch` with the default
   * expectBody are expected to consume it themselves (see getConfigs).
   *
   * The 200 says nothing about whether the *new* process has come back up —
   * zashboard's own fixed 500ms post-restart reload delay (plan §1) is
   * shorter than our measured ~3s recovery window, so "wait a bit and just
   * refetch" isn't reliable here. Instead this polls `GET /version` (each
   * probe on its own short timeout — connection-refused during the re-exec
   * window is the *expected* shape of "not back up yet", not an error to
   * propagate) until the first 2xx or the poll budget elapses.
   */
  async restartCore(backendId: number, opts: RestartCoreOpts = {}): Promise<RestartCoreResult> {
    const r = this.requireResolved(backendId);
    // Mark the whole window (POST + recovery poll) so config-editor
    // apply/rollback refuse to dispatch into a core that is mid-restart —
    // the reverse half of §2's single-mutator invariant (see
    // shared/core-lifecycle.ts). Cleared in finally: a thrown POST must
    // never leave the backend permanently "restarting".
    markCoreRestarting(backendId);
    try {
      const startedAt = Date.now();
      const res = await this.upstreamFetch(r, '/restart', { method: 'POST' });
      await res.json(); // consume the {"status":"ok"} body — see doc comment above

      return await this.pollUntilRecovered(r, startedAt, {
        pollIntervalMs: opts.pollIntervalMs ?? CORE_RESTART_POLL_INTERVAL_MS,
        pollTimeoutMs: opts.pollTimeoutMs ?? CORE_RESTART_POLL_TIMEOUT_MS,
        probeTimeoutMs: opts.probeTimeoutMs ?? CORE_RESTART_PROBE_TIMEOUT_MS,
      });
    } finally {
      clearCoreRestarting(backendId);
    }
  }

  /**
   * Config reload (M4 core-ops): `PUT /configs?reload=true` re-reads the
   * config file already on disk into the running process, without a
   * restart. It is a capability action like restartCore, not a config
   * mutation — it gets its own route rather than reusing patchConfigs's
   * `PATCH /configs`, and the path/payload body is always empty because
   * this re-reads whatever is on disk; it never pushes new content (that's
   * the unrelated M2b editor apply/rollback flow, a different upstream
   * contract).
   */
  async reloadConfig(backendId: number): Promise<void> {
    const r = this.requireResolved(backendId);
    await this.upstreamFetch(
      r,
      '/configs?reload=true',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '', payload: '' }),
      },
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      { expectBody: false },
    );
  }

  /** Cache flush (M4 core-ops): clears Mihomo's DNS resolution cache. Unlike
   *  restartCore, the core never stops answering requests during this call,
   *  so there is no recovery window to verify — success is just a 2xx. */
  async flushDnsCache(backendId: number): Promise<void> {
    const r = this.requireResolved(backendId);
    await this.upstreamFetch(r, '/cache/dns/flush', { method: 'POST' }, DEFAULT_UPSTREAM_TIMEOUT_MS, {
      expectBody: false,
    });
  }

  /** Cache flush (M4 core-ops): clears Mihomo's Fake-IP pool assignments. */
  async flushFakeipCache(backendId: number): Promise<void> {
    const r = this.requireResolved(backendId);
    await this.upstreamFetch(r, '/cache/fakeip/flush', { method: 'POST' }, DEFAULT_UPSTREAM_TIMEOUT_MS, {
      expectBody: false,
    });
  }

  private requireResolved(backendId: number): ResolvedOk {
    const r = this.resolve(backendId);
    if (!r.ok) {
      throw Object.assign(new Error(String(r.body.error ?? 'Backend unavailable')), {
        status: r.status,
        body: r.body,
      });
    }
    return r;
  }

  private getOrCreateInFlightSet(backendId: number): Set<string> {
    let set = this.inFlight.get(backendId);
    if (!set) {
      set = new Set();
      this.inFlight.set(backendId, set);
    }
    return set;
  }

  private getBackendLimiter(backendId: number): ReturnType<typeof pLimit> {
    let limiter = this.backendLimiters.get(backendId);
    if (!limiter) {
      limiter = pLimit(PER_BACKEND_DELAY_CONCURRENCY);
      this.backendLimiters.set(backendId, limiter);
    }
    return limiter;
  }

  /** Best-effort: cancels an unread response body so undici can release the
   *  connection back to its pool instead of leaving it dangling until GC.
   *  Guarded — cancel() can itself throw (e.g. an already-consumed or
   *  errored stream) and the caller never needs this to succeed, only to
   *  not throw. */
  private async cancelResponseBody(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      // Ignore — see doc comment above.
    }
  }

  private async upstreamFetch(
    r: ResolvedOk,
    path: string,
    init: RequestInit = {},
    timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    opts: { expectBody?: boolean } = {},
  ): Promise<Response> {
    const expectBody = opts.expectBody ?? true;
    try {
      const res = await fetch(`${r.baseUrl}${path}`, {
        ...init,
        headers: { ...r.headers, ...((init.headers as Record<string, string>) || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // Nobody reads the body on the error path (callers only ever get
        // the thrown Error) — cancel it so the connection isn't held open
        // waiting for a read that will never come.
        await this.cancelResponseBody(res);
        throw Object.assign(new Error(`Upstream ${res.status}`), { status: res.status });
      }
      if (!expectBody) {
        // 2xx response the caller has no intention of reading (selectProxy /
        // killConnection / patchConfigs) — same reasoning as above.
        await this.cancelResponseBody(res);
      }
      return res;
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw Object.assign(new Error('Upstream timeout'), { reachable: false, timeout: true });
      }
      if (err instanceof TypeError) {
        // fetch's own network-layer failure (connection refused, DNS, etc.)
        throw Object.assign(new Error('Upstream unreachable'), { reachable: false });
      }
      throw err;
    }
  }

  /**
   * Restart-recovery poll loop for restartCore. Probes `GET /version` on a
   * short per-attempt timeout, waiting `pollIntervalMs` between attempts,
   * until either a 2xx lands (recovered) or `pollTimeoutMs` has elapsed
   * since `startedAt` (not recovered). Every probe failure — connection
   * refused while the process re-execs, a probe timeout, or a non-2xx — is
   * swallowed and treated identically ("not up yet"); only upstreamFetch
   * throwing is possible here since expectBody:false never reads a body
   * that could itself fail to parse.
   */
  private async pollUntilRecovered(
    r: ResolvedOk,
    startedAt: number,
    opts: { pollIntervalMs: number; pollTimeoutMs: number; probeTimeoutMs: number },
  ): Promise<RestartCoreResult> {
    const deadline = startedAt + opts.pollTimeoutMs;
    for (;;) {
      try {
        await this.upstreamFetch(r, '/version', {}, opts.probeTimeoutMs, { expectBody: false });
        return { success: true, recovered: true, recoveryMs: Date.now() - startedAt };
      } catch (err) {
        // A credentials rejection is not "still restarting" — the same
        // static headers just succeeded on the POST, so 401/403 here means
        // the core came back with different auth. Fail fast so the caller
        // gets the UPSTREAM_UNAUTHORIZED mapping instead of a misleading
        // "never recovered" after a full 15s spin.
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) throw err;
        // Anything else is expected during the restart window — keep
        // polling until the deadline, see doc comment above.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { success: true, recovered: false };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(opts.pollIntervalMs, remaining)));
    }
  }

  private async fetchProxyDelay(r: ResolvedOk, proxy: string, url: string, timeout: number): Promise<number> {
    const qs = new URLSearchParams({ url, timeout: String(timeout) });
    const res = await this.upstreamFetch(
      r,
      `/proxies/${encodeURIComponent(proxy)}/delay?${qs.toString()}`,
      {},
      timeout + DELAY_FETCH_TIMEOUT_BUFFER_MS,
    );
    const data = (await res.json()) as { delay: number };
    return data.delay;
  }

  private publishDelayEvent(backendId: number, data: Record<string, unknown>): void {
    const json = JSON.stringify({
      type: 'topic',
      topic: 'delay',
      backendId,
      data,
      timestamp: new Date().toISOString(),
    });
    this.hub.publishAppend('delay', backendId, json);
  }

  private async runGroupDelayTest(
    r: ResolvedOk,
    backendId: number,
    group: string,
    members: string[],
    opts: { url?: string; timeout?: number },
    running: Set<string>,
  ): Promise<void> {
    const url = opts.url ?? DEFAULT_DELAY_TEST_URL;
    const timeout = clampDelayTimeout(opts.timeout);
    const perBackendLimit = this.getBackendLimiter(backendId);

    try {
      await Promise.all(
        members.map((proxy) =>
          perBackendLimit(() =>
            globalDelayLimit(async () => {
              try {
                const delay = await this.fetchProxyDelay(r, proxy, url, timeout);
                this.publishDelayEvent(backendId, { group, proxy, delay });
              } catch {
                this.publishDelayEvent(backendId, { group, proxy, error: 'timeout' });
              }
            }),
          ),
        ),
      );
    } catch {
      // Belt-and-suspenders: individual member failures are already caught
      // above and never reject Promise.all, but a failure here must still
      // reach the `done` event and clear the in-flight marker below.
    } finally {
      this.publishDelayEvent(backendId, { group, done: true });
      running.delete(group);
    }
  }
}
