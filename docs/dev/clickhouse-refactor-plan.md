# ClickHouse Refactor Plan (Homelab Balanced)

## Goal

- Reduce collector disk read pressure caused by SQLite UPSERT read amplification.
- Keep existing product behavior and API contracts stable during migration.
- Use a homelab-friendly architecture: minimal new components, simple rollback.

## Scope

- In scope:
  - Stats storage/query path migration (summary, trend, domains, IPs, proxies, rules, countries, hourly).
  - Collector dual-write support (SQLite + ClickHouse) with feature flags.
  - Query routing with gradual cutover and instant fallback.
- Out of scope:
  - Auth/session/backend management schema migration.
  - Agent protocol changes.
  - Frontend major redesign.

## Target Architecture (Phase End State)

- `web` (Next.js)
- `collector-api` (Fastify API + WS)
- `collector-ingest` (traffic ingest/flush worker, can remain in same process at first)
- `clickhouse` (stats store/query)
- SQLite remains for control-plane and fallback reads.

## Why This Path

- Current bottleneck is not GeoIP query frequency anymore; it is write-path index lookups from heavy SQLite UPSERTs.
- ClickHouse is better suited for high-frequency append/aggregate workloads.
- Dual-write + staged read cutover gives low-risk migration and quick rollback.

## Migration Principles

- No big-bang switch.
- Every phase has measurable acceptance criteria.
- Any failure must be recoverable by env flag change.
- Keep API response shape unchanged for frontend.

## Delivery Phases

### Phase 0: Design and Baseline

- Produce table mapping and query mapping from SQLite to ClickHouse.
- Capture baseline metrics (3 runs recommended):
  - `Avg Read Speed`, `P95 Read Speed`, `Avg Write Speed`
  - API latency P95 for core endpoints
  - Data consistency delta for key stats
- Deliverables:
  - This plan + mapping section completed
  - Baseline benchmark notes

### Phase 1: Infrastructure and Config

- Add ClickHouse service to docker-compose (single node).
- Add env flags (default disabled):
  - `CH_ENABLED=0`
  - `CH_HOST`, `CH_PORT`, `CH_DATABASE`, `CH_USER`, `CH_PASSWORD`
  - `CH_WRITE_ENABLED=0`
  - `STATS_QUERY_SOURCE=sqlite` (`sqlite|clickhouse|auto`)
- Add startup health logs and connection retry.
- Acceptance:
  - Service boots with CH disabled and unchanged behavior.
  - CH enabled but write disabled does not impact current flow.

### Phase 2: Schema and Write Path (Dual Write)

- Create ClickHouse tables for minute-level aggregated facts and dimensions.
- Implement batched insert from existing flush path.
- Keep SQLite write as primary; CH write is best-effort and isolated.
- Add write metrics logs:
  - `ch_write_rows`, `ch_write_batches`, `ch_write_failures`, `ch_write_latency_ms`
- Acceptance:
  - CH row growth matches expected ingest rate.
  - SQLite remains healthy when CH is degraded.

### Phase 3: Query Routing (Read Gray Release)

- Implement repository/router layer for stats reads.
- Route low-risk endpoints first:
  - summary, trend, top domains, top IPs, hourly stats
- Add consistency checker (same time window compare SQLite vs CH).
- Acceptance:
  - Delta within tolerance (default < 1%).
  - API latency stable or improved.

### Phase 4: Default Cutover

- Switch `STATS_QUERY_SOURCE=auto` or `clickhouse` for target endpoints.
- Keep SQLite query path as fallback.
- Tune retention/TTL in CH.
- Acceptance:
  - Disk read drop meets target.
  - No functional regression in dashboard.

### Phase 5: Cleanup and Docs

- Document operations, backup, troubleshooting, rollback.
- Keep feature flags for one release cycle.

## Data Model Draft (Initial)

### 1) `traffic_minute`

- Purpose: minute-level aggregated traffic by core dimensions.
- Suggested columns:
  - `backend_id UInt32`
  - `minute DateTime`
  - `domain LowCardinality(String)`
  - `ip String`
  - `source_ip String`
  - `chain String`
  - `rule String`
  - `upload UInt64`
  - `download UInt64`
  - `connections UInt32`
- Engine: `SummingMergeTree`
- Partition: by month (`toYYYYMM(minute)`)
- Order key: `(backend_id, minute, domain, ip, source_ip, chain, rule)`

### 2) `country_minute`

- Purpose: country/continent aggregates.
- Suggested columns:
  - `backend_id UInt32`
  - `minute DateTime`
  - `country LowCardinality(String)`
  - `country_name String`
  - `continent LowCardinality(String)`
  - `upload UInt64`
  - `download UInt64`
  - `connections UInt32`

### 3) Optional Materialized Views

- hourly rollups for faster dashboard hourly charts.
- top-k helper views for common ranking queries.

## Feature Flags and Rollback

- Flags:
  - `CH_ENABLED`
  - `CH_WRITE_ENABLED`
  - `STATS_QUERY_SOURCE`
- Rollback:
  - Set `STATS_QUERY_SOURCE=sqlite`
  - Set `CH_WRITE_ENABLED=0`
  - Keep service up without data loss on control-plane path.

## Risks and Mitigations

- Risk: dual-write overhead.
  - Mitigation: bounded batch size, async write, non-blocking fallback.
- Risk: temporary data inconsistency.
  - Mitigation: consistency checker + alert threshold.
- Risk: homelab resource spikes.
  - Mitigation: single-node CH with memory caps and retention TTL.

## Estimated Complexity (Homelab)

- Infra complexity: medium (+1 core service).
- Code complexity: medium (new write adapter + query router).
- Ops complexity: medium (add CH backup/health checks).

## Acceptance Criteria (Go/No-Go)

- `Avg Read Speed` reduced by at least 30% in 3 comparable runs.
- Dashboard core endpoints no regression in p95 latency.
- Data consistency delta under 1% for selected windows.
- Rollback tested and documented.

## Execution Checklist (Pre-Start)

- [ ] Confirm final scope and endpoints for first cutover.
- [ ] Confirm retention policy in CH (days/months).
- [ ] Confirm whether to keep ingest in collector process or separate worker container.
- [ ] Confirm resource limits for CH container (CPU/RAM/disk).

## Current Implementation Status

- Completed:
  - Phase 1 infra wiring (optional ClickHouse service + connectivity checks).
  - Phase 2 baseline dual-write scaffolding (SQLite primary, CH best-effort writes behind flags).
  - Auto schema bootstrap for `traffic_minute` and `country_minute`.
  - Compare service for SQLite vs ClickHouse traffic windows (non-blocking logs).
  - Initial read routing for core stats endpoints:
    - `/api/stats/summary`
    - `/api/stats/domains`
    - `/api/stats/ips`
    - `/api/stats/domains/proxy-stats`
    - `/api/stats/domains/ip-details`
    - `/api/stats/ips/proxy-stats`
    - `/api/stats/ips/domain-details`
    - `/api/stats/proxies`
    - `/api/stats/proxies/domains`
    - `/api/stats/proxies/ips`
    - `/api/stats/rules`
    - `/api/stats/rules/domains`
    - `/api/stats/rules/ips`
    - `/api/stats/rules/domains/proxy-stats`
    - `/api/stats/rules/domains/ip-details`
    - `/api/stats/rules/ips/proxy-stats`
    - `/api/stats/rules/ips/domain-details`
    - `/api/stats/countries`
    - `/api/stats/devices`
    - `/api/stats/devices/domains`
    - `/api/stats/devices/ips`
    - `/api/stats/hourly`
    - `/api/stats/trend`
    - `/api/stats/trend/aggregated`
- Not completed yet:
  - Keep SQLite-only for non-aggregated or graph-specific endpoints:
    - `/api/stats/rules/chain-flow`
    - `/api/stats/rules/chain-flow-all`
    - `/api/stats/rule-proxy-map`
    - `/api/stats/connections`
    - `/api/stats/global`

## Homelab Trial Run (Current)

1. Start with ClickHouse profile:
   - `CH_ENABLED=1 docker compose --profile clickhouse up -d`
2. Verify readiness logs:
   - `[ClickHouse] Ready ...`
   - `[ClickHouse] Schema ensured ...`
3. Enable dual-write in collector:
   - `CH_WRITE_ENABLED=1`
4. Observe writer metrics:
   - `[ClickHouse Writer] ... failures=0 ...`
5. (Optional) Enable compare logs:
   - `CH_COMPARE_ENABLED=1`
   - Observe: `[ClickHouse Compare] backend=... upload_delta=... download_delta=...`
5. Rollback instantly if needed:
   - `CH_WRITE_ENABLED=0` (keeps SQLite path unchanged)

## SQLite -> ClickHouse Data Migration Script

To help existing SQLite users transfer historical data before cutover, collector now includes:

- Script: `apps/collector/src/scripts/migrate-sqlite-to-clickhouse.ts`
- Command:
  - `pnpm --filter @neko-master/collector migrate:sqlite-to-ch`

Common examples:

- Append-import from current SQLite DB:
  - `CH_ENABLED=1 pnpm --filter @neko-master/collector migrate:sqlite-to-ch -- --sqlite ./apps/collector/stats.db`
- Replace target tables and re-import:
  - `CH_ENABLED=1 pnpm --filter @neko-master/collector migrate:sqlite-to-ch -- --sqlite ./apps/collector/stats.db --truncate`
- Import a time window only:
  - `CH_ENABLED=1 pnpm --filter @neko-master/collector migrate:sqlite-to-ch -- --sqlite ./apps/collector/stats.db --from 2026-02-01T00:00:00Z --to 2026-02-20T00:00:00Z`

Validation command after migration:

- Compare SQLite vs CH over a time window:
  - `CH_ENABLED=1 pnpm --filter @neko-master/collector verify:sqlite-vs-ch -- --sqlite ./apps/collector/stats.db --from 2026-02-01T00:00:00Z --to 2026-02-20T00:00:00Z`
- Fail CI/automation when delta is above threshold:
  - `CH_ENABLED=1 pnpm --filter @neko-master/collector verify:sqlite-vs-ch -- --sqlite ./apps/collector/stats.db --max-delta 1 --fail-on-delta`

Current migration coverage:

- `minute_dim_stats` -> `traffic_minute`
- `minute_country_stats` -> `country_minute`

Notes:

- Script is idempotent only when importing disjoint windows, or when using `--truncate` before full re-import.
- For now, rule graph specific tables are still read from SQLite and do not require CH migration.

## Docker Users (Minimal Steps)

Default compose now uses one-click interop credentials for ClickHouse:

- `CH_USER=neko`
- `CH_PASSWORD=neko_master`

So most Docker users do not need manual credential edits.

Recommended migration sequence:

1. Start with ClickHouse enabled but keep SQLite reads:
   - `CH_ENABLED=1 CH_WRITE_ENABLED=1 STATS_QUERY_SOURCE=sqlite docker compose --profile clickhouse up -d`
2. Migrate historical data inside container:
   - `docker exec -it neko-master node /app/apps/collector/dist/scripts/migrate-sqlite-to-clickhouse.js --sqlite /app/data/stats.db --truncate`
3. Verify SQLite vs ClickHouse consistency:
   - `docker exec -it neko-master node /app/apps/collector/dist/scripts/verify-sqlite-clickhouse.js --sqlite /app/data/stats.db --max-delta 1 --fail-on-delta`
4. Switch to routed reads after verification:
   - `STATS_QUERY_SOURCE=auto docker compose up -d`

Rollback:

- `STATS_QUERY_SOURCE=sqlite CH_WRITE_ENABLED=0 docker compose up -d`

## Active Environment Flags

- `CH_ENABLED` (0/1): enable CH integration
- `CH_REQUIRED` (0/1): fail startup if CH unavailable
- `CH_HOST`, `CH_PORT`, `CH_DATABASE`, `CH_USER`, `CH_PASSWORD`
- `CH_WRITE_ENABLED` (0/1): enable dual-write
- `CH_WRITE_MAX_PENDING_BATCHES` (default 200)
- `CH_AUTO_CREATE_TABLES` (default 1)
- `CH_METRICS_LOG_INTERVAL_MS` (default 60000)
- `CH_COMPARE_ENABLED` (default 0)
- `CH_COMPARE_INTERVAL_MS` (default 120000)
- `CH_COMPARE_WINDOW_MINUTES` (default 10)
- `CH_COMPARE_TIMEOUT_MS` (default 8000)
- `CH_COMPARE_START_DELAY_MS` (default 120000)
- `STATS_QUERY_SOURCE` (default sqlite, reserved for next phase)
- `STATS_ROUTE_METRICS_LOG_INTERVAL_MS` (default 60000, set 0 to disable)
- `CH_CONNECT_TIMEOUT_MS` (default 5000)
- `CH_CONNECT_MAX_RETRIES` (default 5)
- `CH_CONNECT_RETRY_DELAY_MS` (default 2000)
