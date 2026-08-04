# Network Diagnostics Module — Design Spec

## Overview

Add a network diagnostics module that actively probes common websites through the user's Clash/OpenClash proxy to measure real-world latency, connectivity, and exit IP information. Results are visualized in a new "Network" sidebar tab.

The module must support **both deployment modes**:
- **Direct mode** (default): Collector runs diagnostics itself through the Clash HTTP proxy port
- **Agent mode**: Agent runs diagnostics locally and reports results to the remote Collector

Both modes share the same database schema, API endpoints, and frontend UI.

## Architecture

```
Direct Mode:
  Collector ──► Clash :9090 /configs (get proxy port)
           ──► Clash :7890 (test through proxy, full rule matching)
           ──► Clash :9090 /proxies/{name}/delay (node delay)
           ──► SQLite (write results)
           ──► Frontend (serve via API)

Agent Mode:
  Agent ──► Clash :9090 /configs (get proxy port)
        ──► Clash :7890 (test through proxy, full rule matching)
        ──► Clash :9090 /proxies/{name}/delay (node delay)
        ──► POST /api/agent/diagnostic (report to Collector)
  Collector ──► SQLite (persist)
            ──► Frontend (serve via API)
```

## Test Targets

Default target list (built into both Agent and Collector):

| Name | URL | Group | Purpose |
|------|-----|-------|---------|
| Baidu | `https://www.baidu.com/generate_204` | cn | China direct |
| Bilibili | `https://www.bilibili.com/favicon.ico` | cn | China direct |
| Taobao | `https://www.taobao.com/favicon.ico` | cn | China direct |
| Google | `https://www.google.com/generate_204` | proxy | Intl proxy |
| YouTube | `https://www.youtube.com/favicon.ico` | proxy | Intl proxy |
| GitHub | `https://github.com/favicon.ico` | proxy | Intl proxy |
| ChatGPT | `https://chatgpt.com/favicon.ico` | proxy | AI service |
| Claude | `https://claude.ai/favicon.ico` | proxy | AI service |
| Netflix | `https://www.netflix.com/favicon.ico` | streaming | Streaming |
| Spotify | `https://open.spotify.com/favicon.ico` | streaming | Streaming |
| CF Trace | `https://1.0.0.1/cdn-cgi/trace` | exit-ip | Exit IP detection |

Collector can override via config sync (`/api/agent/config`). Agent uses defaults if no override received.

## Test Method

1. **Discover proxy port**: `GET /configs` → read `mixed-port` or `port` field
2. **Probe targets**: HTTP request through `http://<gateway>:<proxy-port>` with 10s timeout
   - For `generate_204` targets: success = HTTP 204 or 200
   - For `favicon.ico` targets: success = any HTTP 2xx/3xx
   - For `/cdn-cgi/trace`: parse response body for `ip=`, `loc=`, `colo=` fields
3. **Node delay test**: `GET /proxies/{name}/delay?timeout=5000&url=https://www.gstatic.com/generate_204` — queries `/proxies` first to find all Selector-type groups, then tests the `now` (currently selected) proxy of each Selector
4. **Frequency**: Every 1 minute (configurable via `--diagnostic-interval` flag in Agent, env var in Collector)

## Agent Report Protocol

```
POST /api/agent/diagnostic
Authorization: Bearer <backend-token>
Content-Encoding: gzip

{
  "backendId": 1,
  "agentId": "abc123",
  "agentVersion": "1.0.0",
  "protocolVersion": 1,
  "timestamp": 1706000000000,
  "probes": [
    {
      "targetName": "google",
      "targetGroup": "proxy",
      "targetUrl": "https://www.google.com/generate_204",
      "status": "ok",
      "latencyMs": 234,
      "httpStatus": 204,
      "exitIp": null,
      "exitCountry": null,
      "colo": null
    }
  ],
  "nodeDelays": [
    {
      "nodeName": "香港01",
      "latencyMs": 45,
      "testUrl": "https://www.gstatic.com/generate_204"
    }
  ]
}
```

## Database Schema

### network_diagnostics table

```sql
CREATE TABLE IF NOT EXISTS network_diagnostics (
  backend_id INTEGER NOT NULL,
  minute TEXT NOT NULL,              -- "YYYY-MM-DDTHH:MM"
  target_name TEXT NOT NULL,
  target_group TEXT NOT NULL,        -- 'cn' | 'proxy' | 'streaming' | 'exit-ip'
  status TEXT NOT NULL,              -- 'ok' | 'timeout' | 'error'
  latency_ms INTEGER,
  http_status INTEGER,
  exit_ip TEXT,
  exit_country TEXT,
  colo TEXT,
  PRIMARY KEY (backend_id, minute, target_name),
  FOREIGN KEY (backend_id) REFERENCES backend_configs(id)
);

CREATE INDEX idx_net_diag_backend_minute ON network_diagnostics(backend_id, minute);
CREATE INDEX idx_net_diag_target ON network_diagnostics(target_name, minute);
```

### node_delay_logs table

```sql
CREATE TABLE IF NOT EXISTS node_delay_logs (
  backend_id INTEGER NOT NULL,
  minute TEXT NOT NULL,
  node_name TEXT NOT NULL,
  latency_ms INTEGER,
  test_url TEXT,
  PRIMARY KEY (backend_id, minute, node_name),
  FOREIGN KEY (backend_id) REFERENCES backend_configs(id)
);

CREATE INDEX idx_node_delay_backend_minute ON node_delay_logs(backend_id, minute);
```

Both tables follow the existing health_logs pattern: minute-level granularity, UPSERT on primary key, retention-based pruning.

## Collector API Endpoints

### POST /api/agent/diagnostic
Receives diagnostic reports from Agent. Auth: Bearer token (same as other agent endpoints).

### GET /api/network/diagnostics
Query diagnostic history. Auth: session cookie.

Query params:
- `start` (required): ISO timestamp
- `end` (required): ISO timestamp
- `backendId` (optional): specific backend, defaults to active
- `targetName` (optional): filter by target
- `targetGroup` (optional): filter by group

Response:
```json
{
  "targets": [
    {
      "name": "google",
      "group": "proxy",
      "points": [
        {
          "minute": "2026-04-04T10:30",
          "status": "ok",
          "latencyMs": 234,
          "httpStatus": 204,
          "exitIp": null,
          "exitCountry": null,
          "colo": null
        }
      ]
    }
  ]
}
```

### GET /api/network/diagnostics/latest
Most recent probe results for all targets. No time range needed.

### GET /api/network/node-delays
Query node delay history. Same query params as diagnostics.

Response:
```json
{
  "nodes": [
    {
      "name": "香港01",
      "points": [
        { "minute": "2026-04-04T10:30", "latencyMs": 45 }
      ]
    }
  ]
}
```

## Collector Direct-Mode Diagnostics

For non-agent backends, the Collector runs diagnostics itself:

- `NetworkDiagnosticsService` in Collector
- Reuses `BackendService` to get gateway URL/token
- Discovers proxy port via `GET /configs`
- Uses `undici.ProxyAgent` to route test traffic through Clash proxy
- Calls `/proxies/{name}/delay` for node tests
- Writes directly to SQLite (same tables)
- Runs on same 1-minute interval
- Only active for backends that are listening AND not agent-type

## Frontend: Network Tab

### Sidebar
New tab "Network" below Health, with a network/globe icon (`Globe` from lucide-react).

### Page Structure

**1. Summary Cards Row** (responsive 6-column grid, same style as Health tab)
- Overall Reachability (% of targets with status=ok)
- China Avg Latency (cn group average)
- Global Avg Latency (proxy group average)
- Unreachable Targets (count of timeout/error)
- Exit IP (from latest cf-trace probe)
- Exit Country + Colo (flag emoji + datacenter code)

**2. Connectivity Matrix** (grouped card grid)
Each group (cn / proxy / streaming) gets a section header and a grid of target cards:
- Status indicator dot (green/yellow/red)
- Target name
- Current latency (ms)
- Sparkline (last 30 data points)

Click a card to scroll to its detail chart below.

**3. Latency Trend Charts** (bottom section)
- One chart per target (or collapsed by default, expand on click)
- Reuse BackendHealthChart's Recharts pattern: AreaChart with reference areas for error periods
- Color-coded latency: green <300ms, amber 300-1000ms, red >1000ms
- Time range synced with dashboard global time range
- Adaptive bucketing: 1-min (≤2h), 5-min (≤12h), 15-min (≤48h), 60-min (>48h)

### Data Fetching
- React Query with 60s refetch interval, 55s stale time
- `keepPreviousData` for smooth range transitions
- Query key: `["networkDiagnostics", start, end, backendId]`

### i18n
New `network` key namespace in messages/en.json and messages/zh.json.

## File Changes Summary

### New Files

**Agent (Go):**
- `apps/agent/internal/diagnostic/runner.go` — diagnostic loop, proxy port discovery, probe execution
- `apps/agent/internal/diagnostic/targets.go` — default target list, trace parser
- `apps/agent/internal/diagnostic/reporter.go` — report batching and HTTP POST to Collector

**Collector (TypeScript):**
- `apps/collector/src/modules/network-diagnostics/network-diagnostics.controller.ts` — API endpoints
- `apps/collector/src/modules/network-diagnostics/network-diagnostics.service.ts` — direct-mode diagnostic runner
- `apps/collector/src/database/repositories/network-diagnostics.repository.ts` — CRUD for both tables

**Frontend:**
- `apps/web/components/features/network/index.tsx` — container component
- `apps/web/components/features/network/connectivity-matrix.tsx` — target card grid
- `apps/web/components/features/network/latency-chart.tsx` — per-target trend chart

### Modified Files

**Agent:**
- `apps/agent/main.go` — add diagnostic runner goroutine
- `apps/agent/internal/config/config.go` — add `--diagnostic-interval`, `--diagnostic-enabled` flags

**Collector:**
- `apps/collector/src/database/schema.ts` — add two new tables
- `apps/collector/src/modules/app/app.ts` — register new routes
- `apps/collector/src/index.ts` — start/stop NetworkDiagnosticsService for direct-mode backends

**Frontend:**
- `apps/web/app/[locale]/dashboard/components/sidebar/` — add Network tab entry
- `apps/web/app/[locale]/dashboard/components/content/` — add Network content rendering
- `apps/web/lib/api.ts` — add diagnostic API client methods
- `apps/web/lib/types/dashboard.ts` — add 'network' to TabId union
- `apps/web/messages/en.json` — add network i18n keys
- `apps/web/messages/zh.json` — add network i18n keys (Chinese)
- `packages/shared/src/index.ts` — add diagnostic types

## Non-Goals (out of scope)
- DNS leak detection (requires custom DNS infrastructure)
- WebRTC leak detection (browser-only, not applicable to server-side agent)
- Speed test / bandwidth measurement (too heavy for 1-min intervals)
- Custom target editor UI (Collector config API is sufficient for now)
