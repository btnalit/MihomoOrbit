/**
 * Stats module type definitions
 */

import type { DomainStats, IPStats, ProxyStats, RuleStats, HourlyStats, DeviceStats } from '@neko-master/shared';

export interface TimeRangeQuery {
  start?: string;
  end?: string;
}

export interface BackendIdQuery {
  backendId?: string;
}

export interface PaginationQuery {
  offset?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
  search?: string;
}

export interface DomainQuery extends TimeRangeQuery {
  domain?: string;
  sourceIP?: string;
  sourceChain?: string;
}

export interface IPQuery extends TimeRangeQuery {
  ip?: string;
  sourceIP?: string;
  sourceChain?: string;
}

export interface ChainQuery extends TimeRangeQuery {
  chain?: string;
  limit?: string;
}

export interface RuleQuery extends TimeRangeQuery {
  rule?: string;
  limit?: string;
}

export interface RuleDomainQuery extends TimeRangeQuery {
  rule?: string;
  domain?: string;
  limit?: string;
}

export interface RuleIPQuery extends TimeRangeQuery {
  rule?: string;
  ip?: string;
  limit?: string;
}

export interface DeviceQuery extends TimeRangeQuery {
  sourceIP: string;
  limit?: string;
}

export interface TrendQuery extends TimeRangeQuery {
  minutes?: string;
  bucketMinutes?: string;
}

export interface ConnectionsQuery {
  limit?: string;
}

export interface SummaryResponse {
  backend: {
    id: number;
    name: string;
    isActive: boolean;
    listening: boolean;
  };
  totalConnections: number;
  totalUpload: number;
  totalDownload: number;
  totalDomains: number;
  totalIPs: number;
  totalRules: number;
  totalProxies: number;
  todayUpload: number;
  todayDownload: number;
  topDomains: DomainStats[];
  topIPs: IPStats[];
  proxyStats: ProxyStats[];
  ruleStats: RuleStats[];
  hourlyStats: HourlyStats[];
}

export interface GlobalSummary {
  totalConnections: number;
  totalUpload: number;
  totalDownload: number;
  uniqueDomains: number;
  uniqueIPs: number;
  backendCount: number;
}

export interface PaginatedDomainStats {
  data: DomainStats[];
  total: number;
}

export interface PaginatedIPStats {
  data: IPStats[];
  total: number;
}

export interface TrafficTrendPoint {
  time: string;
  upload: number;
  download: number;
}

export interface TimeRange {
  start?: string;
  end?: string;
  active: boolean;
}

export interface CountryStats {
  country: string;
  countryName: string;
  continent: string;
  totalUpload: number;
  totalDownload: number;
  totalConnections: number;
}

export type { DomainStats, IPStats, ProxyStats, RuleStats, HourlyStats, DeviceStats };
