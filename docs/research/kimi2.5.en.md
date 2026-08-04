# Neko Master Deep Research Report (English)

## Executive Summary

**Neko Master** is a network traffic analytics and visualization platform for Clash, Mihomo, and Surge gateways. Built as a TypeScript monorepo, it provides real-time monitoring, historical analysis, and multi-backend management.

---

## Project Overview

### What It Does

Neko Master focuses on:

- **Collection**: ingesting live connection and traffic data from gateways
- **Analysis**: aggregating by domain, IP, proxy chain, rule, device, and region
- **Visualization**: showing trends and distributions in a web dashboard
- **Management**: operating multiple gateway backends in one place
- **Auditing**: supporting historical time-series queries and trace-back

### Typical Use Cases

- Network admins monitoring performance and anomalies
- Privacy-conscious users auditing outbound traffic behavior
- Developers debugging gateway rules and policy routing
- Teams managing multiple gateway instances

---

## Architecture Overview

### Repository Layout

```text
neko-master/
├── apps/
│   ├── web/                    # Next.js 16 frontend
│   └── collector/              # Fastify backend collector
├── packages/
│   └── shared/                 # Shared types and utilities
├── docs/
├── docker-compose.yml
└── Dockerfile
```

### Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Recharts, TanStack Query, next-intl |
| Backend | Node.js 22, Fastify 5, ws, SQLite (better-sqlite3), MaxMind |
| Tooling | pnpm, Turborepo, Docker |

---

## Core Components

### 1) Frontend (`apps/web`)

- App Router with `[locale]` i18n routing (`zh` / `en`)
- Main views include domains, ips, proxies, rules, devices, and settings
- React Query for server state and WebSocket for live updates
- Responsive UI built with shadcn/ui + Tailwind v4
- Basic PWA support (manifest + service worker)

### 2) Backend (`apps/collector`)

Key modules:

- `index.ts`: runtime orchestration entry
- `app.ts`: Fastify API registration
- `collector.ts`: Clash WebSocket collector
- `surge-collector.ts`: Surge HTTP polling collector
- `websocket.ts`: real-time broadcast server
- `realtime.ts`: in-memory real-time aggregation
- `db.ts` + `database/repositories/*`: DB facade and repository layer

Data pipeline:

1. Gateway traffic enters collectors (WS or HTTP)
2. Deltas are calculated and written to RealtimeStore
3. Records enter BatchBuffer (flush at 30s / 5000 entries)
4. Aggregated writes are persisted to SQLite
5. WebSocket pushes updates to frontend clients

### 3) Shared Package (`packages/shared`)

- Shared contracts and helpers across frontend and backend
- Side-effect-free and low-coupling by design
- Typical files: `index.ts`, `gateway-utils.ts`, `geo-ip-utils.ts`

---

## Data Model

### SQLite Design

WAL mode is enabled. Core tables include:

- `domain_stats`, `ip_stats`, `proxy_stats`, `rule_stats`, `country_stats`, `device_stats`
- Cross tables: `domain_proxy_stats`, `ip_proxy_stats`, `rule_domain_traffic`, `rule_ip_traffic`
- Time-series tables: `minute_*`, `hourly_*`, `daily_*`
- Config/cache tables: `backend_configs`, `auth_config`, `geoip_cache`, `asn_cache`, `surge_policy_cache`

### RealtimeStore

Realtime in-memory deltas are partitioned by `backendId` (domain/IP/proxy/rule/device/country). Query responses merge DB history with fresh in-memory increments.

---

## API and Communication

### REST API (high level)

- Backend management: `/api/backends/*`
- Stats queries: `/api/stats/*`, `/api/domains/*`, `/api/ips/*`, `/api/proxies/*`, `/api/rules/*`, `/api/devices/*`
- Gateway proxy APIs: `/api/gateway/:backendId/*`
- Authentication: `/api/auth/*`

### WebSocket

- Endpoint: `/_cm_ws`
- Auth: cookie-based (token-compatible variants are supported by deployment pattern)
- Subscription model: client sends `subscribe`, server pushes `stats` / `connections`
- Supports reconnect, heartbeat, and backend-scoped streams

---

## Key Design Patterns

1. **Repository Pattern**: query and aggregation logic is isolated in repositories.
2. **Dual Write Pattern**: write to in-memory realtime + batch persistence.
3. **Delta Merge Pattern**: merge historical DB data with realtime deltas on read.
4. **Fastify Plugin Pattern**: modular controllers with injected services.

---

## Configuration and Runtime

Common environment variables:

- `WEB_PORT`, `API_PORT`, `COLLECTOR_WS_PORT`
- `DB_PATH`, `COOKIE_SECRET`
- `GEOIP_LOOKUP_PROVIDER`, `MAXMIND_LICENSE_KEY`
- `FORCE_ACCESS_CONTROL_OFF`, `SHOWCASE_MODE`
- `FLUSH_INTERVAL_MS`, `FLUSH_MAX_BUFFER_SIZE`

Backend config includes `id`, `name`, `type(clash/mihomo/surge)`, `url`, `secret`, `pollingInterval`, and `enabled`.

---

## Development Workflow

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm --filter @neko-master/collector test
```

Collector tests can be filtered by file name or test title.

---

## Deployment and Security

### Docker

- Multi-stage build for production images
- `docker-compose.yml` exposes 3000 (web), 3001 (api), 3002 (ws)
- Mount `data` for database and runtime persistence

### Security

- Cookie session + token-based login flow
- bcrypt password hashing
- CORS, rate limits, request validation
- SQL parameterized queries
- Optional read-only showcase mode

---

## Performance Strategy

- DB: WAL + indexes + batch writes
- App: RealtimeStore hot data + incremental WS push + debounced write path
- GeoIP: cache + failed-IP cooldown + paced queue

---

## Risks and Suggested Next Steps

### Current Risks

- Startup orchestration and WS protocol paths can use deeper test coverage
- Periodic backend management loop may overlap under timing pressure
- Legacy/parallel paths increase maintenance complexity

### Suggested Improvements

1. Expand tests for collector orchestration and WS integration.
2. Publish detailed HTTP/WS endpoint schema documentation.
3. Add finer-grained alerting and anomaly detection.
4. Improve horizontal scaling and cache coordination for multi-instance deployment.

---

## Conclusion

Neko Master strikes a practical balance across real-time responsiveness, durable storage, and multi-backend isolation. It is production-capable today and has a clear path for scaling and hardening.
