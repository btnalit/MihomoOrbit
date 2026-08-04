import fs from "node:fs";
import path from "node:path";
import maxmind, {
  type AsnResponse,
  type CityResponse,
  type CountryResponse,
  type Reader,
} from "maxmind";
import type { StatsDatabase } from "../db/db.js";
import { ConfigRepository, type GeoLookupConfig } from "../../database/repositories/config.repository.js";

export interface GeoLocation {
  country: string;
  country_name: string;
  city: string;
  asn: string;
  as_name: string;
  as_domain: string;
  continent: string;
  continent_name: string;
}

interface GeoIPApiResponse {
  country?: unknown;
  country_name?: unknown;
  city?: unknown;
  asn?: unknown;
  as_name?: unknown;
  as_domain?: unknown;
  continent?: unknown;
  continent_name?: unknown;
  reserved?: unknown;
}

interface LocalMmdbReaders {
  mmdbDir: string;
  cityPath: string;
  asnPath: string;
  countryPath: string | null;
  cityMtimeMs: number;
  asnMtimeMs: number;
  countryMtimeMs: number | null;
  cityReader: Reader<CityResponse>;
  asnReader: Reader<AsnResponse>;
  countryReader: Reader<CountryResponse> | null;
}

export class GeoIPService {
  private db: StatsDatabase;
  private pendingQueries: Map<string, Promise<GeoLocation | null>> = new Map();
  private memoryGeoCache: Map<string, GeoLocation> = new Map();
  private failedIPs: Map<string, number> = new Map();
  private lastRequestTime: number = 0;
  private lastFailedIPsCleanup: number = 0;
  private queue: {
    ip: string;
    resolve: (value: GeoLocation | null) => void;
  }[] = [];
  private isProcessing: boolean = false;
  private processorTimer: NodeJS.Timeout | null = null;
  private localMmdbReaders: LocalMmdbReaders | null = null;
  private localMmdbLoadPromise: Promise<LocalMmdbReaders | null> | null = null;
  private lastLocalMmdbCheckMs: number = 0;
  private geoLookupConfigCache:
    | { value: GeoLookupConfig; checkedAt: number }
    | null = null;
  private localMinRequestIntervalMs: number;
  private enableCountryMmdbFallback: boolean;
  private metricsLogIntervalMs: number;
  private metricsWindowStartedAt: number = Date.now();
  private metrics = {
    geoLookupCount: 0,
    localMmdbQueryCount: 0,
    geoCacheHit: 0,
    geoCacheMiss: 0,
    geoDbReadCount: 0,
  };

  private static FAIL_COOLDOWN_MS = 30 * 60 * 1000;
  private static MAX_QUEUE_SIZE = 100;
  private static FAILED_IPS_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
  private static ONLINE_MIN_REQUEST_INTERVAL_MS = 100;
  private static LOCAL_MMDB_RECHECK_INTERVAL_MS = 60 * 1000;
  private static GEO_CONFIG_CACHE_TTL_MS = 5000;
  private static MEMORY_GEO_CACHE_MAX_ENTRIES = 50000;
  private static COUNTRY_MMDB_FILE = "GeoLite2-Country.mmdb";
  private static DEFAULT_LOCAL_MIN_REQUEST_INTERVAL_MS = 10;
  private static DEFAULT_METRICS_LOG_INTERVAL_MS = 60 * 1000;

  constructor(db: StatsDatabase) {
    this.db = db;
    this.localMinRequestIntervalMs = this.parseEnvMs(
      process.env.GEOIP_LOCAL_MIN_REQUEST_INTERVAL_MS,
      GeoIPService.DEFAULT_LOCAL_MIN_REQUEST_INTERVAL_MS,
    );
    this.enableCountryMmdbFallback = this.parseBooleanEnv(
      process.env.GEOIP_ENABLE_COUNTRY_MMDB_FALLBACK,
      false,
    );
    this.metricsLogIntervalMs = this.parseEnvMs(
      process.env.GEOIP_METRICS_LOG_INTERVAL_MS,
      GeoIPService.DEFAULT_METRICS_LOG_INTERVAL_MS,
    );
  }

  async getGeoLocation(ip: string): Promise<GeoLocation | null> {
    this.metrics.geoLookupCount += 1;
    this.maybeLogMetrics();

    if (this.isPrivateIP(ip)) {
      return {
        country: "LOCAL",
        country_name: "Local Network",
        city: "",
        asn: "",
        as_name: "Local Network",
        as_domain: "",
        continent: "LOCAL",
        continent_name: "Local Network",
      };
    }

    const memoryCached = this.memoryGeoCache.get(ip);
    if (memoryCached) {
      this.metrics.geoCacheHit += 1;
      return memoryCached;
    }

    this.metrics.geoDbReadCount += 1;
    const cached = this.db.getIPGeolocation(ip);
    if (cached) {
      // Cache hit should always win over previous transient failures.
      this.failedIPs.delete(ip);
      this.metrics.geoCacheHit += 1;
      const geo = {
        country: cached.country,
        country_name: cached.country_name,
        city: cached.city,
        asn: cached.asn,
        as_name: cached.as_name,
        as_domain: cached.as_domain,
        continent: cached.continent,
        continent_name: cached.continent_name,
      };
      this.setMemoryGeoCache(ip, geo);
      return geo;
    }

    this.metrics.geoCacheMiss += 1;

    const failedAt = this.failedIPs.get(ip);
    if (failedAt && Date.now() - failedAt < GeoIPService.FAIL_COOLDOWN_MS) {
      return null;
    }

    const pending = this.pendingQueries.get(ip);
    if (pending) {
      return pending;
    }

    const promise = this.queryWithQueue(ip);
    this.pendingQueries.set(ip, promise);

    try {
      return await promise;
    } finally {
      this.pendingQueries.delete(ip);
    }
  }

  private async queryWithQueue(ip: string): Promise<GeoLocation | null> {
    if (this.queue.length >= GeoIPService.MAX_QUEUE_SIZE) {
      console.warn(
        `[GeoIP] Queue overflow, dropping lookup for ${ip}. Max queue size: ${GeoIPService.MAX_QUEUE_SIZE}`,
      );
      return null;
    }
    return new Promise((resolve) => {
      this.queue.push({ ip, resolve });
      this.scheduleProcessing();
    });
  }

  private scheduleProcessing() {
    if (this.processorTimer || this.isProcessing) return;

    const intervalMs = this.getRequestIntervalMs();
    const delay = Math.max(0, intervalMs - (Date.now() - this.lastRequestTime));
    this.processorTimer = setTimeout(() => {
      this.processorTimer = null;
      this.processNext();
    }, delay);
  }

  private getRequestIntervalMs(): number {
    try {
      const config = this.getGeoLookupConfig();
      const useLocal = config.provider === "local" && config.localMmdbReady !== false;
      return useLocal
        ? this.localMinRequestIntervalMs
        : GeoIPService.ONLINE_MIN_REQUEST_INTERVAL_MS;
    } catch {
      return GeoIPService.ONLINE_MIN_REQUEST_INTERVAL_MS;
    }
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const item = this.queue.shift()!;

    try {
      const result = await this.queryGeo(item.ip);
      this.lastRequestTime = Date.now();
      item.resolve(result);
    } catch (err) {
      console.error(`[GeoIP] Error querying ${item.ip}:`, err);
      item.resolve(null);
    } finally {
      this.isProcessing = false;
      this.cleanupFailedIPs();
      if (this.queue.length > 0) {
        this.scheduleProcessing();
      }
    }
  }

  private cleanupFailedIPs() {
    const now = Date.now();
    if (now - this.lastFailedIPsCleanup < GeoIPService.FAILED_IPS_CLEANUP_INTERVAL_MS) return;
    this.lastFailedIPsCleanup = now;
    for (const [ip, failedAt] of this.failedIPs) {
      if (now - failedAt > GeoIPService.FAIL_COOLDOWN_MS) {
        this.failedIPs.delete(ip);
      }
    }
  }

  private async queryGeo(ip: string): Promise<GeoLocation | null> {
    const config = this.getGeoLookupConfig();
    const useLocal = config.provider === "local" && config.localMmdbReady !== false;
    if (useLocal) {
      const localResult = await this.queryLocalMMDB(ip, config);
      if (localResult) {
        return localResult;
      }
      // Local mode fallback: MMDB missing/invalid or lookup failed, use online API.
      return this.queryOnlineAPI(ip, config);
    }
    return this.queryOnlineAPI(ip, config);
  }

  private async queryOnlineAPI(
    ip: string,
    config: GeoLookupConfig,
  ): Promise<GeoLocation | null> {
    const lookupUrl = this.buildLookupUrl(config.onlineApiUrl, ip);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const response = await fetch(lookupUrl, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          console.error(`[GeoIP] Online API error for ${ip}: ${response.status}`);
          this.failedIPs.set(ip, Date.now());
          return null;
        }

        const data = (await response.json()) as GeoIPApiResponse;
        const isReserved = data.reserved === true;

        const geo: GeoLocation = isReserved
          ? {
            country: "RESERVED",
            country_name: "Reserved IP",
            city: "",
            asn: "",
            as_name: "Reserved IP",
            as_domain: "",
            continent: "RESERVED",
            continent_name: "Reserved",
          }
          : {
            country: this.toStringValue(data.country, "Unknown"),
            country_name: this.toStringValue(data.country_name, "Unknown"),
            city: this.toStringValue(data.city, ""),
            asn: this.toStringValue(data.asn, ""),
            as_name: this.toStringValue(data.as_name, ""),
            as_domain: this.toStringValue(data.as_domain, ""),
            continent: this.toStringValue(data.continent, "Unknown"),
            continent_name: this.toStringValue(data.continent_name, "Unknown"),
          };

        this.db.saveIPGeolocation(ip, geo);
        this.setMemoryGeoCache(ip, geo);
        this.failedIPs.delete(ip);
        return geo;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.error(`[GeoIP] Online API query failed for ${ip}:`, err);
      this.failedIPs.set(ip, Date.now());
      return null;
    }
  }

  private async queryLocalMMDB(
    ip: string,
    config: GeoLookupConfig,
  ): Promise<GeoLocation | null> {
    this.metrics.localMmdbQueryCount += 1;

    if (!maxmind.validate(ip)) {
      this.failedIPs.set(ip, Date.now());
      return null;
    }

    try {
      const readers = await this.ensureLocalMmdbReaders(config.mmdbDir);
      if (!readers) {
        this.failedIPs.set(ip, Date.now());
        return null;
      }

      const cityData = readers.cityReader.get(ip);
      const asnData = readers.asnReader.get(ip);
      const countryData = readers.countryReader?.get(ip) || null;

      const countryCode =
        cityData?.country?.iso_code ||
        countryData?.country?.iso_code ||
        "Unknown";
      const countryName =
        this.pickLocalizedName(cityData?.country?.names) ||
        this.pickLocalizedName(countryData?.country?.names) ||
        countryCode;
      const continentCode =
        cityData?.continent?.code ||
        countryData?.continent?.code ||
        "Unknown";
      const continentName =
        this.pickLocalizedName(cityData?.continent?.names) ||
        this.pickLocalizedName(countryData?.continent?.names) ||
        "Unknown";
      const cityName =
        this.pickLocalizedName(cityData?.city?.names) || "";

      const asnNumber =
        asnData?.autonomous_system_number ??
        cityData?.traits?.autonomous_system_number ??
        countryData?.traits?.autonomous_system_number;
      const asnOrg =
        asnData?.autonomous_system_organization ||
        cityData?.traits?.autonomous_system_organization ||
        countryData?.traits?.autonomous_system_organization ||
        "";
      const asDomain =
        cityData?.traits?.domain ||
        countryData?.traits?.domain ||
        "";

      const geo: GeoLocation = {
        country: countryCode,
        country_name: countryName || "Unknown",
        city: cityName,
        asn: typeof asnNumber === "number" ? `AS${asnNumber}` : "",
        as_name: asnOrg,
        as_domain: asDomain,
        continent: continentCode,
        continent_name: continentName,
      };

      this.db.saveIPGeolocation(ip, geo);
      this.setMemoryGeoCache(ip, geo);
      this.failedIPs.delete(ip);
      return geo;
    } catch (err) {
      console.error(`[GeoIP] Local MMDB query failed for ${ip}:`, err);
      this.failedIPs.set(ip, Date.now());
      return null;
    }
  }

  private async ensureLocalMmdbReaders(mmdbDir: string): Promise<LocalMmdbReaders | null> {
    const targetDir = path.resolve(mmdbDir || path.join(process.cwd(), "geoip"));

    const current = this.localMmdbReaders;
    if (current?.mmdbDir === targetDir) {
      const now = Date.now();
      if (now - this.lastLocalMmdbCheckMs < GeoIPService.LOCAL_MMDB_RECHECK_INTERVAL_MS) {
        return current;
      }
      this.lastLocalMmdbCheckMs = now;

      const cityMtimeMs = this.getFileMtimeMs(current.cityPath);
      const asnMtimeMs = this.getFileMtimeMs(current.asnPath);
      const countryMtimeMs = current.countryPath ? this.getFileMtimeMs(current.countryPath) : null;
      const unchanged =
        cityMtimeMs !== null &&
        asnMtimeMs !== null &&
        cityMtimeMs === current.cityMtimeMs &&
        asnMtimeMs === current.asnMtimeMs &&
        countryMtimeMs === current.countryMtimeMs;
      if (unchanged) {
        return current;
      }

      console.log(`[GeoIP] MMDB files changed, reloading from ${targetDir}`);
      this.localMmdbReaders = null;
    }

    if (this.localMmdbLoadPromise) {
      return this.localMmdbLoadPromise;
    }

    this.localMmdbLoadPromise = this.loadLocalMmdbReaders(targetDir)
      .finally(() => {
        this.localMmdbLoadPromise = null;
      });

    return this.localMmdbLoadPromise;
  }

  private async loadLocalMmdbReaders(mmdbDir: string): Promise<LocalMmdbReaders | null> {
    const [cityMmdbFile, asnMmdbFile] = ConfigRepository.REQUIRED_MMDB_FILES;
    const cityPath = path.join(mmdbDir, cityMmdbFile);
    const asnPath = path.join(mmdbDir, asnMmdbFile);
    const countryPath = path.join(mmdbDir, GeoIPService.COUNTRY_MMDB_FILE);

    if (!fs.existsSync(cityPath) || !fs.existsSync(asnPath)) {
      console.error(
        `[GeoIP] Missing MMDB file(s) in ${mmdbDir}. Required: ${ConfigRepository.REQUIRED_MMDB_FILES.join(", ")}`,
      );
      return null;
    }

    const cityMtimeMs = this.getFileMtimeMs(cityPath);
    const asnMtimeMs = this.getFileMtimeMs(asnPath);
    const countryMtimeMs = this.enableCountryMmdbFallback && fs.existsSync(countryPath)
      ? this.getFileMtimeMs(countryPath)
      : null;
    if (cityMtimeMs === null || asnMtimeMs === null) {
      console.error(`[GeoIP] Failed to stat required MMDB files under ${mmdbDir}`);
      return null;
    }

    const [cityReader, asnReader, countryReader] = await Promise.all([
      maxmind.open<CityResponse>(cityPath),
      maxmind.open<AsnResponse>(asnPath),
      countryMtimeMs !== null
        ? maxmind.open<CountryResponse>(countryPath)
        : Promise.resolve(null),
    ]);

    this.localMmdbReaders = {
      mmdbDir,
      cityPath,
      asnPath,
      countryPath: countryMtimeMs !== null ? countryPath : null,
      cityMtimeMs,
      asnMtimeMs,
      countryMtimeMs,
      cityReader,
      asnReader,
      countryReader,
    };
    this.lastLocalMmdbCheckMs = Date.now();

    console.log(`[GeoIP] Local MMDB loaded from ${mmdbDir}`);
    return this.localMmdbReaders;
  }

  private getFileMtimeMs(filePath: string): number | null {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  private parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
  }

  private parseEnvMs(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return parsed;
  }

  private maybeLogMetrics(): void {
    if (this.metricsLogIntervalMs <= 0) {
      return;
    }

    const now = Date.now();
    const elapsedMs = now - this.metricsWindowStartedAt;
    if (elapsedMs < this.metricsLogIntervalMs) {
      return;
    }

    const elapsedSec = Math.max(1, elapsedMs / 1000);
    const qps = this.metrics.geoLookupCount / elapsedSec;
    const cacheTotal = this.metrics.geoCacheHit + this.metrics.geoCacheMiss;
    const cacheHitRate =
      cacheTotal > 0 ? (this.metrics.geoCacheHit / cacheTotal) * 100 : 0;

    console.info(
      `[GeoIP Metrics] geo_lookup_qps=${qps.toFixed(2)} local_mmdb_query_count=${this.metrics.localMmdbQueryCount} geo_cache_hit=${this.metrics.geoCacheHit} geo_cache_miss=${this.metrics.geoCacheMiss} geo_cache_hit_rate=${cacheHitRate.toFixed(1)}% geo_db_read_count=${this.metrics.geoDbReadCount} window_sec=${elapsedSec.toFixed(1)}`,
    );

    this.metricsWindowStartedAt = now;
    this.metrics = {
      geoLookupCount: 0,
      localMmdbQueryCount: 0,
      geoCacheHit: 0,
      geoCacheMiss: 0,
      geoDbReadCount: 0,
    };
  }

  private buildLookupUrl(baseUrl: string, ip: string): string {
    const url = new URL(baseUrl);
    url.searchParams.set("ip", ip);
    if (!url.searchParams.has("meituan")) {
      url.searchParams.set("meituan", "false");
    }
    return url.toString();
  }

  private pickLocalizedName(names: unknown): string {
    if (!names || typeof names !== "object") return "";
    const record = names as Record<string, unknown>;
    if (typeof record.en === "string" && record.en) return record.en;
    if (typeof record["zh-CN"] === "string" && record["zh-CN"]) return record["zh-CN"];
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value) return value;
    }
    return "";
  }

  private toStringValue(value: unknown, fallback: string): string {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
    return fallback;
  }

  private isPrivateIP(ip: string): boolean {
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^0\./,
      /^255\./,
      /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,
    ];

    const normalized = ip.toLowerCase();
    if (normalized.includes(":")) {
      if (normalized === "::1") {
        return true;
      }
      if (normalized.startsWith("::ffff:")) {
        const mappedIPv4 = normalized.slice("::ffff:".length);
        return privateRanges.some((range) => range.test(mappedIPv4));
      }
      return (
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80")
      );
    }

    return privateRanges.some((range) => range.test(normalized));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getGeoLookupConfig(): GeoLookupConfig {
    const now = Date.now();
    if (
      this.geoLookupConfigCache &&
      now - this.geoLookupConfigCache.checkedAt < GeoIPService.GEO_CONFIG_CACHE_TTL_MS
    ) {
      return this.geoLookupConfigCache.value;
    }

    const value = this.db.getGeoLookupConfig();
    this.geoLookupConfigCache = { value, checkedAt: now };
    return value;
  }

  private setMemoryGeoCache(ip: string, geo: GeoLocation): void {
    this.memoryGeoCache.set(ip, geo);
    if (this.memoryGeoCache.size <= GeoIPService.MEMORY_GEO_CACHE_MAX_ENTRIES) {
      return;
    }

    const overflow = this.memoryGeoCache.size - GeoIPService.MEMORY_GEO_CACHE_MAX_ENTRIES;
    for (let i = 0; i < overflow; i += 1) {
      const oldestKey = this.memoryGeoCache.keys().next().value;
      if (!oldestKey) break;
      this.memoryGeoCache.delete(oldestKey);
    }
  }

  async bulkQueryIPs(ips: string[]): Promise<void> {
    const uniqueIPs = [...new Set(ips)].filter((ip) => !this.isPrivateIP(ip));
    const config = this.getGeoLookupConfig();
    const useLocal = config.provider === "local" && config.localMmdbReady !== false;
    const delayMs = useLocal ? this.localMinRequestIntervalMs : 150;

    for (const ip of uniqueIPs) {
      if (this.memoryGeoCache.has(ip)) {
        continue;
      }
      await this.getGeoLocation(ip);
      if (delayMs > 0) {
        await this.sleep(delayMs);
      }
    }
  }

  destroy(): void {
    if (this.processorTimer) {
      clearTimeout(this.processorTimer);
      this.processorTimer = null;
    }

    for (const item of this.queue) {
      item.resolve(null);
    }
    this.queue = [];

    this.pendingQueries.clear();
    this.memoryGeoCache.clear();
    this.failedIPs.clear();
    this.geoLookupConfigCache = null;
    this.localMmdbLoadPromise = null;
    this.localMmdbReaders = null;
    this.isProcessing = false;
  }
}
