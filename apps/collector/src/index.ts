import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env.local if it exists (takes precedence over .env, but not shell)
const envLocalPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  config({ path: envLocalPath, quiet: true });
}

// Load .env (defaults)
config({ quiet: true });

import { StatsDatabase, BackendConfig } from './modules/db/db.js';
import { createCollector, GatewayCollector } from './modules/collector/gateway.collector.js';
import { createSurgeCollector, SurgeCollector } from './modules/collector/surge.collector.js';
import { isAgentSourced, shouldStartDirectCollector } from './modules/collector/orchestration.js';
import { StatsWebSocketServer } from './modules/websocket/websocket.server.js';
import { realtimeStore } from './modules/realtime/realtime.store.js';
import { SurgePolicySyncService } from './modules/surge/surge-policy-sync.js';
import { ManagementRelay } from './modules/management/ws-relay.js';

let wsServer: StatsWebSocketServer;
let managementRelay: ManagementRelay;

import { APIServer } from './modules/app/app.js';
import { AuthService } from './modules/auth/index.js';
import { GeoIPService } from './modules/geo/geo.service.js';
import { StatsService } from './modules/stats/index.js';
import {
  ensureClickHouseReady,
  ensureClickHouseSchema,
  formatClickHouseConfigForLog,
  loadClickHouseConfig,
} from './modules/clickhouse/clickhouse.config.js';
import { ClickHouseCompareService } from './modules/clickhouse/clickhouse.compare.js';
import { CleanupService, type CleanupOverrides } from './modules/cleanup/index.js';

const COLLECTOR_WS_PORT = parseInt(process.env.COLLECTOR_WS_PORT || '3002');
const API_PORT = parseInt(process.env.API_PORT || '3001');
// Web UI port — the bundled Next.js server, not this collector's own API
// port. Only used for the printed first-run setup URL (see [SETUP] below);
// the collector itself never listens on it. Matches the WEB_PORT naming used
// by setup.sh/Dockerfile/docker-compose.yml (default 3000).
const WEB_PORT = parseInt(process.env.WEB_PORT || '3000');
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'stats.db');

/**
 * Parse an integer retention env var. Returns undefined for unset/invalid values
 * so the service falls back to the DB-stored config or built-in defaults.
 */
function parseRetentionEnvDays(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(`[Cleanup] Ignoring invalid ${name}=${raw} (expected positive integer)`);
    return undefined;
  }
  return parsed;
}

function loadCleanupOverridesFromEnv(): CleanupOverrides {
  return {
    connectionLogsDays: parseRetentionEnvDays('SQLITE_RETENTION_MINUTE_DAYS'),
    hourlyStatsDays: parseRetentionEnvDays('SQLITE_RETENTION_HOURLY_DAYS'),
    healthLogDays: parseRetentionEnvDays('SQLITE_RETENTION_HEALTH_LOG_DAYS'),
  };
}

// Map of backend connections: backendId -> GatewayCollector | SurgeCollector
const collectors = new Map<number, GatewayCollector | SurgeCollector>();
let db: StatsDatabase;

let apiServer: APIServer;
let geoService: GeoIPService;
let policySyncService: SurgePolicySyncService;
let clickHouseCompareService: ClickHouseCompareService;
let cleanupService: CleanupService | undefined;

// Track last known backend configs to detect changes
let lastBackendConfigs: Map<number, BackendConfig> = new Map();

async function main() {
  console.log('[Main] Starting collector service...');

  const clickHouseConfig = loadClickHouseConfig();
  console.info(`[Main] ClickHouse config: ${formatClickHouseConfigForLog(clickHouseConfig)}`);
  await ensureClickHouseReady(clickHouseConfig);
  await ensureClickHouseSchema(clickHouseConfig);

  // Initialize database
  console.log('[Main] Initializing database at:', DB_PATH);
  db = new StatsDatabase(DB_PATH);

  // Connect realtimeStore to database for agent config persistence
  realtimeStore.setDatabase(db);

  clickHouseCompareService = new ClickHouseCompareService(db);
  clickHouseCompareService.start();

  // Initialize GeoIP service
  geoService = new GeoIPService(db);

  // Single shared AuthService for this process: both the HTTP API and the
  // WebSocket server verify tokens through this one instance, so
  // updateToken()/enableAuth() cache invalidation and the pre-auth per-IP
  // limiter apply to both surfaces immediately — otherwise a revoked token
  // could keep opening new WS connections for up to its own cache TTL. See I2.
  const authService = new AuthService(db);

  // Initialize WebSocket server for real-time updates
  console.log('[Main] Starting WebSocket server on port', COLLECTOR_WS_PORT);
  const statsService = new StatsService(db, realtimeStore);
  wsServer = new StatsWebSocketServer(COLLECTOR_WS_PORT, db, statsService, authService);
  wsServer.start();

  // Management relay (M1 Task 3): per-backend connections/logs upstream
  // fan-out over the same TopicHub the WS server's clients subscribe on.
  managementRelay = new ManagementRelay({ db, hub: wsServer.getTopicHub() });
  wsServer.setTopicHooks(managementRelay.hooks);
  wsServer.setSubscriberJoinedHook((ws, topic, backendId) =>
    managementRelay.onSubscriberJoined(ws, topic, backendId),
  );

  // Initialize policy sync service
  policySyncService = new SurgePolicySyncService(db);

  // Initialize API server
  console.log('[Main] Starting API server on port', API_PORT);
  apiServer = new APIServer(
    API_PORT,
    db,
    realtimeStore,
    policySyncService,
    geoService,
    (backendId: number) => {
      wsServer.broadcastStats(backendId);
    },
    (backendId: number) => {
      const collector = collectors.get(backendId) as
        | (GatewayCollector & { clearRuntimeState?: () => void })
        | (SurgeCollector & { clearRuntimeState?: () => void })
        | undefined;
      collector?.clearRuntimeState?.();
      wsServer.clearBackendCache(backendId);
      wsServer.broadcastStats(backendId, true);
    },
    authService,
    // Same TopicHub instance the WS server's clients subscribe on (see M1
    // Task 2 / m1-contracts.md) — ManagementService's group-delay-test
    // results must publish onto it, not a disconnected standalone hub.
    wsServer.getTopicHub(),
  );
  const apiFastifyApp = await apiServer.start();

  // Security posture warnings, printed once at boot so they're impossible to
  // miss in stdout/container logs. See M0 plan Task 8 / design spec 3.5(b, j).
  if (process.env.FORCE_ACCESS_CONTROL_OFF === 'true') {
    console.warn(
      '[SECURITY] FORCE_ACCESS_CONTROL_OFF is set — ALL authentication is bypassed. Remove it except for recovery.',
    );
  }
  if (apiFastifyApp?.authService.hasLegacyTokenHash()) {
    console.warn(
      '[SECURITY] The stored access token still uses the pre-M0 unsalted SHA-256 format. ' +
        'It is treated as unconfigured and must be re-set (see docs/migration-from-neko.md). ' +
        'While FORCE_ACCESS_CONTROL_OFF is set this prompt is bypassed and the weak token stays in place.',
    );
  }
  if (apiFastifyApp && !apiFastifyApp.authService.isConfigured()) {
    console.warn(
      `[SETUP] Authentication is not configured yet.\n` +
        // Web UI port, not this API's own port (API_PORT serves no UI) —
        // see I6 in the M0 review findings.
        `  Open  http://<host>:${WEB_PORT}/  and use this one-time setup token:\n` +
        `      ${apiFastifyApp.authService.getSetupToken()}\n` +
        `  It is regenerated on every restart and invalidated once setup completes.`,
    );
  }

  // Start backend management loop
  console.log('[Main] Starting backend management loop...');
  manageBackends();

  // Check for backend config changes every 5 seconds
  setInterval(manageBackends, 5000);

  // Start the retention cleanup service. Env vars (SQLITE_RETENTION_*) override
  // the DB-stored config for operators who prefer set-and-forget Docker deploys.
  cleanupService = new CleanupService(db, loadCleanupOverridesFromEnv());
  cleanupService.start();

  // Handle graceful shutdown
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

// Manage backend connections based on database configuration
async function manageBackends() {
  try {
    // Get current backend configs from database
    const backends = db.getAllBackends();
    const currentConfigs = new Map(backends.map(b => [b.id, b]));

    // Find backends that need to be started (listening=true but not connected)
    for (const backend of backends) {
      const existingCollector = collectors.get(backend.id);
      const lastConfig = lastBackendConfigs.get(backend.id);
      const isAgentBackend = isAgentSourced(backend);

      // Check if we need to start or restart this backend connection
      const needsStart = backend.listening && backend.enabled && !existingCollector && !isAgentBackend;
      const changedFields: string[] = [];
      if (existingCollector && lastConfig) {
        // Compare unified-model fields only — url/token are write-only rollback
        // mirrors (see semantic contract) and must never drive collector restarts.
        if (lastConfig.api_url !== backend.api_url) changedFields.push('api_url');
        if (lastConfig.api_secret !== backend.api_secret) changedFields.push('api_secret');
        if (lastConfig.agent_token !== backend.agent_token) changedFields.push('agent_token');
        if (lastConfig.type !== backend.type) changedFields.push('type');
        if (lastConfig.listening !== backend.listening) changedFields.push('listening');
        if (lastConfig.enabled !== backend.enabled) changedFields.push('enabled');
      }
      const needsRestart = changedFields.length > 0;

      if (needsRestart) {
        console.log(
          `[Backends] Restarting collector for backend "${backend.name}" (ID: ${backend.id}) — changed: ${changedFields.join(', ')}`,
        );
        stopCollector(backend.id);
      }

      if (needsStart || needsRestart) {
        if (backend.listening && backend.enabled && !isAgentBackend) {
          startCollector(backend);
        }
      }

      // Stop collectors for backends that are no longer listening or disabled
      if (existingCollector && (!backend.listening || !backend.enabled)) {
        console.log(`[Backends] Stopping collector for backend "${backend.name}" (ID: ${backend.id}) - listening=${backend.listening}, enabled=${backend.enabled}`);
        stopCollector(backend.id);
      }
    }

    // Stop collectors for deleted backends
    for (const [id, collector] of collectors) {
      if (!currentConfigs.has(id)) {
        console.log(`[Backends] Stopping collector for deleted backend (ID: ${id})`);
        stopCollector(id);
      }
    }

    // Update last known configs
    lastBackendConfigs = currentConfigs;
  } catch (error) {
    console.error('[Backends] Error managing backends:', error);
  }
}

// Start a collector for a specific backend
function startCollector(backend: BackendConfig) {
  if (isAgentSourced(backend)) {
    console.log(`[Collector] Backend "${backend.name}" (ID: ${backend.id}) is agent-sourced (agent_token set), skip direct pulling`);
    return;
  }

  if (collectors.has(backend.id)) {
    console.log(`[Collector] Backend "${backend.name}" (ID: ${backend.id}) already has a collector running`);
    return;
  }

  if (!shouldStartDirectCollector(backend)) {
    // Unified model: an API-created backend always has api_url and/or agent_token
    // set. This row has neither — unreachable via the current API, but skip
    // defensively rather than crash on an empty connection URL.
    console.warn(`[Collector] Backend "${backend.name}" (ID: ${backend.id}) has no api_url and no agent_token, skipping`);
    return;
  }

  console.log(`[Collector] Starting ${backend.type || 'clash'} collector for backend "${backend.name}" (ID: ${backend.id}) at ${backend.api_url}`);

  if (backend.type === 'surge') {
    // Start policy sync service for Surge
    const baseUrl = backend.api_url.replace(/\/$/, '');
    policySyncService.startSync(backend.id, baseUrl, backend.api_secret || undefined);

    // Create and start Surge collector (REST API polling)
    const collector = createSurgeCollector(
      db,
      backend.api_url,
      backend.api_secret || undefined,
      geoService,
      () => {
        // Broadcast stats update via WebSocket when new data arrives
        wsServer.broadcastStats(backend.id);
      },
      backend.id // Pass backend ID for data isolation
    );

    collectors.set(backend.id, collector);
    collector.start();
  } else {
    // Create and start Clash collector (WebSocket)
    let wsUrl = backend.api_url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
    if (!wsUrl.endsWith('/connections')) {
      wsUrl = `${wsUrl}/connections`;
    }

    const collector = createCollector(
      db,
      wsUrl,
      backend.api_secret || undefined,
      geoService,
      () => {
        // Broadcast stats update via WebSocket when new data arrives
        wsServer.broadcastStats(backend.id);
      },
      backend.id // Pass backend ID for data isolation
    );

    collectors.set(backend.id, collector);
    collector.connect();
  }
}

// Stop a collector for a specific backend
function stopCollector(backendId: number) {
  const collector = collectors.get(backendId);
  if (collector) {
    console.log(`[Collector] Stopping collector for backend ID: ${backendId}`);
    if (collector instanceof GatewayCollector) {
      collector.disconnect();
    } else {
      collector.stop();
    }
    collectors.delete(backendId);
  }
  
  // Also stop policy sync for this backend
  policySyncService.stopSync(backendId);
}

// Graceful shutdown
async function shutdown() {
  console.log('[Main] Shutting down...');

  // Stop all collectors and policy sync
  for (const [id, collector] of collectors) {
    console.log(`[Main] Disconnecting collector for backend ID: ${id}`);
    if (collector instanceof GatewayCollector) {
      collector.disconnect();
    } else {
      collector.stop();
    }
    policySyncService.stopSync(id);
  }
  collectors.clear();

  // Stop servers — await the API server so its onClose hook can flush
  // pending agent buffers before the database is closed.
  managementRelay?.stop();
  wsServer?.stop();
  try {
    await apiServer?.stop();
  } catch (err) {
    console.error('[Main] Error stopping API server:', err);
  }
  clickHouseCompareService?.stop();
  geoService?.destroy();

  // Stop retention cleanup
  cleanupService?.stop();

  // Close database
  db?.close();

  console.log('[Main] Shutdown complete');
  process.exit(0);
}

main().catch(console.error);
