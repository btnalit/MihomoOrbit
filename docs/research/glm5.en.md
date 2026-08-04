# Neko Master - Comprehensive Codebase Research Report

## Executive Summary

**Neko Master** is a modern network traffic analytics platform designed for edge gateways. It provides real-time monitoring, traffic auditing, and multi-gateway management capabilities. The system collects traffic data from Clash/Mihomo and Surge proxy gateways, aggregates it in SQLite, and visualizes it through a Next.js web interface.

---

## 1. Project Overview

### 1.1 Purpose & Scope

Neko Master serves as a traffic visibility layer for proxy gateways. It does NOT:
- Provide network access or proxy services
- Handle subscription management
- Perform traffic routing

It DOES:
- Collect and aggregate traffic statistics from gateways
- Provide real-time WebSocket updates to connected clients
- Offer historical traffic analysis and visualization
- Support multiple backend gateways simultaneously

### 1.2 Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS v4 |
| UI Components | shadcn/ui (new-york style), lucide-react icons |
| Charts | Recharts, D3.js, react-simple-maps |
| State Management | TanStack React Query, WebSocket hooks |
| Backend | Fastify 5, WebSocket (ws), better-sqlite3 |
| GeoIP | maxmind (local MMDB), online API fallback |
| i18n | next-intl (zh/en) |
| Build | Turbo monorepo, pnpm workspaces |
| Deployment | Docker, standalone Next.js output |

### 1.3 Repository Structure

```
neko-master/
├── apps/
│   ├── collector/           # Backend data collection service
│   │   └── src/
│   │       ├── index.ts        # Entry point, orchestrates all services
│   │       ├── app.ts          # Fastify API server
│   │       ├── websocket.ts    # WebSocket broadcast server
│   │       ├── collector.ts    # Clash WebSocket collector
│   │       ├── surge-collector.ts # Surge HTTP polling collector
│   │       ├── realtime.ts     # In-memory traffic aggregation
│   │       ├── batch-buffer.ts # Batch write optimization
│   │       ├── geo-service.ts  # GeoIP lookup service
│   │       ├── db.ts           # Database facade
│   │       └── database/
│   │           ├── schema.ts      # DDL definitions
│   │           └── repositories/  # Repository pattern implementations
│   │
│   └── web/                 # Next.js frontend
│       └── app/[locale]/
│           ├── dashboard/       # Main dashboard page
│           └── layout.tsx       # Root layout with providers
│
├── packages/
│   └── shared/              # Shared TypeScript types & utilities
│       └── src/
│           ├── index.ts        # Type exports
│           ├── gateway-utils.ts # Gateway API helpers
│           └── geo-ip-utils.ts  # GeoIP data normalization
│
└── docs/
    └── architecture.md      # Chinese architecture documentation
```

---

## 2. Core Architecture

### 2.1 High-Level Data Flow

```
┌─────────────────────┐
│  Clash / Mihomo     │──── WebSocket ────┐
│  Gateway            │                    │
└─────────────────────┘                    │
                                           ▼
┌─────────────────────┐            ┌─────────────────┐
│  Surge Gateway      │──── HTTP ──▶│  Collector      │
│                     │   Polling   │  Service        │
└─────────────────────┘            │  (Port 3001)    │
                                   └────────┬────────┘
                                            │
                              ┌─────────────┼─────────────┐
                              ▼             ▼             ▼
                        ┌──────────┐ ┌──────────┐ ┌──────────┐
                        │  SQLite  │ │ Realtime │ │   WS     │
                        │  (WAL)   │ │  Store   │ │ Server   │
                        └──────────┘ └──────────┘ │(Port 3002)│
                              │             │     └──────────┘
                              │             │          │
                              ▼             ▼          │
                        ┌─────────────────────────┐    │
                        │     Next.js Web UI      │◀───┘
                        │      (Port 3000)        │
                        └─────────────────────────┘
```

### 2.2 Three-Tier Architecture

1. **Frontend Tier** (Next.js)
   - React Query for HTTP API data fetching
   - WebSocket hook for real-time updates
   - Client-side state management

2. **Collector Tier** (Fastify + WebSocket)
   - REST API endpoints (`/api/*`)
   - WebSocket server for real-time push
   - Gateway collectors (Clash WS + Surge HTTP)

3. **Storage Tier** (SQLite + Memory)
   - SQLite with WAL mode for persistence
   - In-memory RealtimeStore for low-latency queries

---

## 3. Backend Deep Dive

### 3.1 Entry Point (`index.ts`)

The main entry point orchestrates all services:

1. **Database initialization** - Creates/opens SQLite database
2. **GeoIP service** - Initializes IP geolocation service
3. **WebSocket server** - Starts WS server on port 3002
4. **API server** - Starts Fastify on port 3001
5. **Backend management loop** - Polls every 5s for backend config changes
6. **Auto-cleanup job** - Runs every 6 hours for data retention

```typescript
// Key initialization sequence
async function main() {
  db = new StatsDatabase(DB_PATH);
  geoService = new GeoIPService(db);
  wsServer = new StatsWebSocketServer(COLLECTOR_WS_PORT, db);
  apiServer = new APIServer(API_PORT, db, realtimeStore, policySyncService);
  
  // Start collectors based on database config
  setInterval(manageBackends, 5000);
}
```

### 3.2 Clash Collector (`collector.ts`)

**Connection Protocol:**
- Connects to `ws://gateway:port/connections`
- Uses Bearer token authentication if provided
- Auto-reconnects on disconnect with 5s interval

**Traffic Tracking Algorithm:**

```
For each WebSocket message:
  1. Parse connections array
  2. For new connections:
     - Track initial traffic values
     - Record to batch buffer
     - Record to realtime store
  3. For existing connections:
     - Calculate delta: current - last
     - Record delta to buffer and realtime
     - Update last seen timestamp
  4. For disappeared connections:
     - Remove from tracking map
  5. Flush batch buffer if >= 5000 items
```

**Stale Connection Cleanup:**
- Removes connections not seen for 5 minutes
- Runs every 2 minutes

### 3.3 Surge Collector (`surge-collector.ts`)

**Different from Clash:**
- Uses HTTP polling (GET `/v1/requests/recent`) instead of WebSocket
- Default 2s polling interval
- Exponential backoff on errors (max 5 retries, up to 60s delay)

**Policy Path Extraction:**
Surge provides policy decision paths in the `notes` field:
```
"[Rule] Policy decision path: rule -> group1 -> group2 -> finalProxy"
```

This is parsed and reversed to match Clash's chain format:
```
chains = [finalProxy, ..., group2, group1, rule]
```

**Duplicate Prevention:**
- Uses `recentlyCompleted` Map with 5-minute TTL
- Prevents double-counting completed requests that may reappear in polls

### 3.4 RealtimeStore (`realtime.ts`)

The RealtimeStore is a critical component for low-latency queries. It maintains:

| Map | Purpose | Max Entries |
|-----|---------|-------------|
| `summaryByBackend` | Total upload/download/connections delta | Per backend |
| `minuteByBackend` | Per-minute traffic buckets | 180 minutes default |
| `domainByBackend` | Per-domain traffic deltas | 50,000 |
| `ipByBackend` | Per-IP traffic deltas | 50,000 |
| `proxyByBackend` | Per-proxy traffic deltas | Unlimited |
| `deviceByBackend` | Per-device (source IP) traffic | Unlimited |
| `ruleByBackend` | Per-rule traffic deltas | Unlimited |
| `countryByBackend` | Per-country traffic deltas | Unlimited |

**Key Operations:**

1. **`recordTraffic()`** - Adds traffic delta to all relevant maps
2. **`merge*()` methods** - Combines DB data with realtime deltas
3. **`clearTraffic()`** - Called after batch flush
4. **`pruneIfNeeded()`** - Evicts lowest-traffic entries when limits exceeded

**Memory Bounds:**
- Maximum 50,000 domain entries
- Maximum 50,000 IP entries  
- Maximum 10,000 device detail entries
- Eviction removes bottom 25% by traffic

### 3.5 BatchBuffer (`batch-buffer.ts`)

Optimizes database writes by:

1. **Aggregating by composite key:**
   ```
   backendId:minute:domain:ip:chain:fullChain:rule:rulePayload:sourceIP
   ```

2. **Batching flushes:**
   - Every 30 seconds (configurable via `FLUSH_INTERVAL_MS`)
   - When buffer reaches 5000 items (configurable via `FLUSH_MAX_BUFFER_SIZE`)

3. **Two-phase write:**
   - Traffic stats → `db.batchUpdateTrafficStats()`
   - Country stats → `db.batchUpdateCountryStats()`

### 3.6 WebSocket Server (`websocket.ts`)

**Connection Lifecycle:**

1. Client connects with optional token (URL param or cookie)
2. Server validates auth if enabled
3. Client sends `subscribe` message with options:
   - `backendId` - Which backend to subscribe to
   - `start/end` - Time range for historical data
   - `minPushIntervalMs` - Throttle push frequency
   - Various detail inclusion flags

**Broadcast Mechanism:**

```typescript
broadcastStats(changedBackendId?: number, force = false) {
  // Throttle: max 1 broadcast per second
  if (now - lastBroadcastTime < 1000 && !force) return;
  
  // Per-client push respecting minPushIntervalMs
  for each client:
    if client.minPushIntervalMs > 0 && elapsed < minPushIntervalMs:
      skip
    
    // Resolve backend
    if changedBackendId !== client.backendId:
      skip
    
    // Get stats and send
    stats = getStatsForBackend(...)
    ws.send(JSON.stringify({ type: 'stats', data: stats }))
}
```

**Summary Caching:**
- 2-second TTL for realtime ranges
- 5-minute TTL for historical ranges
- Cache key includes all query parameters for deduplication

### 3.7 Database Layer

#### 3.7.1 Schema Overview

**Primary Tables:**

| Table | Purpose | Primary Key |
|-------|---------|-------------|
| `domain_stats` | Per-domain aggregation | (backend_id, domain) |
| `ip_stats` | Per-IP aggregation | (backend_id, ip) |
| `proxy_stats` | Per-proxy aggregation | (backend_id, chain) |
| `rule_stats` | Per-rule aggregation | (backend_id, rule) |
| `country_stats` | Per-country aggregation | (backend_id, country) |
| `device_stats` | Per-source-IP aggregation | (backend_id, source_ip) |

**Fact Tables (for range queries):**

| Table | Granularity | Use Case |
|-------|-------------|----------|
| `minute_dim_stats` | Per-minute | Short-range queries (<6h) |
| `hourly_dim_stats` | Per-hour | Long-range queries (>6h) |
| `minute_country_stats` | Per-minute country | Short-range country queries |
| `hourly_country_stats` | Per-hour country | Long-range country queries |

**Cross-reference Tables:**

| Table | Purpose |
|-------|---------|
| `domain_proxy_stats` | Domain × Proxy traffic |
| `ip_proxy_stats` | IP × Proxy traffic |
| `device_domain_stats` | Device × Domain traffic |
| `device_ip_stats` | Device × IP traffic |
| `rule_chain_traffic` | Rule × Chain traffic |
| `rule_domain_traffic` | Rule × Domain traffic |
| `rule_ip_traffic` | Rule × IP traffic |

#### 3.7.2 Repository Pattern

The database uses a facade pattern (`StatsDatabase`) that delegates to specialized repositories:

```typescript
class StatsDatabase {
  public readonly repos = {
    auth: AuthRepository,
    surge: SurgeRepository,
    timeseries: TimeseriesRepository,
    country: CountryRepository,
    device: DeviceRepository,
    proxy: ProxyRepository,
    rule: RuleRepository,
    ip: IPRepository,
    config: ConfigRepository,
    trafficWriter: TrafficWriterRepository,
    domain: DomainRepository,
    backend: BackendRepository,
  };
}
```

Each repository extends `BaseRepository` which provides shared utilities:
- `parseMinuteRange()` - Time range parsing
- `splitChainParts()` - Proxy chain parsing
- `expandShortChainsForRules()` - Rule chain expansion
- `aggregateProxyStatsByFirstHop()` - Proxy aggregation

#### 3.7.3 Query Cache

Database-level range query cache:
- Default TTL: 8 seconds for realtime, 5 minutes for historical
- Maximum 1024 entries
- Configurable via environment variables

### 3.8 GeoIP Service (`geo-service.ts`)

**Dual Provider Support:**

1. **Online API** (default)
   - Endpoint: `https://api.ipinfo.es/ipinfo?ip=xxx`
   - Rate-limited: 100ms minimum between requests
   - 8-second timeout per request

2. **Local MMDB** (optional)
   - Requires: `GeoLite2-City.mmdb`, `GeoLite2-ASN.mmdb`
   - Optional: `GeoLite2-Country.mmdb`
   - No rate limiting
   - Hot-reload when files change

**Lookup Flow:**

```
getGeoLocation(ip):
  1. Check if private IP → return "LOCAL"
  2. Check database cache → return cached
  3. Check failed IPs cooldown → return null
  4. Check pending queries → return existing promise
  5. Queue new lookup
  6. Process queue with rate limiting
  7. Save to database cache
```

**Failure Handling:**
- Failed IPs are cached for 30 minutes
- Queue overflow (100 items) drops new lookups
- Cleanup runs every 10 minutes

---

## 4. Frontend Deep Dive

### 4.1 Next.js Configuration (`next.config.ts`)

**Key Features:**

1. **API Proxying:**
   ```typescript
   // Rewrites /api/* to collector service
   rewrites: [{
     source: "/api/:path*",
     destination: `${API_URL}/api/:path*`
   }]
   ```

2. **PWA Support:**
   - Enabled only in production
   - Service worker with skip waiting
   - Cache-Control headers for sw.js

3. **Environment Variables:**
   - `NEXT_PUBLIC_APP_VERSION` - From package.json
   - `NEXT_PUBLIC_WS_PORT` - WebSocket port (default 3002)

### 4.2 Dashboard Page Structure

```
DashboardPage
├── Sidebar (navigation, backend status)
├── Header (controls, time range, refresh)
├── Content (tab-based content)
│   ├── Overview Tab (summary cards, top items)
│   ├── Domains Tab (paginated domain list)
│   ├── IPs Tab (paginated IP list with GeoIP)
│   ├── Proxies Tab (proxy traffic breakdown)
│   ├── Rules Tab (rule chain flow visualization)
│   ├── Devices Tab (per-device traffic)
│   └── Regions Tab (world map, country stats)
└── BackendConfigDialog (gateway setup)
```

### 4.3 Data Fetching Patterns

**HTTP API (React Query):**
```typescript
// Hook pattern
export function useTrafficTrend(backendId, params) {
  return useQuery({
    queryKey: ['trafficTrend', backendId, params],
    queryFn: () => api.getTrafficTrendAggregated(backendId, params),
    staleTime: 5000,
  });
}
```

**WebSocket (Custom Hook):**
```typescript
// Real-time subscription
useStatsWebSocket({
  backendId,
  timeRange,
  onMessage: (data) => {
    // Update local state
  }
});
```

### 4.4 Internationalization

- Uses `next-intl` package
- Two locales: `zh` (default), `en`
- Translation files: `apps/web/messages/{zh,en}.json`
- Hook: `useTranslations('namespace')`

---

## 5. Multi-Backend Architecture

### 5.1 Backend Isolation

All data is isolated by `backend_id`:

- **Database:** All tables have `backend_id` in primary key
- **RealtimeStore:** Maps are keyed by backend ID
- **WebSocket:** Clients subscribe to specific backend

### 5.2 Backend Management

```typescript
// Backend management loop (every 5s)
manageBackends():
  1. Get all backend configs from DB
  2. For each backend:
     - If config changed → restart collector
     - If enabled/listening changed → start/stop collector
  3. Stop collectors for deleted backends
```

### 5.3 Backend Types

| Type | Protocol | Data Source |
|------|----------|-------------|
| `clash` | WebSocket | `/connections` endpoint |
| `surge` | HTTP Polling | `/v1/requests/recent` endpoint |

---

## 6. Authentication & Security

### 6.1 Cookie-Based Auth

1. User sets token in settings UI
2. Server hashes token and stores in `auth_config` table
3. Login endpoint sets `HttpOnly` cookie `neko-session`
4. Subsequent requests include cookie automatically

### 6.2 Auth Middleware

```typescript
// Fastify hook
app.addHook('onRequest', async (request, reply) => {
  // Skip public routes
  if (isPublicRoute(request.url)) return;
  
  // Check if auth required
  if (!authService.isAuthRequired()) return;
  
  // Validate cookie or Bearer token
  const token = request.cookies['neko-session'] 
             || extractBearerToken(request);
  if (!valid) return 401;
});
```

### 6.3 Emergency Access

- `FORCE_ACCESS_CONTROL_OFF=true` bypasses auth
- Used for password recovery
- Should NOT be enabled in production

---

## 7. Performance Optimizations

### 7.1 Database Level

| Optimization | Setting |
|--------------|---------|
| WAL Mode | `journal_mode = WAL` |
| Sync Mode | `synchronous = NORMAL` |
| Cache Size | 64MB (`cache_size = -65536`) |
| Temp Store | Memory (`temp_store = MEMORY`) |
| Busy Timeout | 5 seconds |

### 7.2 Application Level

| Strategy | Implementation |
|----------|----------------|
| Batch Writes | 30s interval or 5000 items |
| Query Cache | 8s realtime / 5min historical |
| RealtimeStore | In-memory delta aggregation |
| WebSocket Throttle | 1s minimum between broadcasts |
| GeoIP Rate Limit | 100ms between online API calls |

### 7.3 Memory Management

- RealtimeStore entry limits (50K domains, 50K IPs)
- Eviction removes bottom 25% by traffic
- Stale connection cleanup (5-minute timeout)

---

## 8. Data Retention

### 8.1 Configuration

Stored in `app_config` table:
- `retention.connection_logs_days` - Minute-level data (default: 7)
- `retention.hourly_stats_days` - Hourly aggregations (default: 30)
- `retention.auto_cleanup` - Enable automatic cleanup (default: true)

### 8.2 Cleanup Process

```typescript
// Runs every 6 hours
runAutoCleanup():
  1. Get retention config
  2. Calculate cutoff dates
  3. Delete old minute_stats records
  4. Delete old hourly_stats records
```

---

## 9. Environment Variables

### 9.1 Core Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | - | Environment mode |
| `DB_PATH` | `./stats.db` | SQLite database path |
| `COOKIE_SECRET` | auto-generated | Cookie signing key |
| `API_PORT` | 3001 | Fastify API port |
| `COLLECTOR_WS_PORT` | 3002 | WebSocket server port |
| `WEB_PORT` | 3000 | Next.js port |

### 9.2 GeoIP Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEOIP_LOOKUP_PROVIDER` | `online` | `online` or `local` |
| `GEOIP_ONLINE_API_URL` | `https://api.ipinfo.es/ipinfo` | Online API endpoint |

### 9.3 Tuning Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLUSH_INTERVAL_MS` | 30000 | Batch flush interval |
| `FLUSH_MAX_BUFFER_SIZE` | 5000 | Max buffer size before flush |
| `REALTIME_MAX_MINUTES` | 180 | RealtimeStore time window |
| `DB_RANGE_QUERY_CACHE_TTL_MS` | 8000 | Query cache TTL (realtime) |
| `DB_HISTORICAL_QUERY_CACHE_TTL_MS` | 300000 | Query cache TTL (historical) |

---

## 10. Testing

### 10.1 Test Framework

- **Framework:** Vitest
- **Location:** `apps/collector/src/**/*.test.ts`
- **Patterns:**
  - Unit tests for repositories
  - Service tests with mock databases
  - Integration tests for collectors

### 10.2 Running Tests

```bash
# All tests
pnpm --filter @neko-master/collector test

# Single file
pnpm --filter @neko-master/collector test -- src/modules/auth/auth.service.test.ts

# Watch mode
pnpm --filter @neko-master/collector test:watch
```

---

## 11. Docker Deployment

### 11.1 Container Architecture

Single container runs both services:
1. Next.js (port 3000) - Web UI
2. Fastify (port 3001) - API
3. WebSocket (port 3002) - Real-time

### 11.2 Docker Compose (Recommended)

```yaml
services:
  neko-master:
    image: foru17/neko-master:latest
    ports:
      - "3000:3000"
      - "3002:3002"
    volumes:
      - ./data:/app/data
      - ./geoip:/app/data/geoip:ro
    environment:
      - COOKIE_SECRET=your-secret
```

### 11.3 Reverse Proxy Setup

Nginx example:
```nginx
location / {
  proxy_pass http://localhost:3000;
}

location /_cm_ws {
  proxy_pass http://localhost:3002;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

---

## 12. Key Design Patterns

### 12.1 Repository Pattern

Separates data access logic from business logic. Each repository handles a specific domain:
- `DomainRepository` - Domain statistics
- `IPRepository` - IP statistics + GeoIP
- `RuleRepository` - Rule statistics + chain flow
- etc.

### 12.2 Facade Pattern

`StatsDatabase` class acts as a facade, providing a simplified interface to the complex repository subsystem.

### 12.3 Observer Pattern

WebSocket server broadcasts updates to subscribed clients when new traffic data arrives.

### 12.4 Strategy Pattern

GeoIP service uses strategy pattern for provider selection (online vs local MMDB).

### 12.5 Batch Aggregation Pattern

Traffic updates are buffered and aggregated before database writes, reducing I/O by ~90%.

---

## 13. Potential Improvements

### 13.1 Identified Areas

1. **Type Safety:**
   - Some `any` types remain in test files (allowed by ESLint config)
   - GeoIP API responses could use stricter typing

2. **Error Handling:**
   - Some error paths log but don't propagate errors
   - Could benefit from structured error types

3. **Performance:**
   - RealtimeStore could use LRU cache instead of eviction
   - WebSocket message serialization could be optimized

4. **Testing:**
   - Frontend lacks test coverage
   - Could add E2E tests

5. **Documentation:**
   - API documentation could be generated (OpenAPI/Swagger)
   - Inline code comments could be expanded

---

## 14. Conclusion

Neko Master is a well-architected traffic analytics platform with:

- **Clean separation of concerns** between data collection, storage, and visualization
- **Efficient data pipeline** with batch aggregation and realtime caching
- **Flexible multi-backend support** for different gateway types
- **Production-ready deployment** with Docker and reverse proxy support
- **Good performance characteristics** through careful optimization

The codebase demonstrates strong TypeScript practices, modular design, and attention to operational concerns like data retention and graceful shutdown.
