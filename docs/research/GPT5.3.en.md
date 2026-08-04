# Neko Master Monorepo Deep Research (GPT-5.3)

This report documents a deep analysis of `/Users/luolei/DEV/clash-master`, including architecture, runtime behavior, code-level design patterns, edge cases, and operational specifics.

## 1) What This Repository Is

Neko Master is a pnpm monorepo for network traffic analytics and visualization.

- `apps/collector`: backend data collector + API + WebSocket push server (Fastify + ws + SQLite)
- `apps/web`: Next.js dashboard frontend (App Router, next-intl, React Query)
- `packages/shared`: shared contracts/utilities used by both apps

Core capability: ingest traffic from Clash/Mihomo and Surge, aggregate into multi-dimensional stats, and expose near-real-time dashboards.

## 2) Monorepo Build/Dev/Lint Orchestration

### Workspace + task runner

- Workspace config: `pnpm-workspace.yaml`, root `package.json`
- Task orchestration: `turbo.json`
- Root scripts:
  - `pnpm dev` -> `turbo dev`
  - `pnpm build` -> `turbo build`
  - `pnpm lint` -> `turbo lint`

### Turbo behavior specifics

- `build` depends on dependency graph (`^build`), caches `dist/**` and `.next/**` (excluding `.next/cache/**`)
- `dev` is non-cached and persistent
- `lint` also respects dependency graph (`^lint`)
- Global cache invalidation includes `**/.env.*local`

## 3) Collector Deep Dive (`apps/collector`)

## 3.1 Runtime topology and startup sequence

Main orchestrator: `apps/collector/src/index.ts`

Single process hosts all of the following:

- Fastify HTTP API server (`APIServer`)
- Dedicated WebSocket server (`StatsWebSocketServer`)
- One collector instance per backend (Clash WS collector or Surge polling collector)
- GeoIP service (`GeoIPService`)
- Surge policy sync service (`SurgePolicySyncService`)

Startup sequence in `main()`:

1. Load `.env.local` (if present), then `.env`
2. Initialize SQLite facade (`StatsDatabase`)
3. Initialize GeoIP service
4. Start WS server (default `3002`)
5. Start policy sync service
6. Start Fastify API server (default `3001`)
7. Start backend management loop immediately + every 5s
8. Schedule retention cleanup (+30s once, then every 6h)
9. Register graceful shutdown (`SIGINT`/`SIGTERM`)

## 3.2 Multi-backend lifecycle management

`manageBackends()` continuously reconciles DB backend configs with in-memory collectors:

- starts collectors for enabled + listening backends
- restarts collector when config changes (`url`, `token`, `type`, `listening`, `enabled`)
- stops collectors for deleted/disabled/non-listening backends

State maps are keyed by `backendId`, preserving backend isolation.

## 3.3 Ingestion path: Clash (WebSocket stream)

Implementation: `apps/collector/src/collector.ts`

- Connects to upstream `/connections` WS endpoint
- Tracks connection snapshots in `Map<id, TrackedConnection>`
- Per update, computes positive deltas (`max(0, current - previous)`)
- Ignores invalid/empty frames safely
- Removes stale missing IDs and periodically purges stale tracked connections
- Reconnect uses fixed interval behavior (no exponential retry)

## 3.4 Ingestion path: Surge (HTTP polling)

Implementation: `apps/collector/src/surge-collector.ts`

- Polls `/v1/requests/recent` (default interval ~2s)
- Uses exponential retry backoff for request failures
- 4xx is treated as non-retryable class in retry path
- Tracks requests by ID and computes incremental byte deltas
- Handles counter reset edge case (`current < previous`)
- Uses `recentlyCompleted` map (TTL ~5 min) to avoid duplicate counting of completed requests
- Parses policy/rule-chain metadata from Surge notes

## 3.5 Batch writing, aggregation, and realtime interplay

Batch layer: `apps/collector/src/batch-buffer.ts`

- Buffers updates and flushes on:
  - timer (`FLUSH_INTERVAL_MS`, default 30000)
  - buffer size threshold (`FLUSH_MAX_BUFFER_SIZE`, default 5000)
- Flush writes both traffic and country data in batch form

Writer repository: `apps/collector/src/database/repositories/traffic-writer.repository.ts`

- Pre-aggregates in memory before SQL writes
- Writes to multiple aggregate/fact tables in transactional groups

Realtime interaction:

- Deltas are also pushed into in-memory `realtimeStore`
- After successful DB flush, relevant realtime deltas are cleared to avoid DB+memory double counting
- Collectors trigger WS broadcast callback with internal throttling

## 3.6 API architecture and module boundaries

Core server assembly: `apps/collector/src/app.ts`

- Registers CORS, cookie plugin, service injections, and module controllers
- Controller prefixes:
  - `/api/backends`
  - `/api/stats`
  - `/api/auth`
  - `/api/db`
- Adds compatibility routes directly in `app.ts`:
  - `/api/gateway/proxies`
  - `/api/gateway/providers/proxies`
  - `/api/gateway/providers/proxies/refresh`
  - `/api/gateway/rules`
  - `/health`

Pattern:

- Controllers are thin orchestration layers (parse + validate + delegate)
- Services host business logic
- `StatsDatabase` facade + repository classes host data access/transform logic

## 3.7 Authentication and access-control specifics

Auth service: `apps/collector/src/modules/auth/auth.service.ts`

- Token stored as SHA-256 hash in DB
- Runtime checks support:
  - cookie (`neko-session`)
  - bearer fallback (`Authorization: Bearer ...`)
- Public routes skip auth checks (`/health`, `/api/auth/state`, `/api/auth/verify`, `/api/auth/logout`)

Special modes:

- `FORCE_ACCESS_CONTROL_OFF=true`: bypass auth requirement
- `SHOWCASE_SITE_MODE=true`: blocks many mutating endpoints and masks sensitive backend URL output

Cookie secret behavior:

- If `COOKIE_SECRET` missing, server auto-generates one
- In production this causes sessions to invalidate on restart unless secret is persisted

## 3.8 WebSocket server protocol and behavior

Server: `apps/collector/src/websocket.ts`

Highlights:

- Dedicated WS server process inside collector runtime
- Auth via cookie or query token
- Incoming message types include `ping` and `subscribe`
- Subscribe payload supports backend selection, time range, detail flags, pagination/trend options, and min push interval
- Initial data push on connect/subscription
- Broadcast globally throttled; per-client minimum interval also enforced
- Server-side response caching by query shape to avoid recomputation per client
- Base summary cache TTL differs by freshness (near-now short TTL, historical longer TTL)

Realtime merge policy:

- In-memory deltas are merged only for queries whose end-time is near “now” (`REALTIME_RANGE_END_TOLERANCE_MS`)

## 3.9 Database design and query strategy

Schema and migrations:

- `apps/collector/src/database/schema.ts`
- `apps/collector/src/db.ts`

Design traits:

- SQLite with WAL and performance pragmas
- Backend-scoped analytics (`backend_id` across major tables)
- Mix of cumulative aggregate tables + minute/hourly fact tables

Important query optimization behavior:

- Range queries choose minute or hourly fact table based on range span (commonly 6h threshold)
- DB range cache with TTL:
  - near-now short TTL
  - historical longer TTL

Retention:

- Retention config in DB (`app_config` / retention APIs)
- Auto cleanup prunes old minute/hourly and related fact data

## 3.10 GeoIP subsystem specifics

Service: `apps/collector/src/geo-service.ts`

Behavior:

- Private IP short-circuit to local classification
- DB cache first (`geoip_cache`)
- Dedupes concurrent lookups (`pendingQueries`)
- Cooldown for failed IPs to avoid hammering provider
- Queue + pacing controls for online lookups

Provider model:

- Configurable online/local provider
- Local uses MaxMind MMDB files (City + ASN required)
- Falls back to online when local unavailable
- Config endpoints expose configured vs effective provider and validate local prerequisites

## 3.11 Collector tests and coverage profile

Test setup:

- Vitest (`apps/collector/vitest.config.ts`)
- Helper utilities in `apps/collector/src/__tests__/helpers.ts`
- Temporary SQLite DB created per test suite cycle

Covered:

- auth service behavior
- stats service behavior
- traffic writer repository correctness
- geoip config/normalization behavior

Under-covered areas:

- startup orchestration in `index.ts`
- Clash/Surge collector runtime edge behavior
- WS protocol integration and auth edge cases
- backend lifecycle reconciliation loop race scenarios

## 3.12 Notable collector quirks and risks

- Manual route validation in controllers (limited centralized schema validation)
- Potential overlap risk: async `manageBackends` invoked by timer without explicit single-flight guard
- Legacy/parallel code paths exist in some module folders vs active top-level runtime files
- Data model contains denormalized comma-joined fields in places, which may degrade precision at scale

## 4) Web Frontend Deep Dive (`apps/web`)

## 4.1 Routing and locale architecture

Key files:

- `apps/web/app/[locale]/layout.tsx`
- `apps/web/app/[locale]/page.tsx`
- `apps/web/app/[locale]/dashboard/page.tsx`
- `apps/web/proxy.ts`
- `apps/web/i18n/routing.ts`
- `apps/web/i18n/request.ts`

Behavior:

- Locale-aware App Router (`en`, `zh`; default `zh`)
- Locale root page re-exports dashboard component directly
- next-intl middleware (`proxy.ts`) handles locale routing with matcher exclusions

## 4.2 Data layer and API client design

Core client: `apps/web/lib/api.ts`

- One typed API facade for all backend endpoints
- Runtime API base resolution order:
  1. `window.__RUNTIME_CONFIG__.API_URL`
  2. env (`NEXT_PUBLIC_API_URL` / `API_URL`)
  3. `/api`
- GET inflight dedupe to avoid duplicate concurrent requests
- 401 triggers browser event (`api:unauthorized`) for auth state sync
- Uses `ApiError` class (`apps/web/lib/api-error.ts`)

React Query defaults:

- `apps/web/components/providers/query-provider.tsx`
- staleTime ~5s default, gcTime ~5m, retry 1
- Per-hook overrides in `hooks/api/*` + `lib/query-config.ts`

## 4.3 Dashboard state and composition model

Main orchestrator hook: `apps/web/app/[locale]/dashboard/hooks/use-dashboard.ts`

- Coordinates tab state, time range, backend selection, translations, auth awareness, and data fetching strategy
- Uses mixed strategy: HTTP query + websocket updates depending on tab and refresh mode

Composition:

- `dashboard/page.tsx` composes `Sidebar`, `Header`, and `Content`
- `Content` switches feature modules by tab (overview/domains/countries/proxies/rules/devices/network)

## 4.4 Real-time WebSocket client strategy

Client implementation: `apps/web/lib/websocket.ts`

- Candidate endpoint strategy supports runtime/env-configured WS URL and inferred fallbacks
- Environment-sensitive ordering (production tends to try path-based `/_cm_ws` first)
- Heartbeat ping/pong + latency tracking
- Exponential reconnect and fallback endpoint rotation
- Rich `subscribe` payload to control server response shape

Integration:

- Several feature modules consume websocket updates and merge into React Query cache for low-latency UX

## 4.5 Authentication UX and control flow

Core auth state: `apps/web/lib/auth.tsx`

- Global provider determines whether auth is enabled and whether current session is valid
- Guard (`AuthGuard`) displays login dialog when required
- Logout clears session and reloads

Notable behavior:

- API unauthorized events trigger auth state downgrade
- Auth verification uses backend auth endpoints and protected probe calls

## 4.6 UI, styling, theme, and component system

Key pieces:

- Tailwind v4 (`app/globals.css`, `postcss.config.mjs`)
- shadcn/ui config (`apps/web/components.json`, style `new-york`)
- Primitive UI components in `apps/web/components/ui/*`
- Theme runtime via next-themes provider and theme-color sync
- Selective framer-motion usage for key interactions

## 4.7 PWA/service worker setup

Files:

- Manifest route: `apps/web/app/manifest.ts`
- SW script: `apps/web/public/sw.js`
- SW runtime registration: `apps/web/components/common/sw-register.tsx`
- Next config conditional PWA plugin in production: `apps/web/next.config.ts`

Specificity:

- There is both custom service-worker logic and production next-pwa integration, so behavior can differ across environments if not carefully tested.

## 4.8 Frontend risks and edge cases

- Multiple feature modules can establish websocket connections simultaneously depending on view usage
- Strong coupling to backend WS payload shape (`stats` message optional fields)
- Locale switching is path-string based; robust enough now but sensitive to future route shape changes
- Viewport config disables user scaling (accessibility tradeoff)

## 5) Shared Package Deep Dive (`packages/shared`)

Primary file: `packages/shared/src/index.ts`

Provides:

- Shared domain contracts for stats, gateway payloads, websocket updates, auth, surge models
- Utility re-exports:
  - `gateway-utils.ts`
  - `geo-ip-utils.ts`

Important utilities:

- `buildGatewayHeaders`: type-aware header construction for Clash/Surge
- `parseSurgeRule` + `parseGatewayRule`: normalization/parsing helpers
- `getGatewayBaseUrl`: normalizes WS/HTTP gateway base URL extraction
- `normalizeGeoIP`: compatibility normalizer for mixed geo payload shapes

Compatibility note:

- Because apps depend on `workspace:*`, shared contract changes are immediately global and should be treated as coordinated cross-app changes.

## 6) Deployment, Runtime Config, and Ops

## 6.1 Next rewrite + runtime config

- API calls in browser usually target `/api/*`
- Next rewrite forwards `/api/:path*` to `API_URL` destination
- Runtime config script (`public/runtime-config.js`) supports deploy-time override without rebuild

## 6.2 Docker/runtime scripts

Relevant files:

- `Dockerfile`
- `docker-compose.yml`
- `docker-start.sh`
- `.dockerignore`

Notable behavior:

- startup script auto-generates/persists `COOKIE_SECRET` in mounted data volume if missing
- runtime config is generated/injected at container startup
- image build is multi-stage and multi-arch aware via CI workflow

## 7) Git Hooks and CI Quality Gates

Pre-push hook (`.husky/pre-push`):

- only enforced when pushing to `main`
- runs:
  - collector type check
  - web production build

GitHub Actions:

- Docker build/publish pipeline (`.github/workflows/docker-build.yml`)
- dev branch sync guard (`ensure-dev-synced-with-main.yml`)
- preview branch automation (`dev-preview-branch.yml`)

Observation:

- CI gate is stronger on container buildability than lint/test depth.

## 8) Documentation vs Implementation Drift

Architecture docs are useful but partially stale in folder naming/module layout compared to current collector file structure. Use docs for conceptual understanding, but trust code paths for implementation-level decisions.

## 9) Strengths, Risks, and Practical Guidance

### Strengths

- Clear monorepo separation with shared contracts
- Good real-time architecture: DB persistence + in-memory delta merge + WS push
- Runtime-config-aware frontend deployment model
- Backend isolation by `backendId` is consistently embedded in data path

### Key risks

- Some runtime-critical paths (collector orchestration + WS protocol) are lightly tested
- Potential race/overlap patterns in periodic backend manager loops
- Mixed/legacy code paths can confuse contributors
- Strong frontend/backend contract coupling (especially WS payload shape)

### What to know before editing

1. Shared types in `packages/shared` are cross-app contracts.
2. Collector uses ESM + `.js` extension for relative imports.
3. Web API base and WS endpoints can be runtime-overridden.
4. Keep backend isolation (`backendId`) intact in any new query/write path.
5. Validate changes in both realtime and non-realtime (HTTP fallback) modes.
6. For auth/security changes, verify cookie + bearer compatibility paths.

## 10) Recommended Next Research (if needed)

- Build an endpoint matrix (HTTP + WS) with exact request/response schemas and source functions.
- Add a collector reliability review focused on reconnection/backoff consistency between Clash and Surge paths.
- Add a test-gap plan prioritizing `index.ts` orchestrator and `websocket.ts` protocol behavior.
