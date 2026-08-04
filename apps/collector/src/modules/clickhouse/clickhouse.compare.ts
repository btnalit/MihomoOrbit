import type { StatsDatabase } from '../db/db.js';
import { loadClickHouseConfig } from './clickhouse.config.js';

export class ClickHouseCompareService {
  private readonly config = loadClickHouseConfig();
  private timer: NodeJS.Timeout | null = null;
  private readonly enabled =
    this.config.enabled && process.env.CH_COMPARE_ENABLED === '1';
  private readonly intervalMs = Math.max(
    30_000,
    Number.parseInt(process.env.CH_COMPARE_INTERVAL_MS || '120000', 10) || 120_000,
  );
  private readonly windowMinutes = Math.max(
    1,
    Number.parseInt(process.env.CH_COMPARE_WINDOW_MINUTES || '10', 10) || 10,
  );
  private readonly timeoutMs = Math.max(
    1000,
    Number.parseInt(process.env.CH_COMPARE_TIMEOUT_MS || '8000', 10) || 8000,
  );
  private readonly startDelayMs = Math.max(
    0,
    Number.parseInt(process.env.CH_COMPARE_START_DELAY_MS || '120000', 10) || 120_000,
  );
  private startedAt = Date.now();

  constructor(private readonly db: StatsDatabase) {}

  start(): void {
    if (!this.enabled) {
      return;
    }
    if (this.timer) return;

    console.info(
      `[ClickHouse Compare] Started interval=${this.intervalMs}ms window=${this.windowMinutes}m start_delay=${this.startDelayMs}ms`,
    );
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.info('[ClickHouse Compare] Stopped');
    }
  }

  private async runOnce(): Promise<void> {
    if (Date.now() - this.startedAt < this.startDelayMs) {
      return;
    }

    const backends = this.db
      .getListeningBackends()
      .filter((backend) => !backend.url.startsWith('agent://'));
    if (backends.length === 0) return;

    const end = new Date();
    const start = new Date(end.getTime() - this.windowMinutes * 60_000);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    for (const backend of backends) {
      try {
        const sqlite = this.db.getTrafficInRange(backend.id, startIso, endIso);
        const ch = await this.queryClickHouseTraffic(backend.id, start);

        const uploadDelta = this.ratioDelta(sqlite.upload, ch.upload);
        const downloadDelta = this.ratioDelta(sqlite.download, ch.download);

        console.info(
          `[ClickHouse Compare] backend=${backend.id} window=${this.windowMinutes}m sqlite_upload=${sqlite.upload} ch_upload=${ch.upload} upload_delta=${uploadDelta.toFixed(2)}% sqlite_download=${sqlite.download} ch_download=${ch.download} download_delta=${downloadDelta.toFixed(2)}%`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ClickHouse Compare] backend=${backend.id} compare failed: ${message}`);
      }
    }
  }

  private async queryClickHouseTraffic(
    backendId: number,
    start: Date,
  ): Promise<{ upload: number; download: number }> {
    const baseUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}`;
    const authHeader =
      this.config.password.length > 0
        ? `Basic ${Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64')}`
        : '';
    const query = `
SELECT
  toUInt64(COALESCE(SUM(upload), 0)) as upload,
  toUInt64(COALESCE(SUM(download), 0)) as download
FROM ${this.config.database}.traffic_agg_buffer
WHERE backend_id = ${backendId}
  AND minute >= toDateTime('${this.toClickHouseDateTime(start)}')
FORMAT JSON
`;

    const response = await fetch(
      `${baseUrl}/?database=${encodeURIComponent(this.config.database)}&query=${encodeURIComponent(query)}`,
      {
        method: 'POST',
        headers: {
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`status=${response.status} body=${body.slice(0, 160)}`);
    }
    const json = (await response.json()) as {
      data?: Array<{ upload: number; download: number }>;
    };
    const row = json.data?.[0] || { upload: 0, download: 0 };
    return {
      upload: Number(row.upload || 0),
      download: Number(row.download || 0),
    };
  }

  private ratioDelta(a: number, b: number): number {
    if (a === 0 && b === 0) return 0;
    const denom = Math.max(1, Math.abs(a));
    return ((b - a) / denom) * 100;
  }

  private toClickHouseDateTime(value: Date): string {
    const iso = value.toISOString();
    return `${iso.slice(0, 19).replace('T', ' ')}`;
  }
}
