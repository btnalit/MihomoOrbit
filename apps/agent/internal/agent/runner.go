package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/btnalit/MihomoOrbit/apps/agent/internal/config"
	"github.com/btnalit/MihomoOrbit/apps/agent/internal/configfile"
	"github.com/btnalit/MihomoOrbit/apps/agent/internal/domain"
	"github.com/btnalit/MihomoOrbit/apps/agent/internal/gateway"
)

// configFileReportPath is the collector endpoint agents POST config-file
// reports to (relative to cfg.ServerAPIBase, same convention as
// "/agent/report", "/agent/heartbeat", etc.). See docs/superpowers/plans/
// 2026-08-09-m2a-agent-config-visibility.md, "契约速查".
const configFileReportPath = "/agent/config-file"

type trackedFlow struct {
	LastUpload  int64
	LastDown    int64
	LastSeenMs  int64
	Counted     bool
	Domain      string
	IP          string
	SourceIP    string
	Chains      []string
	Rule        string
	RulePayload string
}

type reportPayload struct {
	BackendID       int                    `json:"backendId"`
	RequestID       string                 `json:"requestId,omitempty"`
	AgentID         string                 `json:"agentId"`
	AgentVersion    string                 `json:"agentVersion,omitempty"`
	ProtocolVersion int                    `json:"protocolVersion"`
	Updates         []domain.TrafficUpdate `json:"updates"`
}

type heartbeatPayload struct {
	BackendID        int    `json:"backendId"`
	AgentID          string `json:"agentId"`
	Hostname         string `json:"hostname,omitempty"`
	Version          string `json:"version,omitempty"`
	AgentVersion     string `json:"agentVersion,omitempty"`
	ProtocolVersion  int    `json:"protocolVersion"`
	GatewayType      string `json:"gatewayType,omitempty"`
	GatewayURL       string `json:"gatewayUrl,omitempty"`
	GatewayLatencyMs int64  `json:"gatewayLatencyMs,omitempty"`
	ServerLatencyMs  int64  `json:"serverLatencyMs,omitempty"`
}

type configPayload struct {
	BackendID int                           `json:"backendId"`
	AgentID   string                        `json:"agentId"`
	Config    *domain.GatewayConfigSnapshot `json:"config"`
}

type policyStatePayload struct {
	BackendID   int                         `json:"backendId"`
	AgentID     string                      `json:"agentId"`
	PolicyState *domain.PolicyStateSnapshot `json:"policyState"`
}

type Runner struct {
	cfg           config.Config
	httpClient    *http.Client
	gatewayClient *gateway.Client
	hostname      string
	lockFiles     []*os.File
	// lockDir overrides the directory lock files are created in; defaulted to
	// os.TempDir() by NewRunner. Tests set it to a t.TempDir() to avoid
	// colliding with other tests or leftover files under the real temp dir.
	lockDir string

	mu         sync.Mutex
	queue      []domain.TrafficUpdate
	flows      map[string]trackedFlow
	dropped    int64
	retryBatch []domain.TrafficUpdate
	retryID    string

	lastConfigHash   string
	lastPolicyHash   string
	gatewayLatencyMs int64
	serverLatencyMs  int64
}

func NewRunner(cfg config.Config) *Runner {
	httpClient := &http.Client{Timeout: cfg.RequestTimeout}
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown-host"
	}

	return &Runner{
		cfg:           cfg,
		httpClient:    httpClient,
		gatewayClient: gateway.NewClient(httpClient, cfg.GatewayType, cfg.GatewayEndpoint, cfg.GatewayToken),
		hostname:      hostname,
		lockDir:       os.TempDir(),
		queue:         make([]domain.TrafficUpdate, 0, cfg.ReportBatchSize*2),
		flows:         make(map[string]trackedFlow, 2048),
	}
}

// lockPaths returns every lock file this agent must hold, in acquisition order.
//
// The legacy neko-agent path is included deliberately. This lock is the only
// mutual-exclusion point between this binary and a leftover upstream neko-agent
// on the same host: the default agentId is a hash of the backend token
// (internal/config), so both binaries register under the SAME agentId and the
// server accepts both — their traffic would be counted twice. Dropping the
// legacy path during the rename would create the very double-write it looks
// like it prevents.
func (r *Runner) lockPaths() []string {
	dir := r.lockDir
	if dir == "" {
		dir = os.TempDir()
	}
	return []string{
		filepath.Join(dir, fmt.Sprintf("orbit-agent-backend-%d.lock", r.cfg.BackendID)),
		filepath.Join(dir, fmt.Sprintf("neko-agent-backend-%d.lock", r.cfg.BackendID)),
	}
}

func (r *Runner) acquireLock() error {
	for _, lockPath := range r.lockPaths() {
		file, err := r.acquireLockAt(lockPath)
		if err != nil {
			r.releaseLock() // roll back locks already taken, leave no orphans
			return err
		}
		r.lockFiles = append(r.lockFiles, file)
	}
	return nil
}

func (r *Runner) acquireLockAt(lockPath string) (*os.File, error) {
	// Check if lock file exists and if process is still running
	if data, err := os.ReadFile(lockPath); err == nil {
		var pid int
		if _, err := fmt.Sscanf(string(data), "%d", &pid); err == nil {
			// Check if process is still running
			if pid > 0 && pid != os.Getpid() {
				if isProcessRunningFn(pid) {
					return nil, fmt.Errorf("another agent instance (PID %d) is already running for backend %d", pid, r.cfg.BackendID)
				}
				// Process is not running, stale lock file
				log.Printf("[agent:%s] removing stale lock file from PID %d", r.cfg.AgentID, pid)
				os.Remove(lockPath)
			}
		}
	}

	// Create lock file with exclusive flag (O_EXCL)
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		if os.IsExist(err) {
			return nil, fmt.Errorf("lock file already exists for backend %d", r.cfg.BackendID)
		}
		return nil, fmt.Errorf("failed to create lock file: %w", err)
	}

	// Write PID to lock file
	pid := fmt.Sprintf("%d", os.Getpid())
	if _, err := file.WriteString(pid); err != nil {
		file.Close()
		os.Remove(lockPath)
		return nil, fmt.Errorf("failed to write PID to lock file: %w", err)
	}

	return file, nil
}

func (r *Runner) releaseLock() {
	for _, file := range r.lockFiles {
		if file == nil {
			// Slot cleared by checkLockOwnership() because another live agent
			// took the lock over — it's no longer ours to close or remove.
			continue
		}
		lockPath := file.Name()
		file.Close()
		os.Remove(lockPath)
	}
	r.lockFiles = nil
}

// readProcComm reads /proc/<pid>/comm. It is a package-level var purely so
// tests can substitute a fake comm for a real, live PID (e.g. the test
// binary's own) without needing to spawn or impersonate real OS processes.
// Production code always uses this default.
var readProcComm = func(pid int) ([]byte, error) {
	return os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
}

// isProcessRunningFn is the liveness+ownership check used by acquireLockAt
// and checkLockOwnership. It's a package-level var (defaulting to
// isProcessRunning) so tests can drive the held-vs-stale decision
// deterministically without depending on real process PIDs or permissions.
var isProcessRunningFn = isProcessRunning

// isProcessRunning checks whether the PID is alive AND belongs to an
// agent process (orbit-agent, or a leftover upstream neko-agent). On Linux we cross-check /proc/<pid>/comm so that a
// stale PID later reused by an unrelated process cannot permanently block
// agent startup. On non-Linux (or if /proc isn't available) we fall back to
// the signal-0 liveness check.
func isProcessRunning(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return false
	}
	data, err := readProcComm(pid)
	if err != nil {
		// /proc not readable (non-Linux, restricted hidepid, etc.) — treat
		// liveness check as authoritative.
		return true
	}
	comm := strings.TrimSpace(string(data))
	// 新旧两种进程名都算存活:锁要能挡住残留的 neko-agent(防双写),
	// 也要能挡住另一个 orbit-agent(否则彼此判定对方为陈旧锁而并行运行)。
	return strings.Contains(comm, "orbit-agent") || strings.Contains(comm, "neko-agent")
}

// lockSelfCheckInterval controls how often the runner re-verifies it still
// owns every lock file acquired at startup. See I3: the lock only protects
// double-reporting when the legacy neko-agent starts first — its own
// isProcessRunning only matches "neko-agent", so it treats a lock held by an
// orbit-agent PID as stale, deletes it, and takes it over. This periodic
// check is how orbit-agent notices that happened.
const lockSelfCheckInterval = 60 * time.Second

// runLockWatchLoop periodically re-verifies lock ownership (see
// checkLockOwnership). If a lock was taken over by another live agent
// process and can't be reacquired, it cancels the runner's context so Run()
// proceeds through its normal graceful-shutdown path instead of continuing
// to run while a duplicate agent reports the same traffic.
func (r *Runner) runLockWatchLoop(ctx context.Context, cancel context.CancelFunc, wg *sync.WaitGroup) {
	defer wg.Done()
	ticker := time.NewTicker(lockSelfCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if r.checkLockOwnership() {
				cancel()
				return
			}
		}
	}
}

// ownsLock reports whether lockPath currently contains our own PID. It also
// returns the PID found in the file (0 if the file is missing, unreadable,
// or doesn't parse) so callers can log it.
func (r *Runner) ownsLock(lockPath string) (owned bool, pid int) {
	data, err := os.ReadFile(lockPath)
	if err != nil {
		return false, 0
	}
	if _, err := fmt.Sscanf(string(data), "%d", &pid); err != nil {
		return false, 0
	}
	return pid == os.Getpid(), pid
}

// checkLockOwnership re-verifies every lock file this runner holds. For any
// lock that's missing or now contains a PID other than our own, it attempts
// to reacquire it via the same O_EXCL path used at startup (acquireLockAt),
// which itself decides stale-vs-held via isProcessRunningFn. It returns true
// only once a lock is confirmed held by another live agent process and
// reacquisition failed — the caller must treat that as fatal and shut down
// to avoid double reporting. A reacquire failure that doesn't confirm a live
// foreign PID (e.g. transient/garbled file content) is logged and left for
// the next check instead of exiting a healthy agent.
func (r *Runner) checkLockOwnership() (lost bool) {
	for i, file := range r.lockFiles {
		if file == nil {
			continue
		}
		path := file.Name()

		owned, pid := r.ownsLock(path)
		if owned {
			continue
		}

		if pid == 0 {
			log.Printf("[agent:%s] lock file %s is missing or unreadable — attempting to reacquire", r.cfg.AgentID, path)
		} else {
			log.Printf("[agent:%s] lock file %s now held by PID %d (expected our PID %d) — attempting to reacquire", r.cfg.AgentID, path, pid, os.Getpid())
		}
		file.Close()

		newFile, err := r.acquireLockAt(path)
		if err == nil {
			log.Printf("[agent:%s] reacquired lock %s", r.cfg.AgentID, path)
			r.lockFiles[i] = newFile
			continue
		}

		// acquireLockAt failing isn't proof of a live takeover by itself: it
		// also fails (via its own pid>0 && pid!=os.Getpid() short-circuit,
		// then O_EXCL-exists) when the file holds unparseable content, PID 0,
		// or — after a concurrent reacquire elsewhere — our own PID again.
		// None of those are a foreign process holding the lock against us.
		// Re-read the file and only treat this as a confirmed takeover, fatal
		// to this runner, when it currently names a live PID that isn't
		// ours; otherwise it's transient — log and retry on the next check
		// rather than killing a healthy agent.
		if _, confirmPID := r.ownsLock(path); confirmPID > 0 && confirmPID != os.Getpid() && isProcessRunningFn(confirmPID) {
			log.Printf("[agent:%s] another agent has taken over lock %s — exiting to prevent double reporting", r.cfg.AgentID, path)
			r.lockFiles[i] = nil
			lost = true
			continue
		}
		log.Printf("[agent:%s] could not reacquire lock %s yet (%v) — will retry on next check", r.cfg.AgentID, path, err)
	}
	return lost
}

func (r *Runner) Run(ctx context.Context) {
	log.Printf("[agent:%s] starting, backend=%d, gateway_type=%s, server=%s", r.cfg.AgentID, r.cfg.BackendID, r.cfg.GatewayType, r.cfg.ServerAPIBase)

	// Acquire singleton lock to prevent multiple instances for same backend
	if err := r.acquireLock(); err != nil {
		log.Printf("[agent:%s] failed to acquire lock: %v", r.cfg.AgentID, err)
		log.Printf("[agent:%s] hint: another agent instance may be running for backend %d", r.cfg.AgentID, r.cfg.BackendID)
		return
	}
	defer r.releaseLock()

	// runCtx lets runLockWatchLoop trigger the same graceful shutdown path as
	// an external ctx cancellation (SIGINT/SIGTERM) when it detects a lock
	// was taken over by another live agent, without reaching into the
	// caller-owned ctx.
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	var wg sync.WaitGroup
	wg.Add(6)
	go r.runCollectorLoop(runCtx, &wg)
	go r.runReportLoop(runCtx, &wg)
	go r.runHeartbeatLoop(runCtx, &wg)
	go r.runConfigSyncLoop(runCtx, &wg)
	go r.runPolicyStateSyncLoop(runCtx, &wg)
	go r.runLockWatchLoop(runCtx, cancelRun, &wg)

	// Config-file visibility is opt-in: MihomoConfigPath is empty unless the
	// operator declared -mihomo-config, and an unconfigured agent must have
	// exactly zero behavioral change from before this feature existed — no
	// extra goroutine, no ticking, no reads of a path nobody set.
	if r.cfg.MihomoConfigPath != "" {
		wg.Add(1)
		go r.runConfigFileReportLoop(runCtx, &wg)
	}

	<-runCtx.Done()
	log.Printf("[agent:%s] stopping...", r.cfg.AgentID)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Drain the queue in batches until empty or the deadline hits — flushOnce
	// only sends one ReportBatchSize chunk per call, so a single invocation
	// would silently drop anything beyond it.
	for {
		if err := r.flushOnce(shutdownCtx); err != nil {
			log.Printf("[agent:%s] final flush failed: %v", r.cfg.AgentID, err)
			break
		}
		pending, _ := r.queueStats()
		if pending == 0 {
			break
		}
		if shutdownCtx.Err() != nil {
			break
		}
	}

	wg.Wait()
	pending, dropped := r.queueStats()
	if pending > 0 {
		log.Printf("[agent:%s] exit with %d pending updates", r.cfg.AgentID, pending)
	}
	if dropped > 0 {
		log.Printf("[agent:%s] dropped updates due to queue overflow: %d", r.cfg.AgentID, dropped)
	}
}

func (r *Runner) runCollectorLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()

	failures := 0
	for {
		t0 := time.Now()
		snapshots, err := r.gatewayClient.Collect(ctx)
		delay := r.cfg.GatewayPollInterval
		if err != nil {
			failures++
			delay = calculateBackoff(r.cfg.GatewayPollInterval, failures, 60*time.Second)
			log.Printf("[agent:%s] collector error (%d): %v", r.cfg.AgentID, failures, err)
		} else {
			failures = 0
			latencyMs := time.Since(t0).Milliseconds()
			r.mu.Lock()
			r.gatewayLatencyMs = latencyMs
			r.mu.Unlock()
			r.ingestSnapshots(snapshots, time.Now().UnixMilli())
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

func (r *Runner) runReportLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	ticker := time.NewTicker(r.cfg.ReportInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.flushOnce(ctx); err != nil {
				log.Printf("[agent:%s] report error: %v", r.cfg.AgentID, err)
			}
		}
	}
}

func (r *Runner) runHeartbeatLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()

	if err := r.sendHeartbeat(ctx); err != nil {
		log.Printf("[agent:%s] heartbeat error: %v", r.cfg.AgentID, err)
	}

	ticker := time.NewTicker(r.cfg.HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.sendHeartbeat(ctx); err != nil {
				log.Printf("[agent:%s] heartbeat error: %v", r.cfg.AgentID, err)
			}
		}
	}
}

func (r *Runner) runConfigSyncLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()

	// Initial sync with retry for binding conflicts
	// If server returns 409 (already bound), retry with backoff
	maxRetries := 5
	for i := 0; i < maxRetries; i++ {
		err := r.syncConfig(ctx)
		if err == nil {
			log.Printf("[agent:%s] config synced successfully", r.cfg.AgentID)
			break
		}
		if i == maxRetries-1 {
			log.Printf("[agent:%s] init config sync failed after %d retries: %v", r.cfg.AgentID, maxRetries, err)
		} else {
			// Check if it's a binding conflict (409)
			if strings.Contains(err.Error(), "409") || strings.Contains(err.Error(), "AGENT_TOKEN_ALREADY_BOUND") {
				backoff := time.Duration(i+1) * 5 * time.Second
				log.Printf("[agent:%s] config sync binding conflict, retrying in %v... (%d/%d)", r.cfg.AgentID, backoff, i+1, maxRetries)
				time.Sleep(backoff)
			} else {
				// Non-binding error, log and continue with ticker
				log.Printf("[agent:%s] init config sync error: %v", r.cfg.AgentID, err)
				break
			}
		}
	}

	// Then every 2 minutes
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.syncConfig(ctx); err != nil {
				log.Printf("[agent:%s] config sync error: %v", r.cfg.AgentID, err)
			}
		}
	}
}

func (r *Runner) syncConfig(ctx context.Context) error {
	snap, err := r.gatewayClient.GetConfigSnapshot(ctx)
	if err != nil {
		return err
	}

	// Calculate a simple hash to avoid sending if unmodified
	data, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("marshal config snapshot: %w", err)
	}
	hash := fmt.Sprintf("%x", md5.Sum(data))
	r.mu.Lock()
	unchanged := hash == r.lastConfigHash
	r.mu.Unlock()
	if unchanged {
		return nil
	}
	snap.Hash = hash
	snap.Timestamp = time.Now().UnixMilli()

	payload := configPayload{
		BackendID: r.cfg.BackendID,
		AgentID:   r.cfg.AgentID,
		Config:    snap,
	}

	if err := r.postJSON(ctx, "/agent/config", payload); err != nil {
		return err
	}

	r.mu.Lock()
	r.lastConfigHash = hash
	r.mu.Unlock()
	return nil
}

// runPolicyStateSyncLoop syncs only the dynamic policy selection state (now field)
// This runs more frequently (30s) than config sync (2min) to keep chain flow visualization accurate
func (r *Runner) runPolicyStateSyncLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()

	// Wait a bit for initial config sync to complete, but stay responsive to shutdown
	select {
	case <-ctx.Done():
		return
	case <-time.After(5 * time.Second):
	}

	// Initial sync
	if err := r.syncPolicyState(ctx); err != nil {
		log.Printf("[agent:%s] init policy state sync error: %v", r.cfg.AgentID, err)
	}

	// Then every 30 seconds
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.syncPolicyState(ctx); err != nil {
				log.Printf("[agent:%s] policy state sync error: %v", r.cfg.AgentID, err)
			}
		}
	}
}

func (r *Runner) syncPolicyState(ctx context.Context) error {
	snap, err := r.gatewayClient.GetPolicyStateSnapshot(ctx)
	if err != nil {
		return err
	}

	// Skip POST when policy state is unchanged (same as syncConfig dedup pattern)
	data, _ := json.Marshal(snap)
	hash := fmt.Sprintf("%x", md5.Sum(data))

	r.mu.Lock()
	unchanged := hash == r.lastPolicyHash
	r.mu.Unlock()

	if unchanged {
		return nil
	}

	snap.Timestamp = time.Now().UnixMilli()

	payload := policyStatePayload{
		BackendID:   r.cfg.BackendID,
		AgentID:     r.cfg.AgentID,
		PolicyState: snap,
	}

	if err := r.postJSON(ctx, "/agent/policy-state", payload); err != nil {
		return err
	}

	r.mu.Lock()
	r.lastPolicyHash = hash
	r.mu.Unlock()
	return nil
}

// runConfigFileReportLoop reports the mihomo config file (identified by
// cfg.MihomoConfigPath) to the collector by hash change, backing off on any
// persistent POST failure (404 from an unupgraded collector, 5xx, network
// error, ...). Only started when MihomoConfigPath != "" (see Run). All state
// (Tracker, consecutive-failure counter) lives in the configfile.Reporter
// this loop owns exclusively, so no locking is needed here. Logf is wired to
// log.Printf, same as every other log call in this file — output is gated
// globally via main.go's cfg.LogEnabled check (log.SetOutput(io.Discard)
// when disabled), not per call site.
func (r *Runner) runConfigFileReportLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()

	rep := &configfile.Reporter{
		ConfigPath:      r.cfg.MihomoConfigPath,
		Path:            configFileReportPath,
		Base:            r.cfg.ConfigCheckInterval,
		BackendID:       r.cfg.BackendID,
		AgentID:         r.cfg.AgentID,
		AgentVersion:    config.AgentVersion,
		ProtocolVersion: config.AgentProtocolVersion,
		Post:            r.postConfigFile,
		Logf:            log.Printf,
	}

	for {
		delay := rep.RunOnce(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

// postConfigFile is the configfile.PostFunc closure the config-file report
// loop uses to reach the collector. It reuses postJSONWithLatency exactly
// as-is (gzip + Bearer auth, unchanged) rather than duplicating that
// wiring — postJSONWithLatency's return-body contract is untouched here per
// the task brief; M2b is expected to refactor it to return structured
// errors. Until then, 404 is detected by matching postJSONWithLatency's
// non-2xx error string ("server http %d: %s"), the only signal currently
// available without changing that function's signature or behavior.
func (r *Runner) postConfigFile(ctx context.Context, path string, payload interface{}) (status404 bool, err error) {
	_, err = r.postJSONWithLatency(ctx, path, payload)
	if err == nil {
		return false, nil
	}
	return strings.Contains(err.Error(), "server http 404:"), err
}

func (r *Runner) ingestSnapshots(snapshots []domain.FlowSnapshot, nowMs int64) {
	active := make(map[string]struct{}, len(snapshots))
	updates := make([]domain.TrafficUpdate, 0, len(snapshots))

	r.mu.Lock()
	defer r.mu.Unlock()

	for _, s := range snapshots {
		active[s.ID] = struct{}{}

		prev, hasPrev := r.flows[s.ID]
		counted := false
		if hasPrev {
			counted = prev.Counted
		}
		domainName := strings.TrimSpace(s.Domain)
		ip := strings.TrimSpace(s.IP)
		sourceIP := strings.TrimSpace(s.SourceIP)
		chains := normalizeChains(s.Chains)
		rule := defaultString(strings.TrimSpace(s.Rule), "Match")
		rulePayload := strings.TrimSpace(s.RulePayload)
		if hasPrev {
			// Keep per-flow metadata stable once first seen, matching direct mode
			// semantics in collector (existing connection fields are reused).
			domainName = prev.Domain
			ip = prev.IP
			sourceIP = prev.SourceIP
			chains = cloneStringSlice(prev.Chains)
			rule = defaultString(prev.Rule, "Match")
			rulePayload = prev.RulePayload
		}

		deltaUp := s.Upload
		deltaDown := s.Download
		if hasPrev {
			if s.Upload < prev.LastUpload || s.Download < prev.LastDown {
				// Counter reset (gateway restart / connection id reuse): the
				// counter went backwards. Match the direct gateway collector and
				// treat the current value as new traffic instead of silently
				// dropping it, and re-count the connection.
				deltaUp = s.Upload
				deltaDown = s.Download
				counted = false
			} else {
				deltaUp = s.Upload - prev.LastUpload
				deltaDown = s.Download - prev.LastDown
			}
		}

		connections := int64(0)
		if (deltaUp > 0 || deltaDown > 0) && !counted {
			connections = 1
			counted = true
		}

		r.flows[s.ID] = trackedFlow{
			LastUpload:  s.Upload,
			LastDown:    s.Download,
			LastSeenMs:  nowMs,
			Counted:     counted,
			Domain:      domainName,
			IP:          ip,
			SourceIP:    sourceIP,
			Chains:      cloneStringSlice(chains),
			Rule:        rule,
			RulePayload: rulePayload,
		}
		if deltaUp <= 0 && deltaDown <= 0 {
			continue
		}

		ts := s.TimestampMs
		if ts <= 0 {
			ts = nowMs
		}

		updates = append(updates, domain.TrafficUpdate{
			Domain:      domainName,
			IP:          ip,
			Chain:       firstChain(chains),
			Chains:      cloneStringSlice(chains),
			Rule:        rule,
			RulePayload: rulePayload,
			Upload:      deltaUp,
			Download:    deltaDown,
			Connections: connections,
			SourceIP:    sourceIP,
			TimestampMs: ts,
		})
	}

	for id, f := range r.flows {
		if _, ok := active[id]; ok {
			continue
		}
		if nowMs-f.LastSeenMs > r.cfg.StaleFlowTimeout.Milliseconds() {
			delete(r.flows, id)
		}
	}

	if len(updates) == 0 {
		return
	}

	r.queue = append(r.queue, updates...)
	if len(r.queue) > r.cfg.MaxPendingUpdates {
		overflow := len(r.queue) - r.cfg.MaxPendingUpdates
		r.queue = r.queue[overflow:]
		r.dropped += int64(overflow)
	}
}

func (r *Runner) flushOnce(ctx context.Context) error {
	batch, requestID := r.takePendingBatch()
	if len(batch) == 0 {
		return nil
	}

	payload := reportPayload{
		BackendID:       r.cfg.BackendID,
		RequestID:       requestID,
		AgentID:         r.cfg.AgentID,
		AgentVersion:    config.AgentVersion,
		ProtocolVersion: config.AgentProtocolVersion,
		Updates:         batch,
	}

	if err := r.postJSON(ctx, "/agent/report", payload); err != nil {
		r.setRetryBatch(batch, requestID)
		return err
	}
	return nil
}

// takePendingBatch returns the retry batch (with its original requestId) if one
// exists, otherwise dequeues a fresh batch from the queue and generates a new id.
func (r *Runner) takePendingBatch() ([]domain.TrafficUpdate, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.retryBatch) > 0 {
		batch := r.retryBatch
		id := r.retryID
		r.retryBatch = nil
		r.retryID = ""
		return batch, id
	}
	if len(r.queue) == 0 {
		return nil, ""
	}
	limit := r.cfg.ReportBatchSize
	if limit > len(r.queue) {
		limit = len(r.queue)
	}
	out := make([]domain.TrafficUpdate, limit)
	copy(out, r.queue[:limit])
	r.queue = r.queue[limit:]
	return out, newRequestID()
}

func (r *Runner) setRetryBatch(batch []domain.TrafficUpdate, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.retryBatch = batch
	r.retryID = id
}

func (r *Runner) sendHeartbeat(ctx context.Context) error {
	r.mu.Lock()
	gatewayLatencyMs := r.gatewayLatencyMs
	serverLatencyMs := r.serverLatencyMs
	r.mu.Unlock()

	payload := heartbeatPayload{
		BackendID:        r.cfg.BackendID,
		AgentID:          r.cfg.AgentID,
		Hostname:         r.hostname,
		Version:          config.AgentVersion,
		AgentVersion:     config.AgentVersion,
		ProtocolVersion:  config.AgentProtocolVersion,
		GatewayType:      r.cfg.GatewayType,
		GatewayURL:       r.cfg.GatewayEndpoint,
		GatewayLatencyMs: gatewayLatencyMs,
		ServerLatencyMs:  serverLatencyMs,
	}
	latencyMs, err := r.postJSONWithLatency(ctx, "/agent/heartbeat", payload)
	if err != nil {
		return err
	}

	r.mu.Lock()
	r.serverLatencyMs = latencyMs
	r.mu.Unlock()
	return nil
}

func (r *Runner) postJSON(ctx context.Context, path string, payload interface{}) error {
	_, err := r.postJSONWithLatency(ctx, path, payload)
	return err
}

func (r *Runner) postJSONWithLatency(ctx context.Context, path string, payload interface{}) (int64, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err = gz.Write(body); err != nil {
		return 0, err
	}
	if err = gz.Close(); err != nil {
		return 0, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.cfg.ServerAPIBase+path, &buf)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+r.cfg.BackendToken)

	requestAt := time.Now()
	resp, err := r.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return time.Since(requestAt).Milliseconds(), nil
	}

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	msg := string(bytes.TrimSpace(respBody))
	if msg == "" {
		msg = resp.Status
	}
	return 0, fmt.Errorf("server http %d: %s", resp.StatusCode, msg)
}

func newRequestID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (r *Runner) takeBatch(limit int) []domain.TrafficUpdate {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.queue) == 0 {
		return nil
	}
	if limit > len(r.queue) {
		limit = len(r.queue)
	}
	out := make([]domain.TrafficUpdate, limit)
	copy(out, r.queue[:limit])
	r.queue = r.queue[limit:]
	return out
}

func (r *Runner) requeueFront(batch []domain.TrafficUpdate) {
	if len(batch) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	newQueue := make([]domain.TrafficUpdate, 0, len(batch)+len(r.queue))
	newQueue = append(newQueue, batch...)
	newQueue = append(newQueue, r.queue...)

	if len(newQueue) > r.cfg.MaxPendingUpdates {
		overflow := len(newQueue) - r.cfg.MaxPendingUpdates
		newQueue = newQueue[overflow:]
		r.dropped += int64(overflow)
	}
	r.queue = newQueue
}

func (r *Runner) queueStats() (pending int, dropped int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.queue), r.dropped
}

func firstChain(chains []string) string {
	if len(chains) == 0 {
		return "DIRECT"
	}
	if strings.TrimSpace(chains[0]) == "" {
		return "DIRECT"
	}
	return strings.TrimSpace(chains[0])
}

func normalizeChains(chains []string) []string {
	if len(chains) == 0 {
		return []string{"DIRECT"}
	}
	out := make([]string, 0, len(chains))
	for _, chain := range chains {
		trimmed := strings.TrimSpace(chain)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
		if len(out) >= 12 {
			break
		}
	}
	if len(out) == 0 {
		return []string{"DIRECT"}
	}
	return out
}

func cloneStringSlice(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	cloned := make([]string, len(values))
	copy(cloned, values)
	return cloned
}

func defaultString(v string, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return strings.TrimSpace(v)
}

func calculateBackoff(base time.Duration, failures int, max time.Duration) time.Duration {
	if failures <= 0 {
		return base
	}
	delay := base
	for i := 0; i < failures; i++ {
		delay *= 2
		if delay >= max {
			return max
		}
	}
	return delay
}
