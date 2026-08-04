import Database from 'better-sqlite3';
import {
  ensureClickHouseReady,
  ensureClickHouseSchema,
  loadClickHouseConfig,
  runClickHouseQuery,
} from '../modules/clickhouse/clickhouse.config.js';

type CliOptions = {
  sqlitePath: string;
  from?: string;
  to?: string;
  batchSize: number;
  truncate: boolean;
};

type MinuteDimRow = {
  _rid: number;
  backend_id: number;
  minute: string;
  domain: string;
  ip: string;
  source_ip: string;
  chain: string;
  rule: string;
  upload: number;
  download: number;
  connections: number;
};

type MinuteCountryRow = {
  _rid: number;
  backend_id: number;
  minute: string;
  country: string;
  country_name: string;
  continent: string;
  upload: number;
  download: number;
  connections: number;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sqlitePath: process.env.DB_PATH || './stats.db',
    batchSize: 5000,
    truncate: false,
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
    if (arg === '--batch-size' && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.batchSize = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === '--truncate') {
      options.truncate = true;
      continue;
    }
  }

  return options;
}

function toClickHouseDateTime(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '1970-01-01 00:00:00';

  if (text.includes('T')) {
    return text.replace('T', ' ').replace('Z', '').slice(0, 19);
  }
  return text.slice(0, 19);
}

async function insertJsonRows(
  endpoint: string,
  authHeader: string,
  database: string,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;

  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  const query = `INSERT INTO ${database}.${table} FORMAT JSONEachRow`;
  const response = await fetch(
    `${endpoint}/?database=${encodeURIComponent(database)}&query=${encodeURIComponent(query)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body,
      signal: AbortSignal.timeout(20000),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `insert ${table} failed: status=${response.status} body=${text.slice(0, 200)}`,
    );
  }
}

async function migrateMinuteDim(
  db: Database.Database,
  options: CliOptions,
  endpoint: string,
  authHeader: string,
  database: string,
): Promise<number> {
  const filters: string[] = [];
  const baseParams: Array<string> = [];
  if (options.from) {
    filters.push('minute >= ?');
    baseParams.push(toClickHouseDateTime(options.from));
  }
  if (options.to) {
    filters.push('minute <= ?');
    baseParams.push(toClickHouseDateTime(options.to));
  }
  const filterClause = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

  const countStmt = db.prepare(
    `SELECT COUNT(*) as total FROM minute_dim_stats WHERE 1=1${
      filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''
    }`,
  );
  const total = Number((countStmt.get(...baseParams) as { total: number }).total || 0);
  console.info(`[Migrate] minute_dim_stats rows to migrate: ${total}`);

  const selectStmt = db.prepare(
    `SELECT
      rowid as _rid,
      backend_id,
      minute,
      domain,
      ip,
      source_ip,
      chain,
      rule,
      upload,
      download,
      connections
     FROM minute_dim_stats
     WHERE rowid > ?${filterClause}
     ORDER BY rowid ASC
     LIMIT ?`,
  );

  let lastRowId = 0;
  let migrated = 0;
  while (true) {
    const rows = selectStmt.all(
      lastRowId,
      ...baseParams,
      options.batchSize,
    ) as MinuteDimRow[];
    if (rows.length === 0) break;

    const payload = rows.map((row) => ({
      backend_id: row.backend_id,
      minute: toClickHouseDateTime(row.minute),
      domain: row.domain || '',
      ip: row.ip || '',
      source_ip: row.source_ip || '',
      chain: row.chain || '',
      rule: row.rule || '',
      upload: Math.max(0, Number(row.upload || 0)),
      download: Math.max(0, Number(row.download || 0)),
      connections: Math.max(0, Number(row.connections || 0)),
    }));

    await insertJsonRows(endpoint, authHeader, database, 'traffic_minute', payload);
    migrated += payload.length;
    lastRowId = rows[rows.length - 1]._rid;

    if (migrated % (options.batchSize * 5) === 0 || migrated === total) {
      console.info(`[Migrate] traffic_minute migrated=${migrated}/${total}`);
    }
  }

  return migrated;
}

async function migrateMinuteCountry(
  db: Database.Database,
  options: CliOptions,
  endpoint: string,
  authHeader: string,
  database: string,
): Promise<number> {
  const filters: string[] = [];
  const baseParams: Array<string> = [];
  if (options.from) {
    filters.push('minute >= ?');
    baseParams.push(toClickHouseDateTime(options.from));
  }
  if (options.to) {
    filters.push('minute <= ?');
    baseParams.push(toClickHouseDateTime(options.to));
  }
  const filterClause = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

  const countStmt = db.prepare(
    `SELECT COUNT(*) as total FROM minute_country_stats WHERE 1=1${
      filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''
    }`,
  );
  const total = Number((countStmt.get(...baseParams) as { total: number }).total || 0);
  console.info(`[Migrate] minute_country_stats rows to migrate: ${total}`);

  const selectStmt = db.prepare(
    `SELECT
      rowid as _rid,
      backend_id,
      minute,
      country,
      country_name,
      continent,
      upload,
      download,
      connections
     FROM minute_country_stats
     WHERE rowid > ?${filterClause}
     ORDER BY rowid ASC
     LIMIT ?`,
  );

  let lastRowId = 0;
  let migrated = 0;
  while (true) {
    const rows = selectStmt.all(
      lastRowId,
      ...baseParams,
      options.batchSize,
    ) as MinuteCountryRow[];
    if (rows.length === 0) break;

    const payload = rows.map((row) => ({
      backend_id: row.backend_id,
      minute: toClickHouseDateTime(row.minute),
      country: row.country || 'UNKNOWN',
      country_name: row.country_name || row.country || 'Unknown',
      continent: row.continent || 'Unknown',
      upload: Math.max(0, Number(row.upload || 0)),
      download: Math.max(0, Number(row.download || 0)),
      connections: Math.max(0, Number(row.connections || 0)),
    }));

    await insertJsonRows(endpoint, authHeader, database, 'country_minute', payload);
    migrated += payload.length;
    lastRowId = rows[rows.length - 1]._rid;

    if (migrated % (options.batchSize * 5) === 0 || migrated === total) {
      console.info(`[Migrate] country_minute migrated=${migrated}/${total}`);
    }
  }

  return migrated;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadClickHouseConfig();

  if (!config.enabled) {
    throw new Error('CH_ENABLED must be 1 when running migration script');
  }

  console.info(
    `[Migrate] start sqlite=${options.sqlitePath} from=${options.from || '-'} to=${options.to || '-'} batch_size=${options.batchSize} truncate=${options.truncate}`,
  );

  await ensureClickHouseReady(config);
  await ensureClickHouseSchema(config);

  if (options.truncate) {
    console.warn('[Migrate] --truncate enabled: clearing ClickHouse target tables');
    await runClickHouseQuery(config, `TRUNCATE TABLE ${config.database}.traffic_minute`);
    await runClickHouseQuery(config, `TRUNCATE TABLE ${config.database}.country_minute`);
  }

  const db = new Database(options.sqlitePath, { readonly: true });
  const endpoint = `${config.protocol}://${config.host}:${config.port}`;
  const authHeader =
    config.password.length > 0
      ? `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`
      : '';

  try {
    const migratedTraffic = await migrateMinuteDim(
      db,
      options,
      endpoint,
      authHeader,
      config.database,
    );
    const migratedCountry = await migrateMinuteCountry(
      db,
      options,
      endpoint,
      authHeader,
      config.database,
    );

    console.info(
      `[Migrate] completed traffic_minute=${migratedTraffic} country_minute=${migratedCountry}`,
    );
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Migrate] failed: ${message}`);
  process.exit(1);
});
