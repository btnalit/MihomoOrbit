/**
 * Country Repository
 *
 * Handles country traffic statistics queries and updates.
 */
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.repository.js';

export interface CountryStatsRow {
  country: string;
  countryName: string;
  continent: string;
  totalUpload: number;
  totalDownload: number;
  totalConnections: number;
}

export class CountryRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  getCountryStats(backendId: number, limit = 50, start?: string, end?: string): CountryStatsRow[] {
    const range = this.parseMinuteRange(start, end);
    if (range) {
      const resolved = this.resolveCountryFactTable(start!, end!);
      const minuteCountryStmt = this.db.prepare(`
        SELECT country, MAX(country_name) as countryName, MAX(continent) as continent,
               SUM(upload) as totalUpload, SUM(download) as totalDownload, SUM(connections) as totalConnections
        FROM ${resolved.table}
        WHERE backend_id = ? AND ${resolved.timeCol} >= ? AND ${resolved.timeCol} <= ?
        GROUP BY country
        ORDER BY (SUM(upload) + SUM(download)) DESC
        LIMIT ?
      `);
      const minuteCountryRows = minuteCountryStmt.all(backendId, resolved.startKey, resolved.endKey, limit) as CountryStatsRow[];
      if (minuteCountryRows.length > 0) return minuteCountryRows;

      // Fallback 1: derive from dim_stats + geoip_cache
      const dimResolved = this.resolveFactTable(start!, end!);
      const minuteDimFallbackStmt = this.db.prepare(`
        SELECT
          COALESCE(g.country, 'UNKNOWN') as country,
          COALESCE(MAX(g.country_name), 'Unknown') as countryName,
          COALESCE(MAX(g.continent), 'Unknown') as continent,
          SUM(m.upload) as totalUpload, SUM(m.download) as totalDownload, SUM(m.connections) as totalConnections
        FROM ${dimResolved.table} m
        LEFT JOIN geoip_cache g ON m.ip = g.ip
        WHERE m.backend_id = ? AND m.${dimResolved.timeCol} >= ? AND m.${dimResolved.timeCol} <= ? AND m.ip != ''
        GROUP BY COALESCE(g.country, 'UNKNOWN')
        ORDER BY (SUM(m.upload) + SUM(m.download)) DESC
        LIMIT ?
      `);
      const minuteDimFallbackRows = minuteDimFallbackStmt.all(backendId, dimResolved.startKey, dimResolved.endKey, limit) as CountryStatsRow[];
      if (minuteDimFallbackRows.length > 0) return minuteDimFallbackRows;

      // Fallback 2: aggregate from minute_stats as UNKNOWN
      const minuteRange = this.parseMinuteRange(start, end)!;
      const totalStmt = this.db.prepare(`
        SELECT COALESCE(SUM(upload), 0) as upload, COALESCE(SUM(download), 0) as download, COALESCE(SUM(connections), 0) as connections
        FROM minute_stats WHERE backend_id = ? AND minute >= ? AND minute <= ?
      `);
      const total = totalStmt.get(backendId, minuteRange.startMinute, minuteRange.endMinute) as { upload: number; download: number; connections: number };
      if (total.upload > 0 || total.download > 0 || total.connections > 0) {
        return [{ country: 'UNKNOWN', countryName: 'Unknown', continent: 'Unknown', totalUpload: total.upload, totalDownload: total.download, totalConnections: total.connections }];
      }
      return [];
    }

    const stmt = this.db.prepare(`
      SELECT country, country_name as countryName, continent,
             total_upload as totalUpload, total_download as totalDownload, total_connections as totalConnections
      FROM country_stats WHERE backend_id = ?
      ORDER BY (total_upload + total_download) DESC
      LIMIT ?
    `);
    return stmt.all(backendId, limit) as CountryStatsRow[];
  }

  updateCountryStats(
    backendId: number,
    country: string,
    countryName: string,
    continent: string,
    upload: number,
    download: number,
    timestampMs?: number,
    connections = 1,
  ): void {
    const normalizedConnections = Math.max(0, Math.floor(connections));
    const stmt = this.db.prepare(`
      INSERT INTO country_stats (backend_id, country, country_name, continent, total_upload, total_download, total_connections, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(backend_id, country) DO UPDATE SET
        total_upload = total_upload + ?, total_download = total_download + ?,
        total_connections = total_connections + ?, last_seen = CURRENT_TIMESTAMP
    `);
    stmt.run(
      backendId,
      country,
      countryName,
      continent,
      upload,
      download,
      normalizedConnections,
      upload,
      download,
      normalizedConnections,
    );

    const now = new Date(timestampMs ?? Date.now());
    const minute = this.toMinuteKey(now);
    const hour = this.toHourKey(now);

    this.db.prepare(`
      INSERT INTO minute_country_stats (backend_id, minute, country, country_name, continent, upload, download, connections)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, minute, country) DO UPDATE SET
        upload = upload + ?, download = download + ?, connections = connections + ?
    `).run(
      backendId,
      minute,
      country,
      countryName,
      continent,
      upload,
      download,
      normalizedConnections,
      upload,
      download,
      normalizedConnections,
    );

    this.db.prepare(`
      INSERT INTO hourly_country_stats (backend_id, hour, country, country_name, continent, upload, download, connections)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, hour, country) DO UPDATE SET
        upload = upload + ?, download = download + ?, connections = connections + ?
    `).run(
      backendId,
      hour,
      country,
      countryName,
      continent,
      upload,
      download,
      normalizedConnections,
      upload,
      download,
      normalizedConnections,
    );
  }

  batchUpdateCountryStats(backendId: number, results: Array<{
    country: string; countryName: string; continent: string;
    upload: number; download: number; connections?: number; timestampMs?: number;
  }>): void {
    if (results.length === 0) return;

    const cumulativeStmt = this.db.prepare(`
      INSERT INTO country_stats (backend_id, country, country_name, continent, total_upload, total_download, total_connections, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(backend_id, country) DO UPDATE SET
        total_upload = total_upload + ?, total_download = total_download + ?,
        total_connections = total_connections + ?, last_seen = CURRENT_TIMESTAMP
    `);

    const minuteStmt = this.db.prepare(`
      INSERT INTO minute_country_stats (backend_id, minute, country, country_name, continent, upload, download, connections)
      VALUES (@backendId, @minute, @country, @countryName, @continent, @upload, @download, @connections)
      ON CONFLICT(backend_id, minute, country) DO UPDATE SET
        upload = upload + @upload, download = download + @download, connections = connections + @connections
    `);

    const hourlyStmt = this.db.prepare(`
      INSERT INTO hourly_country_stats (backend_id, hour, country, country_name, continent, upload, download, connections)
      VALUES (@backendId, @hour, @country, @countryName, @continent, @upload, @download, @connections)
      ON CONFLICT(backend_id, hour, country) DO UPDATE SET
        upload = upload + @upload, download = download + @download, connections = connections + @connections
    `);

    const tx = this.db.transaction(() => {
      const minuteMap = new Map<string, {
        minute: string; country: string; countryName: string; continent: string;
        upload: number; download: number; connections: number;
      }>();
      const hourlyMap = new Map<string, {
        hour: string; country: string; countryName: string; continent: string;
        upload: number; download: number; connections: number;
      }>();

      for (const r of results) {
        const connections = Math.max(0, Math.floor(r.connections ?? 1));
        cumulativeStmt.run(
          backendId,
          r.country,
          r.countryName,
          r.continent,
          r.upload,
          r.download,
          connections,
          r.upload,
          r.download,
          connections,
        );
        const now = new Date(r.timestampMs ?? Date.now());
        const minute = this.toMinuteKey(now);
        const hour = this.toHourKey(now);

        const minuteKey = `${minute}:${r.country}`;
        const existing = minuteMap.get(minuteKey);
        if (existing) {
          existing.upload += r.upload;
          existing.download += r.download;
          existing.connections += connections;
        } else {
          minuteMap.set(minuteKey, { minute, country: r.country, countryName: r.countryName, continent: r.continent, upload: r.upload, download: r.download, connections });
        }

        const hourlyKey = `${hour}:${r.country}`;
        const existingHourly = hourlyMap.get(hourlyKey);
        if (existingHourly) {
          existingHourly.upload += r.upload;
          existingHourly.download += r.download;
          existingHourly.connections += connections;
        } else {
          hourlyMap.set(hourlyKey, { hour, country: r.country, countryName: r.countryName, continent: r.continent, upload: r.upload, download: r.download, connections });
        }
      }

      for (const [, item] of minuteMap) {
        minuteStmt.run({ backendId, ...item });
      }
      for (const [, item] of hourlyMap) {
        hourlyStmt.run({ backendId, ...item });
      }
    });
    tx();
  }
}
