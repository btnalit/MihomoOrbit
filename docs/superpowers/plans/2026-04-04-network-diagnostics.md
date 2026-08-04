# Network Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add active network diagnostics that probe common websites through the user's Clash proxy to measure real-world latency, connectivity, and exit IPs — supporting both agent mode and direct mode.

**Architecture:** Agent (Go) runs probes locally through Clash HTTP proxy and reports to Collector. For direct-mode backends, Collector runs the same probes itself via `undici.ProxyAgent`. Both paths write to the same SQLite tables. Frontend displays results in a new Network tab with summary cards, connectivity matrix, and latency trend charts.

**Tech Stack:** Go 1.22 (agent), TypeScript/Fastify (collector), Next.js/React/Recharts (frontend), SQLite (storage)

**Spec:** `docs/superpowers/specs/2026-04-04-network-diagnostics-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `apps/agent/internal/diagnostic/targets.go` | Default probe target list and Cloudflare trace parser |
| `apps/agent/internal/diagnostic/runner.go` | Diagnostic loop: proxy discovery, HTTP probing, node delay testing, reporting |
| `apps/collector/src/database/repositories/network-diagnostics.repository.ts` | CRUD for `network_diagnostics` and `node_delay_logs` tables |
| `apps/collector/src/modules/network-diagnostics/network-diagnostics.controller.ts` | API endpoints: receive agent reports, serve diagnostic history |
| `apps/collector/src/modules/network-diagnostics/network-diagnostics.service.ts` | Direct-mode diagnostic runner (for non-agent backends) |
| `apps/web/components/features/network/index.tsx` | Network tab container: data fetching, summary cards |
| `apps/web/components/features/network/connectivity-matrix.tsx` | Target card grid grouped by category |
| `apps/web/components/features/network/latency-chart.tsx` | Per-target latency trend chart (Recharts) |

### Modified Files

| File | Change |
|------|--------|
| `apps/agent/internal/config/config.go` | Add `--diagnostic-interval` and `--diagnostic-enabled` flags |
| `apps/agent/main.go` | Start diagnostic goroutine |
| `apps/agent/internal/agent/runner.go` | Add `runDiagnosticLoop` goroutine, increment WaitGroup |
| `apps/collector/src/database/schema.ts` | Add `NETWORK_DIAGNOSTICS` and `NODE_DELAY_LOGS` table definitions + indexes |
| `apps/collector/src/database/repositories/index.ts` | Export new repository |
| `apps/collector/src/modules/db/db.ts` | Register new repository in `repos` |
| `apps/collector/src/modules/app/app.ts` | Register diagnostic controller, add agent endpoint to public routes |
| `apps/collector/src/index.ts` | Start/stop `NetworkDiagnosticsService` for direct-mode backends |
| `apps/web/lib/api.ts` | Add diagnostic API client methods and types |
| `apps/web/components/layout/navigation.tsx` | Add Network tab to NAV_ITEMS |
| `apps/web/app/[locale]/dashboard/components/content/index.tsx` | Replace NetworkContent placeholder with real component |
| `apps/web/messages/en.json` | Add network diagnostic i18n keys |
| `apps/web/messages/zh.json` | Add network diagnostic i18n keys (Chinese) |
| `packages/shared/src/index.ts` | Export diagnostic types |

---

## Task 1: Create Feature Branch

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/network-diagnostics
```

- [ ] **Step 2: Verify branch**

```bash
git branch --show-current
```

Expected: `feat/network-diagnostics`

---

## Task 2: Agent — Diagnostic Targets and Trace Parser

**Files:**
- Create: `apps/agent/internal/diagnostic/targets.go`

- [ ] **Step 1: Create diagnostic directory**

```bash
mkdir -p apps/agent/internal/diagnostic
```

- [ ] **Step 2: Write targets.go**

```go
// apps/agent/internal/diagnostic/targets.go
package diagnostic

import (
	"strings"
)

// Target represents a single probe endpoint.
type Target struct {
	Name  string `json:"targetName"`
	Group string `json:"targetGroup"`
	URL   string `json:"targetUrl"`
}

// DefaultTargets returns the built-in probe list.
func DefaultTargets() []Target {
	return []Target{
		// China direct
		{Name: "baidu", Group: "cn", URL: "https://www.baidu.com/generate_204"},
		{Name: "bilibili", Group: "cn", URL: "https://www.bilibili.com/favicon.ico"},
		{Name: "taobao", Group: "cn", URL: "https://www.taobao.com/favicon.ico"},
		// International proxy
		{Name: "google", Group: "proxy", URL: "https://www.google.com/generate_204"},
		{Name: "youtube", Group: "proxy", URL: "https://www.youtube.com/favicon.ico"},
		{Name: "github", Group: "proxy", URL: "https://github.com/favicon.ico"},
		{Name: "chatgpt", Group: "proxy", URL: "https://chatgpt.com/favicon.ico"},
		{Name: "claude", Group: "proxy", URL: "https://claude.ai/favicon.ico"},
		// Streaming
		{Name: "netflix", Group: "streaming", URL: "https://www.netflix.com/favicon.ico"},
		{Name: "spotify", Group: "streaming", URL: "https://open.spotify.com/favicon.ico"},
		// Exit IP detection
		{Name: "cf-trace", Group: "exit-ip", URL: "https://1.0.0.1/cdn-cgi/trace"},
	}
}

// TraceResult holds parsed Cloudflare /cdn-cgi/trace fields.
type TraceResult struct {
	IP   string
	Loc  string
	Colo string
}

// ParseTrace extracts ip, loc, colo from Cloudflare trace text.
// Format: "key=value\n" lines.
func ParseTrace(body string) TraceResult {
	var r TraceResult
	for _, line := range strings.Split(body, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "ip":
			r.IP = v
		case "loc":
			r.Loc = v
		case "colo":
			r.Colo = v
		}
	}
	return r
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd apps/agent && go build ./internal/diagnostic/
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/agent/internal/diagnostic/targets.go
git commit -m "feat(agent): add diagnostic probe targets and trace parser"
```

---

## Task 3: Agent — Diagnostic Runner

**Files:**
- Create: `apps/agent/internal/diagnostic/runner.go`

- [ ] **Step 1: Write runner.go**

```go
// apps/agent/internal/diagnostic/runner.go
package diagnostic

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ProbeResult is the outcome of a single target probe.
type ProbeResult struct {
	TargetName  string `json:"targetName"`
	TargetGroup string `json:"targetGroup"`
	TargetURL   string `json:"targetUrl"`
	Status      string `json:"status"`      // "ok" | "timeout" | "error"
	LatencyMs   *int64 `json:"latencyMs"`   // nil on failure
	HTTPStatus  *int   `json:"httpStatus"`  // nil on failure
	ExitIP      string `json:"exitIp,omitempty"`
	ExitCountry string `json:"exitCountry,omitempty"`
	Colo        string `json:"colo,omitempty"`
}

// NodeDelay is the outcome of a Clash proxy delay test.
type NodeDelay struct {
	NodeName  string `json:"nodeName"`
	LatencyMs *int64 `json:"latencyMs"` // nil on failure
	TestURL   string `json:"testUrl"`
}

// DiagnosticReport is the payload sent to the collector.
type DiagnosticReport struct {
	BackendID       int            `json:"backendId"`
	AgentID         string         `json:"agentId"`
	AgentVersion    string         `json:"agentVersion"`
	ProtocolVersion int            `json:"protocolVersion"`
	Timestamp       int64          `json:"timestamp"`
	Probes          []ProbeResult  `json:"probes"`
	NodeDelays      []NodeDelay    `json:"nodeDelays"`
}

// RunnerConfig holds the runner's configuration.
type RunnerConfig struct {
	GatewayEndpoint string
	GatewayToken    string
	GatewayType     string
	ServerAPIBase   string
	BackendToken    string
	BackendID       int
	AgentID         string
	AgentVersion    string
	ProtocolVersion int
	Interval        time.Duration
	RequestTimeout  time.Duration
}

// Runner executes periodic network diagnostics.
type Runner struct {
	cfg        RunnerConfig
	targets    []Target
	httpClient *http.Client
}

// NewRunner creates a diagnostic runner with default targets.
func NewRunner(cfg RunnerConfig) *Runner {
	return &Runner{
		cfg:     cfg,
		targets: DefaultTargets(),
		httpClient: &http.Client{
			Timeout: cfg.RequestTimeout,
			// Do not follow redirects — we only care about first response latency
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// Run starts the diagnostic loop. Blocks until ctx is cancelled.
func (r *Runner) Run(ctx context.Context) {
	log.Printf("[diagnostic] starting, interval=%s, targets=%d", r.cfg.Interval, len(r.targets))

	// Run first diagnostic immediately
	r.runOnce(ctx)

	ticker := time.NewTicker(r.cfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("[diagnostic] stopping")
			return
		case <-ticker.C:
			r.runOnce(ctx)
		}
	}
}

func (r *Runner) runOnce(ctx context.Context) {
	// 1. Discover Clash HTTP proxy port
	proxyAddr, err := r.discoverProxyPort(ctx)
	if err != nil {
		log.Printf("[diagnostic] failed to discover proxy port: %v", err)
		return
	}

	// 2. Probe all targets through the proxy
	probes := r.probeTargets(ctx, proxyAddr)

	// 3. Test node delays via Clash API
	nodeDelays := r.testNodeDelays(ctx)

	// 4. Report results to collector
	report := DiagnosticReport{
		BackendID:       r.cfg.BackendID,
		AgentID:         r.cfg.AgentID,
		AgentVersion:    r.cfg.AgentVersion,
		ProtocolVersion: r.cfg.ProtocolVersion,
		Timestamp:       time.Now().UnixMilli(),
		Probes:          probes,
		NodeDelays:      nodeDelays,
	}

	if err := r.sendReport(ctx, report); err != nil {
		log.Printf("[diagnostic] report failed: %v", err)
	} else {
		okCount := 0
		for _, p := range probes {
			if p.Status == "ok" {
				okCount++
			}
		}
		log.Printf("[diagnostic] reported %d probes (%d ok), %d node delays", len(probes), okCount, len(nodeDelays))
	}
}

// discoverProxyPort reads mixed-port from Clash /configs API.
func (r *Runner) discoverProxyPort(ctx context.Context) (string, error) {
	if r.cfg.GatewayType != "clash" {
		return "", fmt.Errorf("diagnostic only supports clash gateway, got %s", r.cfg.GatewayType)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.cfg.GatewayEndpoint+"/configs", nil)
	if err != nil {
		return "", err
	}
	if r.cfg.GatewayToken != "" {
		req.Header.Set("Authorization", "Bearer "+r.cfg.GatewayToken)
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("GET /configs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("GET /configs: HTTP %d", resp.StatusCode)
	}

	var cfg struct {
		MixedPort int `json:"mixed-port"`
		Port      int `json:"port"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		return "", fmt.Errorf("decode /configs: %w", err)
	}

	port := cfg.MixedPort
	if port == 0 {
		port = cfg.Port
	}
	if port == 0 {
		return "", fmt.Errorf("no mixed-port or port found in /configs")
	}

	// Extract host from gateway endpoint
	u, err := url.Parse(r.cfg.GatewayEndpoint)
	if err != nil {
		return "", err
	}
	host := u.Hostname()
	if host == "" {
		host = "127.0.0.1"
	}

	return fmt.Sprintf("http://%s:%d", host, port), nil
}

// probeTargets sends HTTP requests through the Clash proxy for each target.
func (r *Runner) probeTargets(ctx context.Context, proxyAddr string) []ProbeResult {
	proxyURL, _ := url.Parse(proxyAddr)
	transport := &http.Transport{
		Proxy:           http.ProxyURL(proxyURL),
		TLSClientConfig: &tls.Config{InsecureSkipVerify: false},
	}
	proxyClient := &http.Client{
		Timeout:   10 * time.Second,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	defer proxyClient.CloseIdleConnections()

	results := make([]ProbeResult, 0, len(r.targets))
	for _, target := range r.targets {
		result := r.probeOne(ctx, proxyClient, target)
		results = append(results, result)
	}
	return results
}

func (r *Runner) probeOne(ctx context.Context, client *http.Client, target Target) ProbeResult {
	result := ProbeResult{
		TargetName:  target.Name,
		TargetGroup: target.Group,
		TargetURL:   target.URL,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.URL, nil)
	if err != nil {
		result.Status = "error"
		return result
	}
	req.Header.Set("User-Agent", "neko-agent-diagnostic/1.0")

	start := time.Now()
	resp, err := client.Do(req)
	latencyMs := time.Since(start).Milliseconds()

	if err != nil {
		if ctx.Err() != nil {
			result.Status = "timeout"
		} else if strings.Contains(err.Error(), "timeout") || strings.Contains(err.Error(), "deadline") {
			result.Status = "timeout"
		} else {
			result.Status = "error"
		}
		return result
	}
	defer resp.Body.Close()

	result.LatencyMs = &latencyMs
	httpStatus := resp.StatusCode
	result.HTTPStatus = &httpStatus

	// Determine success: 2xx or 3xx or 204
	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		result.Status = "ok"
	} else {
		result.Status = "error"
	}

	// Parse Cloudflare trace response for exit-ip group
	if target.Group == "exit-ip" && resp.StatusCode == 200 {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if err == nil {
			trace := ParseTrace(string(body))
			result.ExitIP = trace.IP
			result.ExitCountry = trace.Loc
			result.Colo = trace.Colo
		}
	}

	return result
}

// testNodeDelays calls Clash /proxies/{name}/delay for active selector nodes.
func (r *Runner) testNodeDelays(ctx context.Context) []NodeDelay {
	if r.cfg.GatewayType != "clash" {
		return nil
	}

	// 1. Get all proxies
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.cfg.GatewayEndpoint+"/proxies", nil)
	if err != nil {
		return nil
	}
	if r.cfg.GatewayToken != "" {
		req.Header.Set("Authorization", "Bearer "+r.cfg.GatewayToken)
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		log.Printf("[diagnostic] GET /proxies failed: %v", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil
	}

	var proxiesResp struct {
		Proxies map[string]struct {
			Type string `json:"type"`
			Now  string `json:"now"`
		} `json:"proxies"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&proxiesResp); err != nil {
		return nil
	}

	// 2. Find Selector groups and their current selections
	testURL := "https://www.gstatic.com/generate_204"
	seen := make(map[string]bool)
	var delays []NodeDelay

	for _, proxy := range proxiesResp.Proxies {
		if proxy.Type != "Selector" || proxy.Now == "" {
			continue
		}
		nodeName := proxy.Now
		if seen[nodeName] {
			continue
		}
		seen[nodeName] = true

		// 3. Test delay for this node
		delay := r.testOneNodeDelay(ctx, nodeName, testURL)
		delays = append(delays, delay)
	}

	return delays
}

func (r *Runner) testOneNodeDelay(ctx context.Context, nodeName, testURL string) NodeDelay {
	result := NodeDelay{NodeName: nodeName, TestURL: testURL}

	endpoint := fmt.Sprintf("%s/proxies/%s/delay?timeout=5000&url=%s",
		r.cfg.GatewayEndpoint, url.PathEscape(nodeName), url.QueryEscape(testURL))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return result
	}
	if r.cfg.GatewayToken != "" {
		req.Header.Set("Authorization", "Bearer "+r.cfg.GatewayToken)
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return result
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return result
	}

	var delayResp struct {
		Delay int64 `json:"delay"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&delayResp); err != nil {
		return result
	}

	result.LatencyMs = &delayResp.Delay
	return result
}

// sendReport POSTs the diagnostic report to the collector (gzip compressed).
func (r *Runner) sendReport(ctx context.Context, report DiagnosticReport) error {
	body, err := json.Marshal(report)
	if err != nil {
		return err
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err = gz.Write(body); err != nil {
		return err
	}
	if err = gz.Close(); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.cfg.ServerAPIBase+"/network/agent/diagnostic", &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+r.cfg.BackendToken)

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("server HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/agent && go build ./internal/diagnostic/
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/agent/internal/diagnostic/runner.go
git commit -m "feat(agent): add diagnostic runner with proxy probing and node delay testing"
```

---

## Task 4: Agent — Wire Diagnostics into Config and Main

**Files:**
- Modify: `apps/agent/internal/config/config.go`
- Modify: `apps/agent/internal/agent/runner.go`
- Modify: `apps/agent/main.go`

- [ ] **Step 1: Add config flags in config.go**

Add two new fields to the `Config` struct:

```go
// In Config struct, after StaleFlowTimeout:
DiagnosticEnabled  bool
DiagnosticInterval time.Duration
```

Add flag parsing in the `Parse` function, after the `staleFlowTimeout` flag:

```go
diagnosticEnabled := fs.Bool("diagnostic-enabled", true, "Enable network diagnostics probing")
diagnosticInterval := fs.Duration("diagnostic-interval", 1*time.Minute, "Network diagnostic probe interval")
```

Add to the return `Config{}` struct:

```go
DiagnosticEnabled:  *diagnosticEnabled,
DiagnosticInterval: *diagnosticInterval,
```

Add to `Usage()` optional section:

```go
"  --diagnostic-enabled   enable network diagnostics (default true)",
"  --diagnostic-interval  diagnostic probe interval (default 1m)",
```

- [ ] **Step 2: Add diagnostic goroutine in runner.go**

In `runner.go`, add the import:

```go
"github.com/foru17/neko-master/apps/agent/internal/diagnostic"
```

Add a new field to the Runner struct:

```go
diagRunner *diagnostic.Runner
```

In `NewRunner()`, after the existing initialization, add:

```go
var diagRunner *diagnostic.Runner
if cfg.DiagnosticEnabled && cfg.GatewayType == "clash" {
    diagRunner = diagnostic.NewRunner(diagnostic.RunnerConfig{
        GatewayEndpoint: cfg.GatewayEndpoint,
        GatewayToken:    cfg.GatewayToken,
        GatewayType:     cfg.GatewayType,
        ServerAPIBase:   cfg.ServerAPIBase,
        BackendToken:    cfg.BackendToken,
        BackendID:       cfg.BackendID,
        AgentID:         cfg.AgentID,
        AgentVersion:    config.AgentVersion,
        ProtocolVersion: config.AgentProtocolVersion,
        Interval:        cfg.DiagnosticInterval,
        RequestTimeout:  cfg.RequestTimeout,
    })
}
```

Store `diagRunner` in the Runner struct.

In `Run()`, change `wg.Add(5)` to `wg.Add(6)` and add:

```go
go r.runDiagnosticLoop(ctx, &wg)
```

Add the new method:

```go
func (r *Runner) runDiagnosticLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	if r.diagRunner == nil {
		log.Printf("[agent:%s] diagnostics disabled (not clash or --diagnostic-enabled=false)", r.cfg.AgentID)
		return
	}
	r.diagRunner.Run(ctx)
}
```

- [ ] **Step 3: Verify full agent builds**

```bash
cd apps/agent && go build .
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/agent/internal/config/config.go apps/agent/internal/agent/runner.go apps/agent/main.go
git commit -m "feat(agent): wire diagnostic runner into agent lifecycle"
```

---

## Task 5: Collector — Database Schema

**Files:**
- Modify: `apps/collector/src/database/schema.ts`

- [ ] **Step 1: Add table definitions in SCHEMA object**

In `schema.ts`, add before the closing `} as const;` of the SCHEMA object (before line 444):

```typescript
  NETWORK_DIAGNOSTICS: `
    CREATE TABLE IF NOT EXISTS network_diagnostics (
      backend_id INTEGER NOT NULL,
      minute TEXT NOT NULL,
      target_name TEXT NOT NULL,
      target_group TEXT NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      http_status INTEGER,
      exit_ip TEXT,
      exit_country TEXT,
      colo TEXT,
      PRIMARY KEY (backend_id, minute, target_name),
      FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
    );
  `,

  NODE_DELAY_LOGS: `
    CREATE TABLE IF NOT EXISTS node_delay_logs (
      backend_id INTEGER NOT NULL,
      minute TEXT NOT NULL,
      node_name TEXT NOT NULL,
      latency_ms INTEGER,
      test_url TEXT,
      PRIMARY KEY (backend_id, minute, node_name),
      FOREIGN KEY (backend_id) REFERENCES backend_configs(id) ON DELETE CASCADE
    );
  `,
```

- [ ] **Step 2: Add indexes to INDEXES array**

In the `INDEXES` array, add:

```typescript
  // Network diagnostics indexes
  `CREATE INDEX IF NOT EXISTS idx_net_diag_backend_minute ON network_diagnostics(backend_id, minute);`,
  `CREATE INDEX IF NOT EXISTS idx_net_diag_target ON network_diagnostics(target_name, minute);`,
  `CREATE INDEX IF NOT EXISTS idx_node_delay_backend_minute ON node_delay_logs(backend_id, minute);`,
```

- [ ] **Step 3: Add tables to getSchemaStatements()**

In the `getSchemaStatements()` function, add before the `...INDEXES` line:

```typescript
    SCHEMA.NETWORK_DIAGNOSTICS,
    SCHEMA.NODE_DELAY_LOGS,
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
pnpm --filter collector exec tsc --noEmit
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/collector/src/database/schema.ts
git commit -m "feat(collector): add network_diagnostics and node_delay_logs tables"
```

---

## Task 6: Collector — Network Diagnostics Repository

**Files:**
- Create: `apps/collector/src/database/repositories/network-diagnostics.repository.ts`
- Modify: `apps/collector/src/database/repositories/index.ts`
- Modify: `apps/collector/src/modules/db/db.ts`

- [ ] **Step 1: Write the repository**

```typescript
// apps/collector/src/database/repositories/network-diagnostics.repository.ts
import type Database from 'better-sqlite3';

export type DiagnosticStatus = 'ok' | 'timeout' | 'error';

export interface NetworkDiagnosticRow {
  backend_id: number;
  minute: string;
  target_name: string;
  target_group: string;
  status: DiagnosticStatus;
  latency_ms: number | null;
  http_status: number | null;
  exit_ip: string | null;
  exit_country: string | null;
  colo: string | null;
}

export interface NodeDelayRow {
  backend_id: number;
  minute: string;
  node_name: string;
  latency_ms: number | null;
  test_url: string | null;
}

export class NetworkDiagnosticsRepository {
  constructor(private db: Database.Database) {}

  writeDiagnostic(
    backendId: number,
    minute: string,
    targetName: string,
    targetGroup: string,
    status: DiagnosticStatus,
    latencyMs?: number | null,
    httpStatus?: number | null,
    exitIp?: string | null,
    exitCountry?: string | null,
    colo?: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO network_diagnostics (backend_id, minute, target_name, target_group, status, latency_ms, http_status, exit_ip, exit_country, colo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, minute, target_name) DO UPDATE SET
        target_group = excluded.target_group,
        status = excluded.status,
        latency_ms = excluded.latency_ms,
        http_status = excluded.http_status,
        exit_ip = excluded.exit_ip,
        exit_country = excluded.exit_country,
        colo = excluded.colo
    `).run(
      backendId, minute, targetName, targetGroup, status,
      latencyMs ?? null, httpStatus ?? null,
      exitIp ?? null, exitCountry ?? null, colo ?? null,
    );
  }

  writeNodeDelay(
    backendId: number,
    minute: string,
    nodeName: string,
    latencyMs: number | null,
    testUrl: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO node_delay_logs (backend_id, minute, node_name, latency_ms, test_url)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, minute, node_name) DO UPDATE SET
        latency_ms = excluded.latency_ms,
        test_url = excluded.test_url
    `).run(backendId, minute, nodeName, latencyMs, testUrl);
  }

  getDiagnostics(
    backendId: number,
    fromISO: string,
    toISO: string,
    targetName?: string,
    targetGroup?: string,
  ): NetworkDiagnosticRow[] {
    let sql = `
      SELECT backend_id, minute, target_name, target_group, status, latency_ms, http_status, exit_ip, exit_country, colo
      FROM network_diagnostics
      WHERE backend_id = ? AND minute >= ? AND minute <= ?
    `;
    const params: unknown[] = [backendId, fromISO, toISO];

    if (targetName) {
      sql += ` AND target_name = ?`;
      params.push(targetName);
    }
    if (targetGroup) {
      sql += ` AND target_group = ?`;
      params.push(targetGroup);
    }

    sql += ` ORDER BY minute ASC, target_name ASC`;
    return this.db.prepare(sql).all(...params) as NetworkDiagnosticRow[];
  }

  getLatestDiagnostics(backendId: number): NetworkDiagnosticRow[] {
    return this.db.prepare(`
      SELECT d.backend_id, d.minute, d.target_name, d.target_group, d.status,
             d.latency_ms, d.http_status, d.exit_ip, d.exit_country, d.colo
      FROM network_diagnostics d
      INNER JOIN (
        SELECT target_name, MAX(minute) as max_minute
        FROM network_diagnostics
        WHERE backend_id = ?
        GROUP BY target_name
      ) latest ON d.target_name = latest.target_name AND d.minute = latest.max_minute
      WHERE d.backend_id = ?
      ORDER BY d.target_group ASC, d.target_name ASC
    `).all(backendId, backendId) as NetworkDiagnosticRow[];
  }

  getNodeDelays(
    backendId: number,
    fromISO: string,
    toISO: string,
  ): NodeDelayRow[] {
    return this.db.prepare(`
      SELECT backend_id, minute, node_name, latency_ms, test_url
      FROM node_delay_logs
      WHERE backend_id = ? AND minute >= ? AND minute <= ?
      ORDER BY minute ASC, node_name ASC
    `).all(backendId, fromISO, toISO) as NodeDelayRow[];
  }

  pruneOldLogs(retentionDays: number): void {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
      .toISOString()
      .slice(0, 16);
    this.db.prepare(`DELETE FROM network_diagnostics WHERE minute < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM node_delay_logs WHERE minute < ?`).run(cutoff);
  }

  deleteByBackend(backendId: number): void {
    this.db.prepare(`DELETE FROM network_diagnostics WHERE backend_id = ?`).run(backendId);
    this.db.prepare(`DELETE FROM node_delay_logs WHERE backend_id = ?`).run(backendId);
  }
}
```

- [ ] **Step 2: Export from index.ts**

Add to `apps/collector/src/database/repositories/index.ts`:

```typescript
export { NetworkDiagnosticsRepository, type NetworkDiagnosticRow, type NodeDelayRow, type DiagnosticStatus } from './network-diagnostics.repository.js';
```

- [ ] **Step 3: Register in db.ts**

In `apps/collector/src/modules/db/db.ts`:

Add import:
```typescript
NetworkDiagnosticsRepository,
```

Add to `repos` type:
```typescript
networkDiagnostics: NetworkDiagnosticsRepository;
```

Add to `repos` initialization:
```typescript
networkDiagnostics: new NetworkDiagnosticsRepository(this.db),
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
pnpm --filter collector exec tsc --noEmit
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/collector/src/database/repositories/network-diagnostics.repository.ts \
       apps/collector/src/database/repositories/index.ts \
       apps/collector/src/modules/db/db.ts
git commit -m "feat(collector): add network diagnostics repository"
```

---

## Task 7: Collector — Network Diagnostics Controller

**Files:**
- Create: `apps/collector/src/modules/network-diagnostics/network-diagnostics.controller.ts`

- [ ] **Step 1: Create directory and write controller**

```bash
mkdir -p apps/collector/src/modules/network-diagnostics
```

```typescript
// apps/collector/src/modules/network-diagnostics/network-diagnostics.controller.ts
import type { FastifyPluginAsync } from 'fastify';

export const networkDiagnosticsController: FastifyPluginAsync = async (fastify) => {
  const { db, backendService } = fastify;

  // ─── Agent report endpoint ─────────────────────────────────
  fastify.post<{ Body: {
    backendId?: number;
    agentId?: string;
    agentVersion?: string;
    protocolVersion?: number;
    timestamp?: number;
    probes?: Array<{
      targetName: string;
      targetGroup: string;
      targetUrl: string;
      status: string;
      latencyMs: number | null;
      httpStatus: number | null;
      exitIp?: string;
      exitCountry?: string;
      colo?: string;
    }>;
    nodeDelays?: Array<{
      nodeName: string;
      latencyMs: number | null;
      testUrl: string;
    }>;
  } }>('/agent/diagnostic', async (request, reply) => {
    const { backendId, probes, nodeDelays } = request.body;
    if (!backendId || !probes) {
      return reply.status(400).send({ error: 'backendId and probes are required' });
    }

    const minute = new Date().toISOString().slice(0, 16);

    for (const probe of probes) {
      db.repos.networkDiagnostics.writeDiagnostic(
        backendId,
        minute,
        probe.targetName,
        probe.targetGroup,
        probe.status as 'ok' | 'timeout' | 'error',
        probe.latencyMs,
        probe.httpStatus,
        probe.exitIp ?? null,
        probe.exitCountry ?? null,
        probe.colo ?? null,
      );
    }

    if (nodeDelays) {
      for (const nd of nodeDelays) {
        db.repos.networkDiagnostics.writeNodeDelay(
          backendId,
          minute,
          nd.nodeName,
          nd.latencyMs,
          nd.testUrl,
        );
      }
    }

    return { ok: true };
  });

  // ─── Query diagnostic history ──────────────────────────────
  fastify.get<{ Querystring: {
    start?: string;
    end?: string;
    backendId?: string;
    targetName?: string;
    targetGroup?: string;
  } }>('/diagnostics', async (request, reply) => {
    const { start, end, backendId: bidStr, targetName, targetGroup } = request.query;

    const toISO = (end ?? new Date().toISOString()).slice(0, 16);
    const fromISO = (start ?? new Date(Date.now() - 24 * 3600_000).toISOString()).slice(0, 16);

    let backendId: number;
    if (bidStr) {
      backendId = parseInt(bidStr, 10);
      if (Number.isNaN(backendId)) {
        return reply.status(400).send({ error: 'Invalid backendId' });
      }
    } else {
      const active = backendService.getActiveBackend();
      if (!active) {
        return { targets: [] };
      }
      backendId = active.id;
    }

    const rows = db.repos.networkDiagnostics.getDiagnostics(backendId, fromISO, toISO, targetName, targetGroup);

    // Group rows by target_name
    const targetMap = new Map<string, { name: string; group: string; points: Array<{
      minute: string;
      status: string;
      latencyMs: number | null;
      httpStatus: number | null;
      exitIp: string | null;
      exitCountry: string | null;
      colo: string | null;
    }> }>();

    for (const row of rows) {
      let target = targetMap.get(row.target_name);
      if (!target) {
        target = { name: row.target_name, group: row.target_group, points: [] };
        targetMap.set(row.target_name, target);
      }
      target.points.push({
        minute: row.minute,
        status: row.status,
        latencyMs: row.latency_ms,
        httpStatus: row.http_status,
        exitIp: row.exit_ip,
        exitCountry: row.exit_country,
        colo: row.colo,
      });
    }

    return { targets: Array.from(targetMap.values()) };
  });

  // ─── Latest diagnostic results ─────────────────────────────
  fastify.get<{ Querystring: { backendId?: string } }>('/diagnostics/latest', async (request, reply) => {
    const { backendId: bidStr } = request.query;

    let backendId: number;
    if (bidStr) {
      backendId = parseInt(bidStr, 10);
      if (Number.isNaN(backendId)) {
        return reply.status(400).send({ error: 'Invalid backendId' });
      }
    } else {
      const active = backendService.getActiveBackend();
      if (!active) {
        return { results: [] };
      }
      backendId = active.id;
    }

    const rows = db.repos.networkDiagnostics.getLatestDiagnostics(backendId);
    return {
      results: rows.map(row => ({
        targetName: row.target_name,
        targetGroup: row.target_group,
        minute: row.minute,
        status: row.status,
        latencyMs: row.latency_ms,
        httpStatus: row.http_status,
        exitIp: row.exit_ip,
        exitCountry: row.exit_country,
        colo: row.colo,
      })),
    };
  });

  // ─── Node delay history ────────────────────────────────────
  fastify.get<{ Querystring: {
    start?: string;
    end?: string;
    backendId?: string;
  } }>('/node-delays', async (request, reply) => {
    const { start, end, backendId: bidStr } = request.query;

    const toISO = (end ?? new Date().toISOString()).slice(0, 16);
    const fromISO = (start ?? new Date(Date.now() - 24 * 3600_000).toISOString()).slice(0, 16);

    let backendId: number;
    if (bidStr) {
      backendId = parseInt(bidStr, 10);
      if (Number.isNaN(backendId)) {
        return reply.status(400).send({ error: 'Invalid backendId' });
      }
    } else {
      const active = backendService.getActiveBackend();
      if (!active) {
        return { nodes: [] };
      }
      backendId = active.id;
    }

    const rows = db.repos.networkDiagnostics.getNodeDelays(backendId, fromISO, toISO);

    // Group by node_name
    const nodeMap = new Map<string, { name: string; points: Array<{ minute: string; latencyMs: number | null }> }>();
    for (const row of rows) {
      let node = nodeMap.get(row.node_name);
      if (!node) {
        node = { name: row.node_name, points: [] };
        nodeMap.set(row.node_name, node);
      }
      node.points.push({ minute: row.minute, latencyMs: row.latency_ms });
    }

    return { nodes: Array.from(nodeMap.values()) };
  });
};
```

- [ ] **Step 2: Register controller in app.ts**

In `apps/collector/src/modules/app/app.ts`:

Add import at the top:
```typescript
import { networkDiagnosticsController } from '../network-diagnostics/network-diagnostics.controller.js';
```

Add controller registration alongside the other controllers:
```typescript
await app.register(networkDiagnosticsController, { prefix: '/api/network' });
```

The agent POST route will be at `/api/network/agent/diagnostic`. Add it to the public routes array (in the auth middleware `onRequest` hook):
```typescript
'/api/network/agent/diagnostic',
```

Also update the Agent Go code in `runner.go` to POST to `/agent/diagnostic` (which is appended to `ServerAPIBase` which already ends with `/api`), resulting in the full path `/api/agent/diagnostic`. Since the controller is registered at `/api/network`, the actual route in the controller is `/agent/diagnostic`, making the full path `/api/network/agent/diagnostic`. We need to make the agent POST to `/network/agent/diagnostic` instead:

In `runner.go` `sendReport`, change the path:
```go
req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.cfg.ServerAPIBase+"/network/agent/diagnostic", &buf)
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm --filter collector exec tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/collector/src/modules/network-diagnostics/network-diagnostics.controller.ts \
       apps/collector/src/modules/app/app.ts
git commit -m "feat(collector): add network diagnostics controller with agent report and query endpoints"
```

---

## Task 8: Collector — Direct-Mode Diagnostics Service

**Files:**
- Create: `apps/collector/src/modules/network-diagnostics/network-diagnostics.service.ts`
- Modify: `apps/collector/src/index.ts`

- [ ] **Step 1: Write the service**

```typescript
// apps/collector/src/modules/network-diagnostics/network-diagnostics.service.ts
import { ProxyAgent } from 'undici';
import type { StatsDatabase } from '../db/db.js';
import type { BackendConfig } from '../../database/repositories/index.js';
import { buildGatewayHeaders, getGatewayBaseUrl, isAgentBackendUrl } from '@neko-master/shared';

interface DiagTarget {
  name: string;
  group: string;
  url: string;
}

const DEFAULT_TARGETS: DiagTarget[] = [
  { name: 'baidu', group: 'cn', url: 'https://www.baidu.com/generate_204' },
  { name: 'bilibili', group: 'cn', url: 'https://www.bilibili.com/favicon.ico' },
  { name: 'taobao', group: 'cn', url: 'https://www.taobao.com/favicon.ico' },
  { name: 'google', group: 'proxy', url: 'https://www.google.com/generate_204' },
  { name: 'youtube', group: 'proxy', url: 'https://www.youtube.com/favicon.ico' },
  { name: 'github', group: 'proxy', url: 'https://github.com/favicon.ico' },
  { name: 'chatgpt', group: 'proxy', url: 'https://chatgpt.com/favicon.ico' },
  { name: 'claude', group: 'proxy', url: 'https://claude.ai/favicon.ico' },
  { name: 'netflix', group: 'streaming', url: 'https://www.netflix.com/favicon.ico' },
  { name: 'spotify', group: 'streaming', url: 'https://open.spotify.com/favicon.ico' },
  { name: 'cf-trace', group: 'exit-ip', url: 'https://1.0.0.1/cdn-cgi/trace' },
];

export class NetworkDiagnosticsService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private targets = DEFAULT_TARGETS;

  constructor(
    private db: StatsDatabase,
    private getListeningBackends: () => BackendConfig[],
    private intervalMs = 60_000,
  ) {}

  start(): void {
    console.log(`[NetworkDiag] Starting direct-mode diagnostics, interval=${this.intervalMs}ms`);
    // Run first check after a short delay to let backends initialize
    setTimeout(() => this.runAll(), 5_000);
    this.intervalId = setInterval(() => this.runAll(), this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async runAll(): Promise<void> {
    const backends = this.getListeningBackends();

    for (const backend of backends) {
      // Skip agent-mode backends — they handle their own diagnostics
      if (isAgentBackendUrl(backend.url)) continue;
      // Only support clash for now
      if (backend.type !== 'clash') continue;

      try {
        await this.runForBackend(backend);
      } catch (err) {
        console.error(`[NetworkDiag] Backend ${backend.id} error:`, err);
      }
    }
  }

  private async runForBackend(backend: BackendConfig): Promise<void> {
    const baseUrl = getGatewayBaseUrl(backend.url);
    const headers = buildGatewayHeaders(backend);

    // 1. Discover proxy port
    const proxyAddr = await this.discoverProxyPort(baseUrl, headers);
    if (!proxyAddr) return;

    const minute = new Date().toISOString().slice(0, 16);

    // 2. Probe targets through proxy
    const dispatcher = new ProxyAgent(proxyAddr);
    try {
      for (const target of this.targets) {
        const result = await this.probeOne(dispatcher, target);
        this.db.repos.networkDiagnostics.writeDiagnostic(
          backend.id, minute, target.name, target.group,
          result.status, result.latencyMs, result.httpStatus,
          result.exitIp, result.exitCountry, result.colo,
        );
      }
    } finally {
      await dispatcher.close();
    }

    // 3. Test node delays
    await this.testNodeDelays(backend, baseUrl, headers, minute);
  }

  private async discoverProxyPort(baseUrl: string, headers: Record<string, string>): Promise<string | null> {
    try {
      const resp = await fetch(`${baseUrl}/configs`, { headers, signal: AbortSignal.timeout(5_000) });
      if (!resp.ok) return null;
      const cfg = await resp.json() as { 'mixed-port'?: number; port?: number };
      const port = cfg['mixed-port'] || cfg.port;
      if (!port) return null;

      const host = new URL(baseUrl).hostname || '127.0.0.1';
      return `http://${host}:${port}`;
    } catch {
      return null;
    }
  }

  private async probeOne(
    dispatcher: ProxyAgent,
    target: DiagTarget,
  ): Promise<{
    status: 'ok' | 'timeout' | 'error';
    latencyMs: number | null;
    httpStatus: number | null;
    exitIp: string | null;
    exitCountry: string | null;
    colo: string | null;
  }> {
    const start = performance.now();
    try {
      const resp = await fetch(target.url, {
        dispatcher,
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
        headers: { 'User-Agent': 'neko-collector-diagnostic/1.0' },
      });

      const latencyMs = Math.round(performance.now() - start);
      const status = resp.status >= 200 && resp.status < 400 ? 'ok' as const : 'error' as const;

      let exitIp: string | null = null;
      let exitCountry: string | null = null;
      let colo: string | null = null;

      if (target.group === 'exit-ip' && resp.ok) {
        const text = await resp.text();
        for (const line of text.split('\n')) {
          const [k, v] = line.split('=');
          if (k === 'ip') exitIp = v;
          else if (k === 'loc') exitCountry = v;
          else if (k === 'colo') colo = v;
        }
      }

      return { status, latencyMs, httpStatus: resp.status, exitIp, exitCountry, colo };
    } catch (err) {
      const isTimeout = err instanceof Error &&
        (err.message.includes('timeout') || err.message.includes('abort'));
      return {
        status: isTimeout ? 'timeout' : 'error',
        latencyMs: null, httpStatus: null,
        exitIp: null, exitCountry: null, colo: null,
      };
    }
  }

  private async testNodeDelays(
    backend: BackendConfig,
    baseUrl: string,
    headers: Record<string, string>,
    minute: string,
  ): Promise<void> {
    try {
      const resp = await fetch(`${baseUrl}/proxies`, { headers, signal: AbortSignal.timeout(5_000) });
      if (!resp.ok) return;
      const data = await resp.json() as {
        proxies: Record<string, { type: string; now?: string }>;
      };

      const testUrl = 'https://www.gstatic.com/generate_204';
      const seen = new Set<string>();

      for (const proxy of Object.values(data.proxies)) {
        if (proxy.type !== 'Selector' || !proxy.now) continue;
        if (seen.has(proxy.now)) continue;
        seen.add(proxy.now);

        try {
          const delayResp = await fetch(
            `${baseUrl}/proxies/${encodeURIComponent(proxy.now)}/delay?timeout=5000&url=${encodeURIComponent(testUrl)}`,
            { headers, signal: AbortSignal.timeout(6_000) },
          );
          if (delayResp.ok) {
            const { delay } = await delayResp.json() as { delay: number };
            this.db.repos.networkDiagnostics.writeNodeDelay(backend.id, minute, proxy.now, delay, testUrl);
          } else {
            this.db.repos.networkDiagnostics.writeNodeDelay(backend.id, minute, proxy.now, null, testUrl);
          }
        } catch {
          this.db.repos.networkDiagnostics.writeNodeDelay(backend.id, minute, proxy.now, null, testUrl);
        }
      }
    } catch (err) {
      console.error(`[NetworkDiag] Node delay test failed for backend ${backend.id}:`, err);
    }
  }
}
```

- [ ] **Step 2: Wire service into index.ts**

In `apps/collector/src/index.ts`, add import:
```typescript
import { NetworkDiagnosticsService } from './modules/network-diagnostics/network-diagnostics.service.js';
```

Add a module-level variable:
```typescript
let networkDiagService: NetworkDiagnosticsService | undefined;
```

In the `main()` function, after `apiServer.start()`, add:
```typescript
networkDiagService = new NetworkDiagnosticsService(
  db,
  () => db.repos.backend.getAll().filter(b => b.listening),
);
networkDiagService.start();
```

In the `shutdown()` function, add before `db?.close()`:
```typescript
networkDiagService?.stop();
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm --filter collector exec tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/collector/src/modules/network-diagnostics/network-diagnostics.service.ts \
       apps/collector/src/index.ts
git commit -m "feat(collector): add direct-mode network diagnostics service"
```

---

## Task 9: Shared Types

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add diagnostic types**

Add to `packages/shared/src/index.ts`:

```typescript
// ─── Network Diagnostics ─────────────────────────────────────
export interface NetworkDiagnosticPoint {
  minute: string;
  status: 'ok' | 'timeout' | 'error';
  latencyMs: number | null;
  httpStatus: number | null;
  exitIp: string | null;
  exitCountry: string | null;
  colo: string | null;
}

export interface NetworkDiagnosticTarget {
  name: string;
  group: string;
  points: NetworkDiagnosticPoint[];
}

export interface NetworkDiagnosticsResponse {
  targets: NetworkDiagnosticTarget[];
}

export interface NetworkDiagnosticLatest {
  targetName: string;
  targetGroup: string;
  minute: string;
  status: 'ok' | 'timeout' | 'error';
  latencyMs: number | null;
  httpStatus: number | null;
  exitIp: string | null;
  exitCountry: string | null;
  colo: string | null;
}

export interface NodeDelayPoint {
  minute: string;
  latencyMs: number | null;
}

export interface NodeDelayEntry {
  name: string;
  points: NodeDelayPoint[];
}

export interface NodeDelaysResponse {
  nodes: NodeDelayEntry[];
}
```

- [ ] **Step 2: Verify shared package compiles**

```bash
pnpm --filter shared exec tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add network diagnostic types"
```

---

## Task 10: Frontend — API Client Methods

**Files:**
- Modify: `apps/web/lib/api.ts`

- [ ] **Step 1: Add diagnostic API methods**

Add the following type imports (or inline types) and API methods in `api.ts`, after the existing `getBackendHealthHistory` method:

```typescript
// Network Diagnostics types
export interface NetworkDiagnosticPoint {
  minute: string;
  status: 'ok' | 'timeout' | 'error';
  latencyMs: number | null;
  httpStatus: number | null;
  exitIp: string | null;
  exitCountry: string | null;
  colo: string | null;
}

export interface NetworkDiagnosticTarget {
  name: string;
  group: string;
  points: NetworkDiagnosticPoint[];
}

export interface NetworkDiagnosticLatest {
  targetName: string;
  targetGroup: string;
  minute: string;
  status: 'ok' | 'timeout' | 'error';
  latencyMs: number | null;
  httpStatus: number | null;
  exitIp: string | null;
  exitCountry: string | null;
  colo: string | null;
}

export interface NodeDelayEntry {
  name: string;
  points: { minute: string; latencyMs: number | null }[];
}
```

Add API methods to the `api` object:

```typescript
getNetworkDiagnostics: (opts?: { from?: string; to?: string; backendId?: number }) =>
  fetchJson<{ targets: NetworkDiagnosticTarget[] }>(
    buildUrl(`${API_BASE}/network/diagnostics`, {
      start: opts?.from,
      end: opts?.to,
      backendId: opts?.backendId,
    })
  ),

getNetworkDiagnosticsLatest: (opts?: { backendId?: number }) =>
  fetchJson<{ results: NetworkDiagnosticLatest[] }>(
    buildUrl(`${API_BASE}/network/diagnostics/latest`, {
      backendId: opts?.backendId,
    })
  ),

getNodeDelays: (opts?: { from?: string; to?: string; backendId?: number }) =>
  fetchJson<{ nodes: NodeDelayEntry[] }>(
    buildUrl(`${API_BASE}/network/node-delays`, {
      start: opts?.from,
      end: opts?.to,
      backendId: opts?.backendId,
    })
  ),
```

- [ ] **Step 2: Verify frontend compiles**

```bash
pnpm --filter web exec tsc --noEmit
```

Expected: no errors (or only pre-existing warnings)

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): add network diagnostics API client methods"
```

---

## Task 11: Frontend — i18n Keys

**Files:**
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh.json`

- [ ] **Step 1: Replace network section in en.json**

Replace the existing `"network"` section:

```json
"network": {
  "title": "Network",
  "subtitle": "Monitor exit IPs, service connectivity, and latency through your proxy",
  "reachability": "Reachability",
  "cnLatency": "China Avg",
  "globalLatency": "Global Avg",
  "unreachable": "Unreachable",
  "exitIp": "Exit IP",
  "exitLocation": "Exit Location",
  "groupCn": "China Direct",
  "groupProxy": "International",
  "groupStreaming": "Streaming",
  "groupExitIp": "Exit Detection",
  "statusOk": "Reachable",
  "statusTimeout": "Timeout",
  "statusError": "Unreachable",
  "latency": "Latency",
  "latencyMs": "{n}ms",
  "latencyTrend": "Latency Trend",
  "nodeDelays": "Node Delays",
  "noData": "No diagnostic data yet",
  "noDataHint": "Network diagnostics run automatically every minute for all enabled backends",
  "lastChecked": "Last checked",
  "granularity": "Bucket Size",
  "minuteBucket": "{n} min/bar",
  "hourBucket": "{n} hr/bar"
}
```

- [ ] **Step 2: Replace network section in zh.json**

```json
"network": {
  "title": "网络",
  "subtitle": "监控代理出口 IP、常见网站连通性和延迟",
  "reachability": "可达率",
  "cnLatency": "国内均延",
  "globalLatency": "国际均延",
  "unreachable": "不可达",
  "exitIp": "出口 IP",
  "exitLocation": "出口位置",
  "groupCn": "国内直连",
  "groupProxy": "国际代理",
  "groupStreaming": "流媒体",
  "groupExitIp": "出口检测",
  "statusOk": "可达",
  "statusTimeout": "超时",
  "statusError": "不可达",
  "latency": "延迟",
  "latencyMs": "{n}ms",
  "latencyTrend": "延迟趋势",
  "nodeDelays": "节点延迟",
  "noData": "暂无网络诊断数据",
  "noDataHint": "系统每分钟自动对所有已启用后端执行网络诊断",
  "lastChecked": "最近检测",
  "granularity": "聚合粒度",
  "minuteBucket": "{n} 分钟/格",
  "hourBucket": "{n} 小时/格"
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/messages/en.json apps/web/messages/zh.json
git commit -m "feat(web): add network diagnostics i18n keys"
```

---

## Task 12: Frontend — Navigation Tab Entry

**Files:**
- Modify: `apps/web/components/layout/navigation.tsx`

- [ ] **Step 1: Add Network tab to NAV_ITEMS**

Import `Activity` icon (for network diagnostics):
```typescript
Activity,
```

Add to `NAV_ITEMS` array, between `devices` and `health`:

```typescript
{ id: "network", icon: Activity },
```

The full array becomes:
```typescript
const NAV_ITEMS = [
  { id: "overview", icon: LayoutDashboard },
  { id: "rules", icon: Route },
  { id: "domains", icon: Globe },
  { id: "countries", icon: MapPin },
  { id: "proxies", icon: Server },
  { id: "devices", icon: Smartphone },
  { id: "network", icon: Activity },
  { id: "health", icon: HeartPulse },
];
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/layout/navigation.tsx
git commit -m "feat(web): add Network tab to sidebar navigation"
```

---

## Task 13: Frontend — Network Content Components

**Files:**
- Create: `apps/web/components/features/network/index.tsx`
- Create: `apps/web/components/features/network/connectivity-matrix.tsx`
- Create: `apps/web/components/features/network/latency-chart.tsx`
- Modify: `apps/web/app/[locale]/dashboard/components/content/index.tsx`

- [ ] **Step 1: Create network directory**

```bash
mkdir -p apps/web/components/features/network
```

- [ ] **Step 2: Write connectivity-matrix.tsx**

```tsx
// apps/web/components/features/network/connectivity-matrix.tsx
"use client";

import { useTranslations } from "next-intl";
import type { NetworkDiagnosticLatest } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ConnectivityMatrixProps {
  results: NetworkDiagnosticLatest[];
  onTargetClick?: (targetName: string) => void;
}

const STATUS_COLORS = {
  ok: "bg-emerald-500",
  timeout: "bg-amber-500",
  error: "bg-red-500",
} as const;

const GROUP_ORDER = ["cn", "proxy", "streaming", "exit-ip"];

function groupLabel(group: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    cn: t("groupCn"),
    proxy: t("groupProxy"),
    streaming: t("groupStreaming"),
    "exit-ip": t("groupExitIp"),
  };
  return map[group] ?? group;
}

export function ConnectivityMatrix({ results, onTargetClick }: ConnectivityMatrixProps) {
  const t = useTranslations("network");

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    label: groupLabel(group, t),
    targets: results.filter((r) => r.targetGroup === group),
  })).filter((g) => g.targets.length > 0);

  return (
    <div className="space-y-6">
      {grouped.map(({ group, label, targets }) => (
        <div key={group}>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            {label}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {targets.map((target) => (
              <button
                key={target.targetName}
                type="button"
                onClick={() => onTargetClick?.(target.targetName)}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-lg border bg-card shadow-xs",
                  "hover:border-primary/40 hover:shadow-sm transition-all text-left",
                )}
              >
                <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", STATUS_COLORS[target.status])} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate capitalize">{target.targetName}</div>
                  <div className="text-xs text-muted-foreground">
                    {target.latencyMs !== null ? (
                      <span className={cn(
                        target.latencyMs < 300 ? "text-emerald-600 dark:text-emerald-400" :
                        target.latencyMs < 1000 ? "text-amber-600 dark:text-amber-400" :
                        "text-red-600 dark:text-red-400"
                      )}>
                        {target.latencyMs}ms
                      </span>
                    ) : (
                      <span>{t(`status${target.status.charAt(0).toUpperCase() + target.status.slice(1)}` as 'statusOk')}</span>
                    )}
                    {target.exitIp && (
                      <span className="ml-1.5 text-muted-foreground">
                        {target.exitCountry && <span className="mr-1">{target.exitCountry}</span>}
                        {target.colo && <span>({target.colo})</span>}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write latency-chart.tsx**

```tsx
// apps/web/components/features/network/latency-chart.tsx
"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
} from "recharts";
import type { NetworkDiagnosticTarget } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface LatencyChartProps {
  target: NetworkDiagnosticTarget;
  spanMs: number;
}

const LATENCY_WARN_MS = 300;
const LATENCY_CRIT_MS = 1000;

function getBucketMinutes(spanMs: number): number {
  const hours = spanMs / 3_600_000;
  if (hours <= 2) return 1;
  if (hours <= 12) return 5;
  if (hours <= 48) return 15;
  return 60;
}

function formatTimeLabel(minute: string, spanMs: number): string {
  const d = new Date(minute + ":00Z");
  if (spanMs <= 48 * 3_600_000) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs <= 7 * 86_400_000) {
    return d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function niceLatencyMax(maxVal: number): number {
  if (maxVal <= 0) return 100;
  const padded = maxVal * 1.3;
  const magnitude = Math.pow(10, Math.floor(Math.log10(padded)));
  return Math.ceil(padded / magnitude) * magnitude;
}

interface Slot {
  time: string;
  label: string;
  latency: number | null;
  status: string;
}

export function LatencyChart({ target, spanMs }: LatencyChartProps) {
  const t = useTranslations("network");
  const bucketMin = getBucketMinutes(spanMs);

  const slots = useMemo(() => {
    if (!target.points.length) return [];

    const buckets = new Map<string, { latSum: number; latCount: number; errCount: number; total: number }>();

    for (const p of target.points) {
      // Truncate to bucket
      const d = new Date(p.minute + ":00Z");
      const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
      const bucketMins = Math.floor(mins / bucketMin) * bucketMin;
      d.setUTCHours(Math.floor(bucketMins / 60), bucketMins % 60, 0, 0);
      const key = d.toISOString().slice(0, 16);

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { latSum: 0, latCount: 0, errCount: 0, total: 0 };
        buckets.set(key, bucket);
      }
      bucket.total++;
      if (p.status !== "ok") bucket.errCount++;
      if (p.latencyMs !== null) {
        bucket.latSum += p.latencyMs;
        bucket.latCount++;
      }
    }

    const result: Slot[] = [];
    for (const [time, b] of Array.from(buckets.entries()).sort()) {
      result.push({
        time,
        label: formatTimeLabel(time, spanMs),
        latency: b.latCount > 0 ? Math.round(b.latSum / b.latCount) : null,
        status: b.errCount > b.total / 2 ? "error" : "ok",
      });
    }
    return result;
  }, [target.points, bucketMin, spanMs]);

  const errorSpans = useMemo(() => {
    const spans: { x1: string; x2: string }[] = [];
    let start: string | null = null;
    for (const slot of slots) {
      if (slot.status === "error") {
        if (!start) start = slot.label;
      } else if (start) {
        spans.push({ x1: start, x2: slot.label });
        start = null;
      }
    }
    return spans;
  }, [slots]);

  const maxLatency = useMemo(() => {
    const lats = slots.filter((s) => s.latency !== null).map((s) => s.latency as number);
    return lats.length > 0 ? niceLatencyMax(Math.max(...lats)) : 500;
  }, [slots]);

  const stats = useMemo(() => {
    const lats = slots.filter((s) => s.latency !== null).map((s) => s.latency as number);
    const okCount = slots.filter((s) => s.status === "ok").length;
    return {
      avg: lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
      max: lats.length > 0 ? Math.max(...lats) : null,
      uptime: slots.length > 0 ? Math.round((okCount / slots.length) * 100) : null,
    };
  }, [slots]);

  const strokeColor =
    (stats.avg ?? 0) < LATENCY_WARN_MS ? "#10b981" :
    (stats.avg ?? 0) < LATENCY_CRIT_MS ? "#f59e0b" : "#ef4444";

  if (!slots.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base capitalize">{target.name}</CardTitle>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {stats.uptime !== null && <span>{stats.uptime}% {t("reachability").toLowerCase()}</span>}
            {stats.avg !== null && <span>{t("latencyMs", { n: stats.avg })} avg</span>}
            {stats.max !== null && <span>{t("latencyMs", { n: stats.max })} max</span>}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={slots} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              interval="preserveStartEnd"
              tickLine={false}
            />
            <YAxis
              domain={[0, maxLatency]}
              tick={{ fontSize: 11 }}
              tickLine={false}
              width={45}
              tickFormatter={(v: number) => `${v}`}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as Slot;
                return (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
                    <div className="font-medium">{d.label}</div>
                    <div className="mt-1">
                      {d.latency !== null ? (
                        <span style={{ color: strokeColor }}>{d.latency}ms</span>
                      ) : (
                        <span className="text-red-500">{t("statusError")}</span>
                      )}
                    </div>
                  </div>
                );
              }}
            />
            {errorSpans.map((span, i) => (
              <ReferenceArea
                key={i}
                x1={span.x1}
                x2={span.x2}
                fill="rgba(244,63,94,0.15)"
                fillOpacity={1}
              />
            ))}
            <Area
              type="monotone"
              dataKey="latency"
              stroke={strokeColor}
              fill={strokeColor}
              fillOpacity={0.1}
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Write network/index.tsx**

```tsx
// apps/web/components/features/network/index.tsx
"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  Activity,
  Globe,
  Wifi,
  WifiOff,
  MapPin,
  Timer,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import type { TimeRange } from "@/lib/api";
import { useStableTimeRange } from "@/lib/hooks/use-stable-time-range";
import { ConnectivityMatrix } from "./connectivity-matrix";
import { LatencyChart } from "./latency-chart";

interface NetworkContentProps {
  timeRange: TimeRange;
}

export function NetworkContent({ timeRange }: NetworkContentProps) {
  const t = useTranslations("network");
  const stableRange = useStableTimeRange(timeRange);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  const from = stableRange ? new Date(stableRange.start) : new Date(Date.now() - 24 * 3600_000);
  const to = stableRange ? new Date(stableRange.end) : new Date();
  const spanMs = to.getTime() - from.getTime();

  // Fetch latest results for connectivity matrix
  const { data: latestData, isLoading: latestLoading } = useQuery({
    queryKey: ["networkDiagnosticsLatest"],
    queryFn: () => api.getNetworkDiagnosticsLatest(),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  // Fetch history for charts
  const { data: historyData, isLoading: historyLoading, isFetching, refetch } = useQuery({
    queryKey: ["networkDiagnostics", stableRange?.start, stableRange?.end],
    queryFn: () =>
      api.getNetworkDiagnostics({
        from: from.toISOString().slice(0, 16),
        to: to.toISOString().slice(0, 16),
      }),
    refetchInterval: 60_000,
    staleTime: 55_000,
    placeholderData: keepPreviousData,
  });

  const latest = latestData?.results ?? [];
  const targets = historyData?.targets ?? [];

  // Summary calculations
  const summary = useMemo(() => {
    if (!latest.length) return null;

    const okCount = latest.filter((r) => r.status === "ok").length;
    const cnTargets = latest.filter((r) => r.targetGroup === "cn");
    const proxyTargets = latest.filter((r) => r.targetGroup === "proxy" || r.targetGroup === "streaming");
    const unreachable = latest.filter((r) => r.status !== "ok" && r.targetGroup !== "exit-ip").length;

    const avgLat = (items: typeof latest) => {
      const lats = items.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs as number);
      return lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
    };

    const exitInfo = latest.find((r) => r.targetGroup === "exit-ip" && r.exitIp);

    return {
      reachability: latest.length > 0 ? Math.round((okCount / latest.length) * 100) : null,
      cnLatency: avgLat(cnTargets),
      globalLatency: avgLat(proxyTargets),
      unreachable,
      exitIp: exitInfo?.exitIp ?? null,
      exitCountry: exitInfo?.exitCountry ?? null,
      colo: exitInfo?.colo ?? null,
    };
  }, [latest]);

  // Determine which targets to show charts for
  const chartTargets = useMemo(() => {
    if (selectedTarget) {
      const found = targets.find((t) => t.name === selectedTarget);
      return found ? [found] : [];
    }
    // Show all non-exit-ip targets by default
    return targets.filter((t) => t.group !== "exit-ip");
  }, [targets, selectedTarget]);

  const isLoading = latestLoading || historyLoading;

  if (isLoading && !latest.length) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border bg-card animate-pulse" />
        ))}
      </div>
    );
  }

  if (!latest.length && !targets.length) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <Activity className="w-12 h-12 text-muted-foreground/40 mb-4" />
        <p className="text-lg font-medium text-muted-foreground">{t("noData")}</p>
        <p className="text-sm text-muted-foreground/60 mt-1">{t("noDataHint")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{t("subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-2 rounded-lg hover:bg-muted transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <SummaryCard
            icon={<Wifi className="w-4 h-4" />}
            label={t("reachability")}
            value={summary.reachability !== null ? `${summary.reachability}%` : "—"}
            color="emerald"
          />
          <SummaryCard
            icon={<Timer className="w-4 h-4" />}
            label={t("cnLatency")}
            value={summary.cnLatency !== null ? `${summary.cnLatency}ms` : "—"}
            color="blue"
          />
          <SummaryCard
            icon={<Globe className="w-4 h-4" />}
            label={t("globalLatency")}
            value={summary.globalLatency !== null ? `${summary.globalLatency}ms` : "—"}
            color="violet"
          />
          <SummaryCard
            icon={<WifiOff className="w-4 h-4" />}
            label={t("unreachable")}
            value={`${summary.unreachable}`}
            color={summary.unreachable > 0 ? "red" : "emerald"}
          />
          <SummaryCard
            icon={<Activity className="w-4 h-4" />}
            label={t("exitIp")}
            value={summary.exitIp ? summary.exitIp.split(".").slice(0, 2).join(".") + ".*.*" : "—"}
            color="amber"
          />
          <SummaryCard
            icon={<MapPin className="w-4 h-4" />}
            label={t("exitLocation")}
            value={summary.exitCountry ? `${summary.exitCountry}${summary.colo ? ` (${summary.colo})` : ""}` : "—"}
            color="cyan"
          />
        </div>
      )}

      {/* Connectivity Matrix */}
      <ConnectivityMatrix
        results={latest}
        onTargetClick={(name) => setSelectedTarget(selectedTarget === name ? null : name)}
      />

      {/* Latency Charts */}
      {chartTargets.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">{t("latencyTrend")}</h3>
          {chartTargets.map((target) => (
            <LatencyChart key={target.name} target={target} spanMs={spanMs} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  const colorClasses: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    red: "bg-red-500/10 text-red-600 dark:text-red-400",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    cyan: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  };

  return (
    <div className="rounded-xl p-3.5 border bg-card shadow-xs">
      <div className="flex items-center gap-2 mb-1.5">
        <div className={`p-1 rounded-md ${colorClasses[color] ?? colorClasses.blue}`}>
          {icon}
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
```

- [ ] **Step 5: Update content/index.tsx to use the real NetworkContent**

In `apps/web/app/[locale]/dashboard/components/content/index.tsx`:

Replace the placeholder NetworkContent import/component. Add import at top:
```typescript
import { NetworkContent as NetworkFeature } from "@/components/features/network";
```

Replace the existing `NetworkContent` memo block (lines 305-317) with:
```typescript
const NetworkContentWrapper = memo(function NetworkContentWrapper({
  timeRange,
}: {
  timeRange: TimeRange;
}) {
  return <NetworkFeature timeRange={timeRange} />;
});
```

In the switch statement, change `case "network"`:
```typescript
case "network":
  return <NetworkContentWrapper timeRange={timeRange} />;
```

- [ ] **Step 6: Verify frontend compiles**

```bash
pnpm --filter web exec tsc --noEmit
```

Expected: no errors (or only pre-existing warnings)

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/features/network/ \
       apps/web/app/[locale]/dashboard/components/content/index.tsx
git commit -m "feat(web): add Network tab with connectivity matrix and latency charts"
```

---

## Task 14: Integration Verification

- [ ] **Step 1: Build agent**

```bash
cd apps/agent && go build .
```

Expected: binary compiles successfully

- [ ] **Step 2: Build collector**

```bash
pnpm --filter collector exec tsc --noEmit
```

Expected: no type errors

- [ ] **Step 3: Build web**

```bash
pnpm --filter web exec tsc --noEmit
```

Expected: no type errors (or only pre-existing)

- [ ] **Step 4: Build full project**

```bash
pnpm build
```

Expected: all packages build successfully

- [ ] **Step 5: Commit any fixes**

If any issues were found, fix them and commit:

```bash
git add -A
git commit -m "fix: resolve build issues in network diagnostics"
```

---

## Task 15: Final Cleanup Commit

- [ ] **Step 1: Verify all changes are committed**

```bash
git status
git log --oneline feat/network-diagnostics ^main
```

- [ ] **Step 2: Verify branch is clean**

All changes should be committed. Run final type checks:

```bash
cd apps/agent && go vet ./...
pnpm --filter collector exec tsc --noEmit
pnpm --filter web exec tsc --noEmit
```
