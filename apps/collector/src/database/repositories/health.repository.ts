/**
 * Health Repository
 *
 * Persists periodic health-check results for each backend.
 * One row per (backend_id, minute), keyed on truncated ISO-8601 UTC minute.
 */
import type Database from 'better-sqlite3';

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface HealthLogRow {
  backend_id: number;
  minute: string;
  status: HealthStatus;
  latency_ms: number | null;
  server_latency_ms: number | null;
  message: string | null;
}

export class HealthRepository {
  constructor(private db: Database.Database) {}

  /**
   * Write (upsert) a health log entry for the current minute.
   * Multiple checks within the same minute are overwritten — last write wins.
   */
  writeHealthLog(
    backendId: number,
    minute: string,
    status: HealthStatus,
    latencyMs?: number,
    serverLatencyMs?: number,
    message?: string,
  ): void {
    this.db.prepare(`
      INSERT INTO backend_health_logs (backend_id, minute, status, latency_ms, server_latency_ms, message)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, minute) DO UPDATE SET
        status = excluded.status,
        latency_ms = excluded.latency_ms,
        server_latency_ms = excluded.server_latency_ms,
        message = excluded.message
    `).run(backendId, minute, status, latencyMs ?? null, serverLatencyMs ?? null, message ?? null);
  }

  /**
   * Return health log rows for a single backend within the given UTC ISO range.
   */
  getHealthHistory(
    backendId: number,
    fromISO: string,
    toISO: string,
  ): HealthLogRow[] {
    return this.db.prepare(`
      SELECT backend_id, minute, status, latency_ms, server_latency_ms, message
      FROM backend_health_logs
      WHERE backend_id = ? AND minute >= ? AND minute <= ?
      ORDER BY minute ASC
    `).all(backendId, fromISO, toISO) as HealthLogRow[];
  }

  /**
   * Return health log rows for all backends within the given UTC ISO range.
   */
  getHealthHistoryAll(fromISO: string, toISO: string): HealthLogRow[] {
    return this.db.prepare(`
      SELECT backend_id, minute, status, latency_ms, server_latency_ms, message
      FROM backend_health_logs
      WHERE minute >= ? AND minute <= ?
      ORDER BY backend_id ASC, minute ASC
    `).all(fromISO, toISO) as HealthLogRow[];
  }

  /**
   * Delete health log rows older than retentionDays for all backends.
   */
  pruneOldLogs(retentionDays: number): void {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
      .toISOString()
      .slice(0, 16); // "YYYY-MM-DDTHH:MM"
    this.db.prepare(`
      DELETE FROM backend_health_logs WHERE minute < ?
    `).run(cutoff);
  }

  /**
   * Delete all health logs for a specific backend (called on backend data clear).
   */
  deleteByBackend(backendId: number): void {
    this.db.prepare(
      `DELETE FROM backend_health_logs WHERE backend_id = ?`,
    ).run(backendId);
  }
}
