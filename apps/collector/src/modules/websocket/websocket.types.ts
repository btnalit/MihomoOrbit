
import { WebSocket } from 'ws';
import { StatsSummary } from '@neko-master/shared';

export type SummaryFieldKey =
  | 'totals'
  | 'topDomains'
  | 'topIPs'
  | 'proxyStats'
  | 'countryStats'
  | 'deviceStats'
  | 'ruleStats'
  | 'hourlyStats';

export type SummaryFieldMask = Record<SummaryFieldKey, boolean>;

// --- Client Request / Message Types ---

export interface WebSocketMessage {
  type: 'stats' | 'ping' | 'pong' | 'subscribe';
  backendId?: number;
  start?: string;
  end?: string;
  minPushIntervalMs?: number;
  includeSummary?: boolean;
  summaryFields?: SummaryFieldKey[];

  // Trend
  includeTrend?: boolean;
  trendMinutes?: number;
  trendBucketMinutes?: number;

  // Device Detail (Source IP)
  includeDeviceDetails?: boolean;
  deviceSourceIP?: string;
  deviceDetailLimit?: number;

  // Proxy Detail
  includeProxyDetails?: boolean;
  proxyChain?: string;
  proxyDetailLimit?: number;

  // Rule Detail
  includeRuleDetails?: boolean;
  ruleName?: string;
  ruleDetailLimit?: number;
  includeRuleChainFlow?: boolean;

  // Pagination: Domains
  includeDomainsPage?: boolean;
  domainsPageOffset?: number;
  domainsPageLimit?: number;
  domainsPageSortBy?: string;
  domainsPageSortOrder?: string;
  domainsPageSearch?: string;

  // Pagination: IPs
  includeIPsPage?: boolean;
  ipsPageOffset?: number;
  ipsPageLimit?: number;
  ipsPageSortBy?: string;
  ipsPageSortOrder?: string;
  ipsPageSearch?: string;

  // Response Data (server to client)
  data?: StatsSummary;
  timestamp?: string;
}

// --- Internal Client State Types ---

export type ClientRange = {
  start?: string;
  end?: string;
};

export type ClientTrend = {
  minutes: number;
  bucketMinutes: number;
} | null;

export type ClientDeviceDetail = {
  sourceIP: string;
  limit: number;
} | null;

export type ClientProxyDetail = {
  chain: string;
  limit: number;
} | null;

export type ClientRuleDetail = {
  rule: string;
  limit: number;
} | null;

export type ClientDomainsPage = {
  offset: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
} | null;

export type ClientIPsPage = {
  offset: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
} | null;

export interface ClientInfo {
  ws: WebSocket;
  backendId: number | null; // null means use active backend
  range: ClientRange;
  minPushIntervalMs: number;
  includeSummary: boolean;
  summaryFields: SummaryFieldMask;
  lastSentAt: number;
  trend: ClientTrend;
  deviceDetail: ClientDeviceDetail;
  proxyDetail: ClientProxyDetail;
  ruleDetail: ClientRuleDetail;
  includeRuleChainFlow: boolean;
  domainsPage: ClientDomainsPage;
  ipsPage: ClientIPsPage;
}
