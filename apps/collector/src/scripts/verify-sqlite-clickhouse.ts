import Database from 'better-sqlite3';
import { ensureClickHouseReady, loadClickHouseConfig } from '../modules/clickhouse/clickhouse.config.js';

type CliOptions = {
  sqlitePath: string;
  from?: string;
  to?: string;
  maxDeltaPercent: number;
  failOnDelta: boolean;
};

type BackendRow = { id: number; name: string };

type Summary = {
  upload: number;
  download: number;
  connections: number;
  uniqueDomains: number;
  uniqueIPs: number;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sqlitePath: process.env.DB_PATH || './stats.db',
    maxDeltaPercent: Number.parseFloat(process.env.CH_VERIFY_MAX_DELTA_PERCENT || '1') || 1,
    failOnDelta: process.env.CH_VERIFY_FAIL_ON_DELTA === '1',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--sqlite' && next) {
      options.sqlitePath = next;
      i += 1;
      continue;
    }
    if (arg === '--from' && next) {
      options.from = next;
      i += 1;
      continue;
    }
    if (arg === '--to' && next) {
      options.to = next;
      i += 1;
      continue;
    }
    if (arg === '--max-delta' && next) {
      const parsed = Number.parseFloat(next);
      if (Number.isFinite(parsed) && parsed >= 0) {
        options.maxDeltaPercent = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === '--fail-on-delta') {
      options.failOnDelta = true;
      continue;
    }
  }

  return options;
}

function toDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid datetime: ${value}`);
  }
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function pctDelta(sqliteValue: number, chValue: number): number {
  if (sqliteValue === 0 && chValue === 0) return 0;
  const denom = Math.max(1, Math.abs(sqliteValue));
  return ((chValue - sqliteValue) / denom) * 100;
}

async function queryClickHouseSummary(
  endpoint: string,
  authHeader: string,
  database: string,
  backendId: number,
  from: string,
  to: string,
  timeoutMs: number,
): Promise<Summary> {
  const query = `
SELECT
  toUInt64(COALESCE(SUM(upload), 0)) AS upload,
  toUInt64(COALESCE(SUM(download), 0)) AS download,
  toUInt64(COALESCE(SUM(connections), 0)) AS connections,
  toUInt64(uniqExactIf(domain, domain != '')) AS uniqueDomains,
  toUInt64(uniqExactIf(ip, ip != '')) AS uniqueIPs
FROM ${database}.traffic_minute
WHERE backend_id = ${backendId}
  AND minute >= toDateTime('${from}')
  AND minute <= toDateTime('${to}')
FORMAT JSON
`;

  const response = await fetch(
    `${endpoint}/?database=${encodeURIComponent(database)}&query=${encodeURIComponent(query)}`,
    {
      method: 'POST',
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`status=${response.status} body=${body.slice(0, 160)}`);
  }

  const json = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const row = json.data?.[0] || {};
  return {
    upload: Number(row.upload || 0),
    download: Number(row.download || 0),
    connections: Number(row.connections || 0),
    uniqueDomains: Number(row.uniqueDomains || 0),
    uniqueIPs: Number(row.uniqueIPs || 0),
  };
}

function querySqliteSummary(
  db: Database.Database,
  backendId: number,
  from: string,
  to: string,
): Summary {
  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(upload), 0) AS upload,
      COALESCE(SUM(download), 0) AS download,
      COALESCE(SUM(connections), 0) AS connections,
      COUNT(DISTINCT CASE WHEN domain != '' THEN domain END) AS uniqueDomains,
      COUNT(DISTINCT CASE WHEN ip != '' THEN ip END) AS uniqueIPs
    FROM minute_dim_stats
    WHERE backend_id = ? AND minute >= ? AND minute <= ?
  `);
  const row = stmt.get(backendId, from, to) as Record<string, unknown>;
  return {
    upload: Number(row.upload || 0),
    download: Number(row.download || 0),
    connections: Number(row.connections || 0),
    uniqueDomains: Number(row.uniqueDomains || 0),
    uniqueIPs: Number(row.uniqueIPs || 0),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadClickHouseConfig();
  if (!config.enabled) {
    throw new Error('CH_ENABLED must be 1 when running verification');
  }

  await ensureClickHouseReady(config);

  const from = toDateTime(options.from || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const to = toDateTime(options.to || new Date().toISOString());

  const db = new Database(options.sqlitePath, { readonly: true });
  const backends = db
    .prepare(`SELECT id, name FROM backend_configs ORDER BY id ASC`)
    .all() as BackendRow[];

  const endpoint = `${config.protocol}://${config.host}:${config.port}`;
  const authHeader =
    config.password.length > 0
      ? `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`
      : '';

  let hasExceeded = false;
  try {
    console.info(
      `[Verify] sqlite=${options.sqlitePath} window=${from}..${to} max_delta=${options.maxDeltaPercent}% fail_on_delta=${options.failOnDelta ? '1' : '0'}`,
    );

    for (const backend of backends) {
      const sqlite = querySqliteSummary(db, backend.id, from, to);
      const ch = await queryClickHouseSummary(
        endpoint,
        authHeader,
        config.database,
        backend.id,
        from,
        to,
        config.timeoutMs,
      );

      const deltas = {
        upload: pctDelta(sqlite.upload, ch.upload),
        download: pctDelta(sqlite.download, ch.download),
        connections: pctDelta(sqlite.connections, ch.connections),
        uniqueDomains: pctDelta(sqlite.uniqueDomains, ch.uniqueDomains),
        uniqueIPs: pctDelta(sqlite.uniqueIPs, ch.uniqueIPs),
      };

      const exceeded = Object.values(deltas).some(
        (delta) => Math.abs(delta) > options.maxDeltaPercent,
      );
      if (exceeded) {
        hasExceeded = true;
      }

      console.info(
        `[Verify] backend=${backend.id}:${backend.name} sqlite(upload=${sqlite.upload},download=${sqlite.download},conn=${sqlite.connections},domains=${sqlite.uniqueDomains},ips=${sqlite.uniqueIPs}) ch(upload=${ch.upload},download=${ch.download},conn=${ch.connections},domains=${ch.uniqueDomains},ips=${ch.uniqueIPs}) delta(upload=${deltas.upload.toFixed(2)}%,download=${deltas.download.toFixed(2)}%,conn=${deltas.connections.toFixed(2)}%,domains=${deltas.uniqueDomains.toFixed(2)}%,ips=${deltas.uniqueIPs.toFixed(2)}%) status=${exceeded ? 'WARN' : 'OK'}`,
      );
    }
  } finally {
    db.close();
  }

  if (options.failOnDelta && hasExceeded) {
    throw new Error(
      `delta exceeded max threshold ${options.maxDeltaPercent}% for at least one backend`,
    );
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Verify] failed: ${message}`);
  process.exit(1);
});
