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

const DEFAULT_DELAY_TEST_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_DELAY_TEST_TIMEOUT_MS = 5000;
// Upstream's own per-proxy delay test can legitimately take up to the
// requested `timeout`; our own AbortSignal.timeout for that call must give
// it room to answer instead of racing it.
const DELAY_FETCH_TIMEOUT_BUFFER_MS = 3000;
const PER_BACKEND_DELAY_CONCURRENCY = 5;

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
    const rank = (name: string): number => (name === 'GLOBAL' ? -1 : orderIndex.get(name) ?? Infinity);

    const groups = Object.entries(proxies)
      .filter(([, p]) => Array.isArray((p as { all?: unknown }).all))
      .map(([name, p]) => ({ ...(p as object), name }))
      .sort((a, b) => rank(a.name) - rank(b.name));

    return { groups, proxies };
  }

  async selectProxy(backendId: number, group: string, proxy: string): Promise<void> {
    const r = this.requireResolved(backendId);
    await this.upstreamFetch(r, `/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: proxy }),
    });
  }

  async testDelay(
    backendId: number,
    proxy: string,
    opts: { url?: string; timeout?: number } = {},
  ): Promise<{ delay: number }> {
    const r = this.requireResolved(backendId);
    const url = opts.url ?? DEFAULT_DELAY_TEST_URL;
    const timeout = opts.timeout ?? DEFAULT_DELAY_TEST_TIMEOUT_MS;
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
    await this.upstreamFetch(r, `/connections/${encodeURIComponent(connId)}`, { method: 'DELETE' });
  }

  async getConfigs(backendId: number): Promise<unknown> {
    const r = this.requireResolved(backendId);
    const res = await this.upstreamFetch(r, '/configs');
    return res.json();
  }

  async patchConfigs(backendId: number, patch: Record<string, unknown>): Promise<void> {
    const r = this.requireResolved(backendId);
    await this.upstreamFetch(r, '/configs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
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

  private async upstreamFetch(
    r: ResolvedOk,
    path: string,
    init: RequestInit = {},
    timeoutMs = 5000,
  ): Promise<Response> {
    try {
      const res = await fetch(`${r.baseUrl}${path}`, {
        ...init,
        headers: { ...r.headers, ...((init.headers as Record<string, string>) || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw Object.assign(new Error(`Upstream ${res.status}`), { status: res.status });
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
    const timeout = opts.timeout ?? DEFAULT_DELAY_TEST_TIMEOUT_MS;
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
