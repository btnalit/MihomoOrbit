import type {
  StatsSummary,
  DomainStats,
  IPStats,
  ProxyStats,
  RuleStats,
  CountryStats,
  TrafficTrendPoint,
  ProxyTrafficStats,
  DeviceStats,
  BackendCapabilities,
} from "@mihomo-orbit/shared";
import { getAuthHeaders } from "./auth-queries";

type RuntimeConfig = {
  API_URL?: string;
};

function getRuntimeConfig(): RuntimeConfig | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as any).__RUNTIME_CONFIG__ as RuntimeConfig | undefined;
}

function normalizeApiBase(url: string): string {
  if (!url) return "/api";
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function resolveApiBase(): string {
  const runtime = getRuntimeConfig();
  if (runtime?.API_URL) {
    return normalizeApiBase(runtime.API_URL);
  }
  const envUrl = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL;
  if (envUrl) {
    return normalizeApiBase(envUrl);
  }
  return "/api";
}

import { ApiError } from "./api-error";

const API_BASE = resolveApiBase();
const DETAIL_FETCH_LIMIT = 5000;
const inflightGetRequests = new Map<string, Promise<unknown>>();

function isApiStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}

/** `err.data.code` from a parsed management error body (e.g.
 *  `NO_MANAGEMENT_CAPABILITY`, `DELAY_TEST_RUNNING`) — undefined for any
 *  non-`ApiError` or a body without a `code` field. */
export function apiErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const data = err.data as { code?: unknown } | undefined;
  return typeof data?.code === "string" ? data.code : undefined;
}

/** True when the error represents an unreachable/offline upstream backend —
 *  either the parsed body's `reachable: false` (management contract) or a
 *  502/504 status as a fallback when the body didn't parse. */
export function isUnreachableError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const data = err.data as { reachable?: unknown } | undefined;
  if (data?.reachable === false) return true;
  return err.status === 502 || err.status === 504;
}



async function fetchJson<T>(
  url: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  if (method === "GET") {
    const inflight = inflightGetRequests.get(url);
    if (inflight) {
      return inflight as Promise<T>;
    }
  }

  const options: RequestInit = {
    method,
    headers: {
      ...getAuthHeaders(),
    },
  };

  // Only set Content-Type when there's a body
  if (body && method !== 'GET') {
    options.headers = {
      ...options.headers,
      'Content-Type': 'application/json',
    };
    options.body = JSON.stringify(body);
  }

  const requestPromise = (async () => {
    const res = await fetch(url, options);
    if (!res.ok) {
      // If 401, dispatch an event to notify auth system
      if (res.status === 401) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("api:unauthorized"));
        }
      }
      // Error responses carry the distinguishing shape from m1-contracts.md
      // (409 { code }, 502/504 { error, backendId, reachable: false }, etc.)
      // — parse it when present so callers can branch on it via
      // apiErrorCode()/isUnreachableError() below. Body may be empty or
      // non-JSON (e.g. a proxied 502 from something upstream of collector),
      // so this falls back to the old { url } shape on any parse failure.
      let data: unknown = { url };
      try {
        const parsed = await res.json();
        if (parsed && typeof parsed === "object") {
          data = parsed;
        }
      } catch {
        // No/invalid JSON body — keep the { url } fallback.
      }
      throw new ApiError(`API Error ${res.status}: ${url}`, res.status, data);
    }
    return await res.json() as T;
  })();

  if (method === "GET") {
    inflightGetRequests.set(url, requestPromise as Promise<unknown>);
  }

  try {
    return await requestPromise;
  } finally {
    if (method === "GET") {
      inflightGetRequests.delete(url);
    }
  }
}

export interface TimeRange {
  start: string;
  end: string;
}

export interface BackendHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  lastChecked: number;
  message?: string;
  latency?: number;
  serverLatency?: number;
}

export interface BackendHealthPoint {
  time: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  latency_ms: number | null;
  server_latency_ms: number | null;
  message: string | null;
}

export interface BackendHealthHistory {
  backendId: number;
  backendName: string;
  points: BackendHealthPoint[];
}

export interface Backend {
  id: number;
  name: string;
  url: string;
  token: string;
  type?: 'clash' | 'surge';
  enabled: boolean;
  is_active: boolean;
  listening: boolean;
  /** M1c: management API address (masked in showcase mode). '' = no API channel. */
  apiUrl: string;
  /** M1c: whether an agent token is configured (not the token itself). */
  hasAgent: boolean;
  /** M1c: explicitly bound agent id. '' = unbound. */
  agentId: string;
  /** M1c: only populated by getBackends() (list route). */
  capabilities?: BackendCapabilities;
  health?: BackendHealth;
  created_at: string;
  updated_at: string;
}

export interface GatewayProviderProxy {
  alive: boolean;
  name: string;
  type: string;
  now?: string;
  all?: string[];
  history?: Array<{ time: string; delay: number }>;
}

export interface GatewayProvider {
  name: string;
  type: string;
  vehicleType: string;
  proxies: GatewayProviderProxy[];
}

export interface GatewayProxiesResponse {
  proxies: Record<string, GatewayProviderProxy>;
}

export interface GatewayProvidersResponse {
  providers: Record<string, GatewayProvider>;
}

export interface GatewayRule {
  type: string;
  payload: string;
  proxy: string;
  size?: number;
  raw?: string;
}

export interface GatewayRulesResponse {
  rules: GatewayRule[];
  // Surge specific fields
  _source?: 'surge' | 'clash' | 'agent-cache';
  _availablePolicies?: string[];
}

export type GeoLookupProvider = "online" | "local";

export interface GeoLookupConfig {
  provider: GeoLookupProvider;
  configuredProvider: GeoLookupProvider;
  effectiveProvider: GeoLookupProvider;
  mmdbDir: string;
  onlineApiUrl: string;
  localMmdbReady: boolean;
  missingMmdbFiles: string[];
}

const DEFAULT_DB_STATS = {
  size: 0,
  sqliteSize: 0,
  clickhouseSize: 0,
  totalConnectionsCount: 0,
} as const;

const DEFAULT_RETENTION_CONFIG = {
  connectionLogsDays: 7,
  hourlyStatsDays: 30,
  autoCleanup: true,
} as const;

const DEFAULT_GEO_LOOKUP_CONFIG: GeoLookupConfig = {
  provider: "online",
  configuredProvider: "online",
  effectiveProvider: "online",
  mmdbDir: "geoip",
  onlineApiUrl: "https://api.ipinfo.es/ipinfo",
  localMmdbReady: false,
  missingMmdbFiles: [],
};

function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  // Use simple URL construction for client-side relative URLs
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return query ? `${base}?${query}` : base;
}

export const api = {
  // Stats APIs with optional backendId parameter
  getSummary: (backendId?: number, range?: TimeRange) => 
    fetchJson<StatsSummary & { backend: { id: number; name: string; isActive: boolean; listening: boolean } }>(
      buildUrl(`${API_BASE}/stats/summary`, {
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),
  
  getDomains: (backendId?: number, opts?: {
    offset?: number; limit?: number;
    sortBy?: string; sortOrder?: string; search?: string;
    start?: string; end?: string;
  }) =>
    fetchJson<{ data: DomainStats[]; total: number }>(
      buildUrl(`${API_BASE}/stats/domains`, { backendId, ...opts })
    ),

  getIPs: (backendId?: number, opts?: {
    offset?: number; limit?: number;
    sortBy?: string; sortOrder?: string; search?: string;
    start?: string; end?: string;
  }) =>
    fetchJson<{ data: IPStats[]; total: number }>(
      buildUrl(`${API_BASE}/stats/ips`, { backendId, ...opts })
    ),
    
  getProxies: (backendId?: number, limit = 50, range?: TimeRange) =>
    fetchJson<ProxyStats[]>(buildUrl(`${API_BASE}/stats/proxies`, {
      backendId,
      limit,
      start: range?.start,
      end: range?.end,
    })),
    
  getRules: (backendId?: number, limit = 50, range?: TimeRange) =>
    fetchJson<RuleStats[]>(buildUrl(`${API_BASE}/stats/rules`, {
      backendId,
      limit,
      start: range?.start,
      end: range?.end,
    })),
    
  getCountries: (backendId?: number, limit = 50, range?: TimeRange) =>
    fetchJson<CountryStats[]>(buildUrl(`${API_BASE}/stats/countries`, {
      backendId,
      limit,
      start: range?.start,
      end: range?.end,
    })),
    
  getTrafficTrendAggregated: (backendId?: number, minutes = 30, bucketMinutes = 1, range?: TimeRange) =>
    fetchJson<TrafficTrendPoint[]>(
      buildUrl(`${API_BASE}/stats/trend/aggregated`, {
        backendId,
        minutes,
        bucketMinutes,
        start: range?.start,
        end: range?.end,
      })
    ),
    
  getDomainProxyStats: (
    domain: string,
    backendId?: number,
    range?: TimeRange,
    sourceIP?: string,
    sourceChain?: string,
  ) =>
    fetchJson<ProxyTrafficStats[]>(
      buildUrl(`${API_BASE}/stats/domains/proxy-stats`, {
        domain,
        backendId,
        start: range?.start,
        end: range?.end,
        sourceIP,
        sourceChain,
      })
    ),

  getDomainIPDetails: (
    domain: string,
    backendId?: number,
    range?: TimeRange,
    sourceIP?: string,
    sourceChain?: string,
  ) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/domains/ip-details`, {
        domain,
        backendId,
        start: range?.start,
        end: range?.end,
        sourceIP,
        sourceChain,
      })
    ),

  getIPProxyStats: (
    ip: string,
    backendId?: number,
    range?: TimeRange,
    sourceIP?: string,
    sourceChain?: string,
  ) =>
    fetchJson<ProxyTrafficStats[]>(
      buildUrl(`${API_BASE}/stats/ips/proxy-stats`, {
        ip,
        backendId,
        start: range?.start,
        end: range?.end,
        sourceIP,
        sourceChain,
      })
    ),

  getIPDomainDetails: (
    ip: string,
    backendId?: number,
    range?: TimeRange,
    sourceIP?: string,
    limit = DETAIL_FETCH_LIMIT,
    sourceChain?: string,
  ) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/ips/domain-details`, {
        ip,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
        sourceIP,
        sourceChain,
      })
    ),

  getProxyDomains: (chain: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/proxies/domains`, {
        chain,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getProxyIPs: (chain: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/proxies/ips`, {
        chain,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  // Device stats APIs
  getDevices: (backendId?: number, limit = 50, range?: TimeRange) =>
    fetchJson<DeviceStats[]>(
      buildUrl(`${API_BASE}/stats/devices`, { backendId, limit, start: range?.start, end: range?.end })
    ),

  getDeviceDomains: (sourceIP: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/devices/domains`, {
        sourceIP,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getDeviceIPs: (sourceIP: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/devices/ips`, {
        sourceIP,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleDomains: (rule: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/rules/domains`, {
        rule,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleIPs: (rule: string, backendId?: number, range?: TimeRange, limit = DETAIL_FETCH_LIMIT) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/rules/ips`, {
        rule,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleDomainProxyStats: (
    rule: string,
    domain: string,
    backendId?: number,
    range?: TimeRange,
  ) =>
    fetchJson<ProxyTrafficStats[]>(
      buildUrl(`${API_BASE}/stats/rules/domains/proxy-stats`, {
        rule,
        domain,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleDomainIPDetails: (
    rule: string,
    domain: string,
    backendId?: number,
    range?: TimeRange,
    limit = DETAIL_FETCH_LIMIT,
  ) =>
    fetchJson<IPStats[]>(
      buildUrl(`${API_BASE}/stats/rules/domains/ip-details`, {
        rule,
        domain,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleIPProxyStats: (
    rule: string,
    ip: string,
    backendId?: number,
    range?: TimeRange,
  ) =>
    fetchJson<ProxyTrafficStats[]>(
      buildUrl(`${API_BASE}/stats/rules/ips/proxy-stats`, {
        rule,
        ip,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getRuleIPDomainDetails: (
    rule: string,
    ip: string,
    backendId?: number,
    range?: TimeRange,
    limit = DETAIL_FETCH_LIMIT,
  ) =>
    fetchJson<DomainStats[]>(
      buildUrl(`${API_BASE}/stats/rules/ips/domain-details`, {
        rule,
        ip,
        limit,
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getAllRuleChainFlows: (backendId?: number, range?: TimeRange) =>
    fetchJson<{
      nodes: Array<{ name: string; layer: number; nodeType: 'rule' | 'group' | 'proxy'; totalUpload: number; totalDownload: number; totalConnections: number; rules: string[] }>;
      links: Array<{ source: number; target: number; rules: string[] }>;
      rulePaths: Record<string, { nodeIndices: number[]; linkIndices: number[] }>;
      maxLayer: number;
    }>(
      buildUrl(`${API_BASE}/stats/rules/chain-flow-all`, {
        backendId,
        start: range?.start,
        end: range?.end,
      })
    ),

  getGatewayProviders: (backendId?: number) =>
    fetchJson<GatewayProvidersResponse>(buildUrl(`${API_BASE}/gateway/providers/proxies`, { backendId })),

  getGatewayRules: (backendId?: number) =>
    fetchJson<GatewayRulesResponse>(buildUrl(`${API_BASE}/gateway/rules`, { backendId })),

  getGatewayProxies: (backendId?: number) =>
    fetchJson<GatewayProxiesResponse>(buildUrl(`${API_BASE}/gateway/proxies`, { backendId })),
    
  // Backend management
  getBackends: () =>
    fetchJson<Backend[]>(`${API_BASE}/backends`),
    
  createBackend: (backend: { name: string; apiUrl?: string; apiSecret?: string; withAgent?: boolean; type?: 'clash' | 'surge' }) =>
    fetchJson<{ id: number; isActive?: boolean; message: string; agentToken?: string }>(`${API_BASE}/backends`, 'POST', backend),

  updateBackend: (id: number, backend: { name?: string; apiUrl?: string; apiSecret?: string; withAgent?: boolean; type?: 'clash' | 'surge'; enabled?: boolean; listening?: boolean }) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}`, 'PUT', backend),

  deleteBackend: (id: number) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}`, 'DELETE'),
    
  setActiveBackend: (id: number) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}/activate`, 'POST'),

  setBackendListening: (id: number, listening: boolean) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}/listening`, 'POST', { listening }),

  clearBackendData: (id: number) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}/clear-data`, 'POST'),
    
  testBackend: (url: string, token?: string, type?: 'clash' | 'surge') =>
    fetchJson<{ success: boolean; message: string }>(`${API_BASE}/backends/test`, 'POST', { url, token, type }),

  testBackendById: (id: number) =>
    fetchJson<{ success: boolean; message: string }>(`${API_BASE}/backends/${id}/test`, 'POST'),

  rotateAgentToken: (id: number) =>
    fetchJson<{ message: string; agentToken: string }>(`${API_BASE}/backends/${id}/rotate-agent-token`, 'POST'),

  unbindAgent: (id: number) =>
    fetchJson<{ message: string }>(`${API_BASE}/backends/${id}/agent/unbind`, 'POST'),

  getBackendHealthHistory: (opts?: { from?: string; to?: string; backendId?: number }) =>
    fetchJson<BackendHealthHistory[]>(
      buildUrl(`${API_BASE}/backends/health/history`, {
        from: opts?.from,
        to: opts?.to,
        backendId: opts?.backendId,
      })
    ),
    
  // Database management
  getDbStats: async () => {
    try {
      return await fetchJson<{
        size: number;
        sqliteSize: number;
        clickhouseSize: number;
        totalConnectionsCount: number;
      }>(`${API_BASE}/db/stats`);
    } catch (error) {
      if (isApiStatus(error, 404)) {
        return { ...DEFAULT_DB_STATS };
      }
      throw error;
    }
  },
    
  clearLogs: (days: number, backendId?: number) =>
    fetchJson<{ message: string; deleted: number }>(`${API_BASE}/db/cleanup`, 'POST', { days, backendId }),

  getRetentionConfig: async () => {
    try {
      return await fetchJson<{ connectionLogsDays: number; hourlyStatsDays: number; autoCleanup: boolean }>(
        `${API_BASE}/db/retention`
      );
    } catch (error) {
      if (isApiStatus(error, 404)) {
        return { ...DEFAULT_RETENTION_CONFIG };
      }
      throw error;
    }
  },

  updateRetentionConfig: (config: { connectionLogsDays: number; hourlyStatsDays: number; autoCleanup?: boolean }) =>
    fetchJson<{ message: string }>(`${API_BASE}/db/retention`, 'PUT', config),

  getGeoLookupConfig: async () => {
    try {
      return await fetchJson<GeoLookupConfig>(`${API_BASE}/db/geoip`);
    } catch (error) {
      if (isApiStatus(error, 404)) {
        return { ...DEFAULT_GEO_LOOKUP_CONFIG };
      }
      throw error;
    }
  },

  updateGeoLookupConfig: (
    config: { provider?: GeoLookupProvider; onlineApiUrl?: string },
  ) =>
    fetchJson<{ message: string; config: GeoLookupConfig }>(`${API_BASE}/db/geoip`, 'PUT', config),

  // Auth management
  getAuthState: () =>
    fetchJson<{ enabled: boolean; hasToken: boolean }>(`${API_BASE}/auth/state`),

  enableAuth: (token: string) =>
    fetchJson<{ success: boolean; message: string }>(`${API_BASE}/auth/enable`, 'POST', { token }),


  verifyAuth: (token: string) =>
    fetchJson<{ valid: boolean; message?: string }>(`${API_BASE}/auth/verify`, 'POST', { token }),

  updateToken: (currentToken: string, newToken: string) =>
    fetchJson<{ success: boolean; message: string }>(`${API_BASE}/auth/token`, 'PUT', { currentToken, newToken }),
};

// ── Management (M1 real-time management surface) ────────────────────────
// REST contract: m1-contracts.md §REST 契约. Every URL is a template
// literal on API_BASE so `pnpm check:api-routes` can pair it with the
// collector's management.controller.ts routes.

export interface MihomoProxyHistoryEntry {
  time: string;
  delay: number;
}

/** Mihomo `/proxies` entry — passed through from upstream, shape varies by
 *  proxy/group type, so unknown extra fields are preserved rather than dropped. */
export interface MihomoProxy {
  name: string;
  type: string;
  alive?: boolean;
  now?: string;
  all?: string[];
  history?: MihomoProxyHistoryEntry[];
  udp?: boolean;
  xudp?: boolean;
  tfo?: boolean;
  mptcp?: boolean;
  smux?: boolean;
  id?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ManagementGroupsResponse {
  groups: MihomoProxy[];
  proxies: Record<string, MihomoProxy>;
}

export interface DelayTestResult {
  delay: number;
}

export interface GroupDelayTestAccepted {
  accepted: true;
  group: string;
  total: number;
}

/** Mihomo `/configs` — passed through verbatim; known fields are typed,
 *  everything else survives via the index signature. */
export interface MihomoRuntimeConfig {
  port?: number;
  "socks-port"?: number;
  "redir-port"?: number;
  "tproxy-port"?: number;
  "mixed-port"?: number;
  mode?: string;
  "log-level"?: string;
  "allow-lan"?: boolean;
  "bind-address"?: string;
  ipv6?: boolean;
  tun?: Record<string, unknown>;
  [key: string]: unknown;
}

export function fetchManagementGroups(backendId: number) {
  return fetchJson<ManagementGroupsResponse>(`${API_BASE}/management/${backendId}/groups`);
}

export function selectGroupProxy(backendId: number, group: string, proxy: string) {
  return fetchJson<{ success: true }>(
    `${API_BASE}/management/${backendId}/groups/${encodeURIComponent(group)}`,
    "PUT",
    { proxy },
  );
}

export function testProxyDelay(
  backendId: number,
  proxy: string,
  opts?: { url?: string; timeout?: number },
) {
  return fetchJson<DelayTestResult>(
    buildUrl(`${API_BASE}/management/${backendId}/delay/${encodeURIComponent(proxy)}`, {
      url: opts?.url,
      timeout: opts?.timeout,
    }),
  );
}

export function testGroupDelay(
  backendId: number,
  group: string,
  opts?: { url?: string; timeout?: number },
) {
  const body = opts && (opts.url !== undefined || opts.timeout !== undefined) ? opts : undefined;
  return fetchJson<GroupDelayTestAccepted>(
    `${API_BASE}/management/${backendId}/delay-group/${encodeURIComponent(group)}`,
    "POST",
    body,
  );
}

export function killConnection(backendId: number, connId: string) {
  return fetchJson<{ success: true }>(
    `${API_BASE}/management/${backendId}/connections/${encodeURIComponent(connId)}`,
    "DELETE",
  );
}

export function fetchRuntimeConfig(backendId: number) {
  return fetchJson<MihomoRuntimeConfig>(`${API_BASE}/management/${backendId}/configs`);
}

export function patchRuntimeConfig(backendId: number, patch: Partial<MihomoRuntimeConfig>) {
  return fetchJson<{ success: true }>(
    `${API_BASE}/management/${backendId}/configs`,
    "PATCH",
    patch,
  );
}

// Helper functions for time range
export function getPresetTimeRange(
  preset: "1m" | "5m" | "15m" | "30m" | "1h" | "7d" | "30d" | "24h" | "today",
): TimeRange {
  const now = new Date();
  const end = new Date(now);
  end.setMilliseconds(0);
  end.setSeconds(0); // Truncate to minute to align with backend health log interval
  
  // Helper to get start of today in local time
  const getStartOfToday = () => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  
  let start: Date;
  
  switch (preset) {
    case "1m":
      start = new Date(end);
      start.setMinutes(start.getMinutes() - 1);
      break;
    case "5m":
      start = new Date(end);
      start.setMinutes(start.getMinutes() - 5);
      break;
    case "15m":
      start = new Date(end);
      start.setMinutes(start.getMinutes() - 15);
      break;
    case "30m":
      start = new Date(end);
      start.setMinutes(start.getMinutes() - 30);
      break;
    case "1h":
      start = new Date(end);
      start.setHours(start.getHours() - 1);
      break;
    case '7d':
      start = new Date(end);
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start = new Date(end);
      start.setDate(start.getDate() - 30);
      break;
    case '24h':
      start = new Date(end);
      start.setHours(start.getHours() - 24);
      break;
    case 'today':
      start = getStartOfToday();
      break;
    default:
      start = new Date(end);
      start.setHours(start.getHours() - 24);
  }
  
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export function formatDateTimeForInput(date: Date): string {
  return date.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

export function formatDateTimeDisplay(isoString: string, locale?: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
