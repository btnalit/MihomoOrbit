export type ClickHouseProtocol = 'http' | 'https';

export interface ClickHouseConfig {
  enabled: boolean;
  required: boolean;
  protocol: ClickHouseProtocol;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export function loadClickHouseConfig(): ClickHouseConfig {
  const enabled = process.env.CH_ENABLED === '1';
  const required = process.env.CH_REQUIRED === '1';
  const secure = process.env.CH_SECURE === '1';
  return {
    enabled,
    required,
    protocol: secure ? 'https' : 'http',
    host: process.env.CH_HOST || 'clickhouse',
    port: parsePositiveInt(process.env.CH_PORT, 8123),
    database: process.env.CH_DATABASE || 'neko_master',
    user: process.env.CH_USER || 'default',
    password: process.env.CH_PASSWORD || '',
    timeoutMs: parsePositiveInt(process.env.CH_CONNECT_TIMEOUT_MS, 5000),
    maxRetries: parsePositiveInt(process.env.CH_CONNECT_MAX_RETRIES, 5),
    retryDelayMs: parsePositiveInt(process.env.CH_CONNECT_RETRY_DELAY_MS, 2000),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function maskSecret(secret: string): string {
  if (!secret) return '(empty)';
  if (secret.length <= 4) return '****';
  return `${secret.slice(0, 2)}****${secret.slice(-2)}`;
}

export function buildBaseUrl(config: ClickHouseConfig): string {
  return `${config.protocol}://${config.host}:${config.port}`;
}

export function formatClickHouseConfigForLog(config: ClickHouseConfig): string {
  return `enabled=${config.enabled ? '1' : '0'} required=${config.required ? '1' : '0'} endpoint=${buildBaseUrl(config)} database=${config.database} user=${config.user} password=${maskSecret(config.password)}`;
}

export async function ensureClickHouseReady(config: ClickHouseConfig): Promise<void> {
  if (!config.enabled) {
    console.info('[ClickHouse] Integration disabled (CH_ENABLED != 1)');
    return;
  }

  const baseUrl = buildBaseUrl(config);
  const authHeader =
    config.password.length > 0
      ? `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`
      : '';

  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/ping`, {
        method: 'GET',
        headers: {
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      const body = await response.text();
      if (!response.ok || body.trim() !== 'Ok.') {
        throw new Error(`unexpected /ping response: status=${response.status} body=${body.slice(0, 120)}`);
      }

      const dbCheck = await fetch(
        `${baseUrl}/?database=${encodeURIComponent(config.database)}&query=${encodeURIComponent('SELECT 1')}`,
        {
          method: 'GET',
          headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          signal: AbortSignal.timeout(config.timeoutMs),
        },
      );
      if (!dbCheck.ok) {
        const dbBody = await dbCheck.text();
        throw new Error(`database check failed: status=${dbCheck.status} body=${dbBody.slice(0, 160)}`);
      }

      console.info(`[ClickHouse] Ready at ${baseUrl}, database=${config.database}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= config.maxRetries) {
        if (config.required) {
          throw new Error(`[ClickHouse] Not ready after ${attempt} attempts: ${message}`, { cause: error });
        }
        console.warn(`[ClickHouse] Not ready after ${attempt} attempts, continue with fallback: ${message}`);
        return;
      }

      console.warn(
        `[ClickHouse] Attempt ${attempt}/${config.maxRetries} failed: ${message}. Retry in ${config.retryDelayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, config.retryDelayMs));
    }
  }
}

export async function runClickHouseQuery(
  config: ClickHouseConfig,
  query: string,
): Promise<void> {
  await runClickHouseQueryWithResponse(config, query);
}

export async function runClickHouseTextQuery(
  config: ClickHouseConfig,
  query: string,
): Promise<string> {
  const response = await runClickHouseQueryWithResponse(config, query);
  return await response.text();
}

export async function runClickHouseQueryWithResponse(
  config: ClickHouseConfig,
  query: string,
): Promise<Response> {
  const baseUrl = buildBaseUrl(config);
  const authHeader =
    config.password.length > 0
      ? `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`
      : '';

  const response = await fetch(
    `${baseUrl}/?database=${encodeURIComponent(config.database)}&query=${encodeURIComponent(query)}`,
    {
      method: 'POST',
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`query failed: status=${response.status} body=${body.slice(0, 160)}`);
  }

  return response;
}

export async function ensureClickHouseSchema(config: ClickHouseConfig): Promise<void> {
  if (!config.enabled) {
    return;
  }
  if (process.env.CH_AUTO_CREATE_TABLES === '0') {
    console.info('[ClickHouse] Auto schema creation disabled (CH_AUTO_CREATE_TABLES=0)');
    return;
  }

  await runClickHouseQuery(config, `CREATE DATABASE IF NOT EXISTS ${config.database}`);

  await runClickHouseQuery(
    config,
    `
CREATE TABLE IF NOT EXISTS ${config.database}.traffic_minute (
  backend_id UInt32,
  minute DateTime,
  domain String,
  ip String,
  source_ip String,
  chain String,
  rule String,
  upload UInt64,
  download UInt64,
  connections UInt32
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (backend_id, minute, domain, ip, source_ip, chain, rule)
TTL minute + INTERVAL 90 DAY
SETTINGS index_granularity = 8192
`,
  );

  await runClickHouseQuery(
    config,
    `
CREATE TABLE IF NOT EXISTS ${config.database}.country_minute (
  backend_id UInt32,
  minute DateTime,
  country String,
  country_name String,
  continent String,
  upload UInt64,
  download UInt64,
  connections UInt32
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (backend_id, minute, country)
TTL minute + INTERVAL 90 DAY
SETTINGS index_granularity = 8192
`,
  );

  // Optimised tables — split by query pattern to reduce I/O
  // traffic_agg: lightweight SummingMergeTree for summary / trend / hourly queries
  await runClickHouseQuery(
    config,
    `
CREATE TABLE IF NOT EXISTS ${config.database}.traffic_agg (
  backend_id UInt32,
  minute DateTime,
  upload UInt64,
  download UInt64,
  connections UInt32
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (backend_id, minute)
TTL minute + INTERVAL 90 DAY
SETTINGS index_granularity = 8192
`,
  );

  // traffic_detail: full-dimension MergeTree for top-N / filter / rule-chain queries
  await runClickHouseQuery(
    config,
    `
CREATE TABLE IF NOT EXISTS ${config.database}.traffic_detail (
  backend_id UInt32,
  minute DateTime,
  domain String,
  ip String,
  source_ip String,
  chain String,
  rule String,
  upload UInt64,
  download UInt64,
  connections UInt32
) ENGINE = MergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (backend_id, minute, domain, ip)
TTL minute + INTERVAL 90 DAY
SETTINGS index_granularity = 8192
`,
  );
  // Buffer tables — data is written to memory first, then auto-flushed to the
  // underlying MergeTree tables.  This reduces INSERT frequency from ~40/min to
  // ~2/min and dramatically reduces ClickHouse background merge I/O.
  //
  // Buffer(database, destination_table, num_layers,
  //        min_time, max_time,
  //        min_rows, max_rows,
  //        min_bytes, max_bytes)
  await runClickHouseQuery(
    config,
    `
CREATE TABLE IF NOT EXISTS ${config.database}.traffic_agg_buffer AS ${config.database}.traffic_agg
ENGINE = Buffer(
  '${config.database}', 'traffic_agg', 4,
  10, 60,
  100, 10000,
  10000, 1000000
)
`,
  );

  await runClickHouseQuery(
    config,
    `
CREATE TABLE IF NOT EXISTS ${config.database}.traffic_detail_buffer AS ${config.database}.traffic_detail
ENGINE = Buffer(
  '${config.database}', 'traffic_detail', 4,
  10, 60,
  100, 10000,
  10000, 1000000
)
`,
  );

  await runClickHouseQuery(
    config,
    `
CREATE TABLE IF NOT EXISTS ${config.database}.country_buffer AS ${config.database}.country_minute
ENGINE = Buffer(
  '${config.database}', 'country_minute', 4,
  10, 60,
  100, 10000,
  10000, 1000000
)
`,
  );

  console.info('[ClickHouse] Schema ensured (traffic_minute, country_minute, traffic_agg, traffic_detail, buffer tables)');
}
