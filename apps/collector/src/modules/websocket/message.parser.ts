
import {
  ClientRange,
  ClientTrend,
  ClientDeviceDetail,
  ClientProxyDetail,
  ClientRuleDetail,
  ClientDomainsPage,
  ClientIPsPage,
} from './websocket.types.js';

export class MessageParser {
  parseRange(start?: string, end?: string): ClientRange | null {
    if (start === undefined && end === undefined) {
      return {};
    }

    if (!start || !end) {
      return null;
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return null;
    }
    if (startDate > endDate) {
      return null;
    }

    return {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    };
  }

  parseMinPushIntervalMs(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    // Keep range conservative to avoid client misuse.
    return Math.max(0, Math.min(60_000, Math.floor(value)));
  }

  shouldIncludeRealtime(range: ClientRange): boolean {
    if (!range.start && !range.end) {
      return true;
    }
    if (!range.end) {
      return false;
    }

    const endMs = new Date(range.end).getTime();
    if (Number.isNaN(endMs)) {
      return false;
    }

    const toleranceMs = parseInt(process.env.REALTIME_RANGE_END_TOLERANCE_MS || '120000', 10);
    const windowMs = Number.isFinite(toleranceMs) ? Math.max(10_000, toleranceMs) : 120_000;
    return endMs >= Date.now() - windowMs;
  }

  parsePositiveInt(value: number | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }

  parseNonNegativeInt(value: number | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return parsed;
  }

  resolveMinutesFromRange(range: ClientRange): number | null {
    if (!range.start || !range.end) return null;
    const startMs = new Date(range.start).getTime();
    const endMs = new Date(range.end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      return null;
    }
    return Math.max(1, Math.ceil((endMs - startMs) / 60000));
  }

  parseTrend(
    includeTrend: boolean | undefined,
    trendMinutes: number | undefined,
    trendBucketMinutes: number | undefined,
    range: ClientRange,
  ): ClientTrend | undefined {
    if (includeTrend === false) return null;
    if (
      includeTrend !== true &&
      trendMinutes === undefined &&
      trendBucketMinutes === undefined
    ) {
      return undefined;
    }

    const parsedMinutes = this.parsePositiveInt(trendMinutes);
    const parsedBucket = this.parsePositiveInt(trendBucketMinutes);
    if (trendMinutes !== undefined && parsedMinutes === null) return undefined;
    if (trendBucketMinutes !== undefined && parsedBucket === null) return undefined;

    const fallbackMinutes = this.resolveMinutesFromRange(range) ?? 30;
    const minutes = Math.min(parsedMinutes ?? fallbackMinutes, 30 * 24 * 60);
    const bucketMinutes = Math.min(parsedBucket ?? 1, 24 * 60);

    return {
      minutes,
      bucketMinutes,
    };
  }

  parseDeviceDetail(
    includeDeviceDetails: boolean | undefined,
    deviceSourceIP: string | undefined,
    deviceDetailLimit: number | undefined,
  ): ClientDeviceDetail | undefined {
    if (includeDeviceDetails === false) return null;
    if (
      includeDeviceDetails !== true &&
      deviceSourceIP === undefined &&
      deviceDetailLimit === undefined
    ) {
      return undefined;
    }

    const sourceIP = (deviceSourceIP || '').trim();
    if (!sourceIP) return undefined;

    const parsedLimit = this.parsePositiveInt(deviceDetailLimit);
    if (deviceDetailLimit !== undefined && parsedLimit === null) {
      return undefined;
    }

    return {
      sourceIP,
      limit: Math.min(parsedLimit ?? 5000, 20000),
    };
  }

  parseProxyDetail(
    includeProxyDetails: boolean | undefined,
    proxyChain: string | undefined,
    proxyDetailLimit: number | undefined,
  ): ClientProxyDetail | undefined {
    if (includeProxyDetails === false) return null;
    if (
      includeProxyDetails !== true &&
      proxyChain === undefined &&
      proxyDetailLimit === undefined
    ) {
      return undefined;
    }

    const chain = (proxyChain || '').trim();
    if (!chain) return undefined;

    const parsedLimit = this.parsePositiveInt(proxyDetailLimit);
    if (proxyDetailLimit !== undefined && parsedLimit === null) {
      return undefined;
    }

    return {
      chain,
      limit: Math.min(parsedLimit ?? 5000, 20000),
    };
  }

  parseRuleDetail(
    includeRuleDetails: boolean | undefined,
    ruleName: string | undefined,
    ruleDetailLimit: number | undefined,
  ): ClientRuleDetail | undefined {
    if (includeRuleDetails === false) return null;
    if (
      includeRuleDetails !== true &&
      ruleName === undefined &&
      ruleDetailLimit === undefined
    ) {
      return undefined;
    }

    const rule = (ruleName || '').trim();
    if (!rule) return undefined;

    const parsedLimit = this.parsePositiveInt(ruleDetailLimit);
    if (ruleDetailLimit !== undefined && parsedLimit === null) {
      return undefined;
    }

    return {
      rule,
      limit: Math.min(parsedLimit ?? 5000, 20000),
    };
  }

  normalizePageSortOrder(sortOrder?: string): 'asc' | 'desc' {
    return sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc';
  }

  normalizeDomainSortBy(sortBy?: string): string {
    const value = (sortBy || '').trim();
    switch (value) {
      case 'domain':
      case 'totalUpload':
      case 'totalTraffic':
      case 'totalConnections':
      case 'lastSeen':
      case 'totalDownload':
        return value;
      default:
        return 'totalDownload';
    }
  }

  normalizeIPSortBy(sortBy?: string): string {
    const value = (sortBy || '').trim();
    switch (value) {
      case 'ip':
      case 'totalUpload':
      case 'totalTraffic':
      case 'totalConnections':
      case 'lastSeen':
      case 'totalDownload':
        return value;
      default:
        return 'totalDownload';
    }
  }

  parseDomainsPage(
    includeDomainsPage: boolean | undefined,
    offset: number | undefined,
    limit: number | undefined,
    sortBy: string | undefined,
    sortOrder: string | undefined,
    search: string | undefined,
  ): ClientDomainsPage | undefined {
    if (includeDomainsPage === false) return null;
    if (
      includeDomainsPage !== true &&
      offset === undefined &&
      limit === undefined &&
      sortBy === undefined &&
      sortOrder === undefined &&
      search === undefined
    ) {
      return undefined;
    }

    const parsedOffset = this.parseNonNegativeInt(offset);
    const parsedLimit = this.parsePositiveInt(limit);
    if (offset !== undefined && parsedOffset === null) return undefined;
    if (limit !== undefined && parsedLimit === null) return undefined;

    return {
      offset: parsedOffset ?? 0,
      limit: Math.min(parsedLimit ?? 50, 200),
      sortBy: this.normalizeDomainSortBy(sortBy),
      sortOrder: this.normalizePageSortOrder(sortOrder),
      search: (search || '').trim() || undefined,
    };
  }

  parseIPsPage(
    includeIPsPage: boolean | undefined,
    offset: number | undefined,
    limit: number | undefined,
    sortBy: string | undefined,
    sortOrder: string | undefined,
    search: string | undefined,
  ): ClientIPsPage | undefined {
    if (includeIPsPage === false) return null;
    if (
      includeIPsPage !== true &&
      offset === undefined &&
      limit === undefined &&
      sortBy === undefined &&
      sortOrder === undefined &&
      search === undefined
    ) {
      return undefined;
    }

    const parsedOffset = this.parseNonNegativeInt(offset);
    const parsedLimit = this.parsePositiveInt(limit);
    if (offset !== undefined && parsedOffset === null) return undefined;
    if (limit !== undefined && parsedLimit === null) return undefined;

    return {
      offset: parsedOffset ?? 0,
      limit: Math.min(parsedLimit ?? 50, 200),
      sortBy: this.normalizeIPSortBy(sortBy),
      sortOrder: this.normalizePageSortOrder(sortOrder),
      search: (search || '').trim() || undefined,
    };
  }
}
