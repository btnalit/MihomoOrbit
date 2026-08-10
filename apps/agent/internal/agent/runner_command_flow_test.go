package agent

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/btnalit/MihomoOrbit/apps/agent/internal/config"
	"github.com/btnalit/MihomoOrbit/apps/agent/internal/configapply"
)

// This package doesn't compile natively on Windows (see
// runner_protocol_test.go's identical note) — these tests only run in CI
// (ubuntu, agent-build.yml). Locally: `GOOS=linux go vet ./...` and
// `GOOS=linux go test -c -o /dev/null ./internal/agent/` (compile-check
// only).

// sha256HexForTest mirrors configapply's unexported sha256Hex (used to
// compute a Command.BaseHash that will match a given on-disk config file);
// duplicated here rather than exported from configapply purely for test
// convenience.
func sha256HexForTest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// fakeCmdGateway is a minimal, concurrency-safe configapply.GatewayAPI fake
// for these runner-level tests — deliberately simpler than configapply's
// own table-driven fakeGateway (apply_test.go), since these tests exercise
// the real Applier only as a black box (state-dedup, single-flight),  not
// its own six-step/health-gate edge cases (already covered by Task 2).
type fakeCmdGateway struct {
	mu          sync.Mutex
	reloadCalls int
	reloadErr   error
	configs     map[string]interface{}
	proxies     int
}

func (g *fakeCmdGateway) PutConfigsReload(ctx context.Context, path string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.reloadCalls++
	return g.reloadErr
}

func (g *fakeCmdGateway) GetConfigsJSON(ctx context.Context) (map[string]interface{}, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[string]interface{}, len(g.configs))
	for k, v := range g.configs {
		out[k] = v
	}
	return out, nil
}

func (g *fakeCmdGateway) GetProxiesCount(ctx context.Context) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.proxies, nil
}

func (g *fakeCmdGateway) setConfigs(v map[string]interface{}) {
	g.mu.Lock()
	g.configs = v
	g.mu.Unlock()
}

func (g *fakeCmdGateway) reloadCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.reloadCalls
}

// newCommandTestRunner builds a Runner wired to a real configapply.Applier
// (ConfigPath/gw) and starts the dedicated executor goroutine
// (runCommandExecLoop) on an independent, per-test context — the same
// goroutine Run() starts, without pulling in Run()'s lock acquisition or
// the other five loops. serverURL may be "" for tests that never call
// sendHeartbeat.
func newCommandTestRunner(t *testing.T, serverURL, configPath string, gw *fakeCmdGateway) *Runner {
	t.Helper()
	r := NewRunner(config.Config{
		ServerAPIBase:    serverURL,
		RequestTimeout:   5 * time.Second,
		BackendID:        1,
		AgentID:          "test-agent",
		GatewayType:      "clash",
		MihomoConfigPath: configPath,
	})
	r.lockDir = t.TempDir()
	r.applier = &configapply.Applier{ConfigPath: configPath, Gateway: gw}
	r.applyFn = r.applier.Apply

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go r.runCommandExecLoop(ctx, &wg)
	t.Cleanup(func() {
		cancel()
		wg.Wait()
	})
	return r
}

// waitForPendingResults polls pendingCommandResults until it holds at least
// n entries, returning a snapshot copy, or fails the test after 2s.
func waitForPendingResults(t *testing.T, r *Runner, n int) []commandResult {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		r.mu.Lock()
		if len(r.pendingCommandResults) >= n {
			out := make([]commandResult, len(r.pendingCommandResults))
			copy(out, r.pendingCommandResults)
			r.mu.Unlock()
			return out
		}
		r.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d pending command result(s)", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Scenario ①: a dispatched command reaches the real Applier and actually
// executes (config file rewritten, gateway reloaded) exactly once; a later
// redelivery of the SAME commandId — simulating the collector resending a
// command it hasn't seen an ack for yet — is answered entirely by the
// Applier's own state-based dedup (Task 2's LastAppliedCommandID +
// PendingResults replay), touching neither the gateway nor the config file
// again.
func TestDispatchCommandExecutesOnceStateDedupsRedelivery(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	if err := os.WriteFile(configPath, original, 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	gw := &fakeCmdGateway{configs: map[string]interface{}{"port": 8080.0}, proxies: 1}
	r := newCommandTestRunner(t, "", configPath, gw)

	payload := commandPayload{
		CommandID: "cmd-exec-once",
		BaseHash:  sha256HexForTest(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}

	r.handleCommandsFn([]commandPayload{payload})
	results := waitForPendingResults(t, r, 1)
	if results[0].CommandID != payload.CommandID || results[0].Result != configapply.StatusApplied {
		t.Fatalf("expected applied result for %s, got %+v", payload.CommandID, results[0])
	}
	if got := gw.reloadCount(); got != 1 {
		t.Fatalf("expected 1 reload after first apply, got %d", got)
	}

	// Redeliver the same command now that execution has already completed.
	r.handleCommandsFn([]commandPayload{payload})
	time.Sleep(50 * time.Millisecond) // let it flow through the executor if it were (incorrectly) re-queued

	if got := gw.reloadCount(); got != 1 {
		t.Fatalf("expected redelivery to be answered from state dedup (no 2nd reload), got %d", got)
	}

	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != payload.Content {
		t.Fatalf("expected config content unchanged by redelivery, got %q", string(got))
	}
}

// Scenario ②: a completed command's result rides the next heartbeat
// request, is cleared from the in-memory queue on 2xx, and —
// simultaneously — orbit-agent-state.json retains exactly the one entry
// matching LastAppliedCommandID despite it having just been acked (Task 2
// review requirement (a): that entry is the Applier's own redelivery replay
// cache, not merely an unacked-results buffer).
func TestCommandResultRidesNextHeartbeatAndStateRetainsLastApplied(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	if err := os.WriteFile(configPath, original, 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	gw := &fakeCmdGateway{configs: map[string]interface{}{"port": 8080.0}, proxies: 1}

	var mu sync.Mutex
	var gotResults []commandResult
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gr, err := gzip.NewReader(req.Body)
		if err != nil {
			t.Errorf("gunzip heartbeat request body: %v", err)
			w.WriteHeader(http.StatusOK)
			return
		}
		defer gr.Close()
		var p heartbeatPayload
		if err := json.NewDecoder(gr).Decode(&p); err != nil {
			t.Errorf("decode heartbeat payload: %v", err)
		}
		mu.Lock()
		gotResults = p.CommandResults
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"commands":[]}`))
	}))
	defer srv.Close()

	r := newCommandTestRunner(t, srv.URL, configPath, gw)

	payload := commandPayload{
		CommandID: "cmd-heartbeat-ride",
		BaseHash:  sha256HexForTest(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}
	r.handleCommandsFn([]commandPayload{payload})
	waitForPendingResults(t, r, 1)

	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatalf("sendHeartbeat: %v", err)
	}

	mu.Lock()
	results := gotResults
	mu.Unlock()
	if len(results) != 1 || results[0].CommandID != payload.CommandID {
		t.Fatalf("expected heartbeat to carry the result for %s, got %+v", payload.CommandID, results)
	}

	r.mu.Lock()
	remaining := len(r.pendingCommandResults)
	r.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("expected pendingCommandResults cleared after 2xx, got %d remaining", remaining)
	}

	st := configapply.LoadState(dir)
	if st.LastAppliedCommandID != payload.CommandID {
		t.Fatalf("expected state LastAppliedCommandID %q, got %q", payload.CommandID, st.LastAppliedCommandID)
	}
	found := false
	for _, res := range st.PendingResults {
		if res.CommandID == payload.CommandID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected state PendingResults to retain the LastAppliedCommandID entry after ack, got %+v", st.PendingResults)
	}
}

// Scenario ③ (config-path half): with MihomoConfigPath unset, a dispatched
// command never reaches applyFn at all and gets an immediate failed result
// with reason "config-path-not-set".
func TestDispatchCommandFailsWhenConfigPathUnset(t *testing.T) {
	r := NewRunner(config.Config{
		BackendID:   1,
		AgentID:     "test-agent",
		GatewayType: "clash",
		// MihomoConfigPath intentionally left unset.
	})
	r.lockDir = t.TempDir()

	applyCalled := false
	r.applyFn = func(ctx context.Context, cmd configapply.Command) configapply.Result {
		applyCalled = true
		return configapply.Result{CommandID: cmd.CommandID, Result: configapply.StatusApplied}
	}

	// No executor goroutine is started: the gate must reject this in
	// dispatchCommand, before anything is sent to commandCh ("no goroutine
	// work" per the gating requirement).
	r.handleCommandsFn([]commandPayload{{CommandID: "cmd-no-path"}})

	if applyCalled {
		t.Fatal("expected applyFn never invoked when MihomoConfigPath is unset")
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.pendingCommandResults) != 1 {
		t.Fatalf("expected 1 immediate failed result, got %d", len(r.pendingCommandResults))
	}
	got := r.pendingCommandResults[0]
	if got.CommandID != "cmd-no-path" || got.Result != configapply.StatusFailed || got.Reason != "config-path-not-set" {
		t.Fatalf("unexpected result: %+v", got)
	}
}

// Scenario ③ (gateway half, Task 2 review requirement (c)): a non-clash
// gatewayType rejects the command immediately with reason
// "unsupported-gateway" without ever invoking applyFn, even when
// MihomoConfigPath is set.
func TestDispatchCommandFailsWhenGatewayUnsupported(t *testing.T) {
	r := NewRunner(config.Config{
		BackendID:        1,
		AgentID:          "test-agent",
		GatewayType:      "surge",
		MihomoConfigPath: filepath.Join(t.TempDir(), "config.yaml"),
	})
	r.lockDir = t.TempDir()

	applyCalled := false
	r.applyFn = func(ctx context.Context, cmd configapply.Command) configapply.Result {
		applyCalled = true
		return configapply.Result{CommandID: cmd.CommandID, Result: configapply.StatusApplied}
	}

	r.handleCommandsFn([]commandPayload{{CommandID: "cmd-surge"}})

	if applyCalled {
		t.Fatal("expected applyFn never invoked for a non-clash gateway")
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.pendingCommandResults) != 1 {
		t.Fatalf("expected 1 immediate failed result, got %d", len(r.pendingCommandResults))
	}
	got := r.pendingCommandResults[0]
	if got.CommandID != "cmd-surge" || got.Result != configapply.StatusFailed || got.Reason != "unsupported-gateway" {
		t.Fatalf("unexpected result: %+v", got)
	}
}

// Scenario ④: while a command is mid-execution (blocked inside the health
// gate's SleepFn), a heartbeat redelivering the SAME commandId must not
// trigger a second, concurrent Apply.
func TestConcurrentRedeliveryDuringExecutionDoesNotDoubleApply(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	if err := os.WriteFile(configPath, original, 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	release := make(chan struct{})
	sleepEntered := make(chan struct{}, 1)
	gw := &fakeCmdGateway{configs: map[string]interface{}{"port": 7890.0}, proxies: 1} // mismatched Verify until released

	r := NewRunner(config.Config{
		BackendID:        1,
		AgentID:          "test-agent",
		GatewayType:      "clash",
		MihomoConfigPath: configPath,
	})
	r.lockDir = t.TempDir()

	applier := &configapply.Applier{
		ConfigPath: configPath,
		Gateway:    gw,
		SleepFn: func(time.Duration) {
			select {
			case sleepEntered <- struct{}{}:
			default:
			}
			<-release // block the health-gate poll here until the test releases it
		},
	}
	r.applier = applier

	var applyMu sync.Mutex
	applyCalls := 0
	r.applyFn = func(ctx context.Context, cmd configapply.Command) configapply.Result {
		applyMu.Lock()
		applyCalls++
		applyMu.Unlock()
		return applier.Apply(ctx, cmd)
	}

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go r.runCommandExecLoop(ctx, &wg)
	// A plain `defer cancel()` followed by `defer wg.Wait()` would run in
	// LIFO order (wg.Wait() first, cancel() second) and deadlock: the
	// goroutine can't return from its ctx.Done() select case until cancel()
	// has actually run. Combine into one deferred closure so the order is
	// guaranteed regardless of declaration order.
	defer func() {
		cancel()
		wg.Wait()
	}()

	payload := commandPayload{
		CommandID: "cmd-concurrent",
		BaseHash:  sha256HexForTest(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}
	r.handleCommandsFn([]commandPayload{payload})

	select {
	case <-sleepEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the health gate to start polling")
	}

	// A heartbeat "redelivers" the identical command while it's still
	// in-flight — dispatchCommand must drop it (executingCommandID match).
	r.handleCommandsFn([]commandPayload{payload})
	time.Sleep(50 * time.Millisecond) // let dispatch settle

	applyMu.Lock()
	got := applyCalls
	applyMu.Unlock()
	if got != 1 {
		t.Fatalf("expected exactly 1 Apply invocation while the same command is in flight, got %d", got)
	}

	// Let the health gate see a matching config on its next poll and finish.
	gw.setConfigs(map[string]interface{}{"port": 8080.0})
	close(release)

	waitForPendingResults(t, r, 1)

	applyMu.Lock()
	got = applyCalls
	applyMu.Unlock()
	if got != 1 {
		t.Fatalf("expected still exactly 1 Apply invocation after completion, got %d", got)
	}
}

// Bonus coverage for the defensive (non-single-flight-violating) branch of
// dispatchCommand's contract: a command with an ID distinct from both the
// executing and queued one is queued (commandCh has room, buffer 1), and a
// THIRD distinct command arriving while the buffer is already full is
// dropped. Uses a synthetic applyFn (no real Applier/gateway/file I/O
// needed) since this is purely about commandCh/executingCommandID/
// queuedCommandID bookkeeping, not configapply behavior.
func TestExecutorQueuesDistinctCommandAndDropsAThirdWhenBufferFull(t *testing.T) {
	r := NewRunner(config.Config{
		BackendID:        1,
		AgentID:          "test-agent",
		GatewayType:      "clash",
		MihomoConfigPath: filepath.Join(t.TempDir(), "config.yaml"),
	})
	r.lockDir = t.TempDir()

	started := make(chan string, 8)
	block := make(chan struct{})
	var orderMu sync.Mutex
	var order []string
	r.applyFn = func(ctx context.Context, cmd configapply.Command) configapply.Result {
		started <- cmd.CommandID
		if cmd.CommandID == "cmd-a" {
			<-block // hold cmd-a "executing" until the test releases it
		}
		orderMu.Lock()
		order = append(order, cmd.CommandID)
		orderMu.Unlock()
		return configapply.Result{CommandID: cmd.CommandID, Result: configapply.StatusApplied, CompletedAtMs: time.Now().UnixMilli()}
	}

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go r.runCommandExecLoop(ctx, &wg)
	// See the identical note in TestConcurrentRedeliveryDuringExecutionDoesNotDoubleApply:
	// combined into one deferred closure so cancel() always runs before
	// wg.Wait(), regardless of LIFO defer ordering.
	defer func() {
		cancel()
		wg.Wait()
	}()

	r.handleCommandsFn([]commandPayload{{CommandID: "cmd-a"}})
	select {
	case id := <-started:
		if id != "cmd-a" {
			t.Fatalf("expected cmd-a to start first, got %s", id)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for cmd-a to start executing")
	}

	// cmd-b: distinct from executing cmd-a, commandCh has room -> queued.
	r.handleCommandsFn([]commandPayload{{CommandID: "cmd-b"}})
	// cmd-c: distinct from both executing (cmd-a) and queued (cmd-b);
	// commandCh is now full -> dropped.
	r.handleCommandsFn([]commandPayload{{CommandID: "cmd-c"}})
	time.Sleep(20 * time.Millisecond) // let both dispatches settle

	r.mu.Lock()
	queued := r.queuedCommandID
	r.mu.Unlock()
	if queued != "cmd-b" {
		t.Fatalf("expected cmd-b queued, got %q", queued)
	}

	close(block) // let cmd-a finish

	select {
	case id := <-started:
		if id != "cmd-b" {
			t.Fatalf("expected cmd-b to start next, got %s", id)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for cmd-b to start executing")
	}

	waitForPendingResults(t, r, 2)

	orderMu.Lock()
	got := append([]string(nil), order...)
	orderMu.Unlock()
	if len(got) != 2 || got[0] != "cmd-a" || got[1] != "cmd-b" {
		t.Fatalf("expected cmd-a then cmd-b to complete (cmd-c dropped), got %v", got)
	}
}

// Regression test for the fixed CRITICAL finding: ack-pruning must rebuild
// orbit-agent-state.json's PendingResults from current truth
// (LastAppliedCommandID + whatever is still undelivered), not filter by
// "this heartbeat's delivered set". A filter keyed only on the just-acked
// slice can never re-examine an OLDER entry that was acked on some PRIOR
// heartbeat (that commandId will never appear in a later heartbeat's
// delivered set again), leaking one permanent orphan per applied command.
//
// Two distinct commands, two separate heartbeat-ack cycles: after the
// second ack, state must retain EXACTLY the second command's entry (it's
// now the LastAppliedCommandID replay cache) — the first command's entry
// must be gone, not left behind as an orphan. A restart (fresh Runner +
// loadPersistedCommandResults) must therefore re-seed only the second
// command's result.
func TestAckPruneRebuildsAcrossHeartbeatCyclesLeavesNoOrphan(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	if err := os.WriteFile(configPath, original, 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	gw := &fakeCmdGateway{configs: map[string]interface{}{"port": 8080.0}, proxies: 1}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// This test only cares about the ack (2xx); drain the body so the
		// client's request completes cleanly.
		_, _ = io.Copy(io.Discard, req.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"commands":[]}`))
	}))
	defer srv.Close()

	r := newCommandTestRunner(t, srv.URL, configPath, gw)

	// Command 1: applies against the original content.
	cmd1 := commandPayload{
		CommandID: "cmd-1",
		BaseHash:  sha256HexForTest(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}
	r.handleCommandsFn([]commandPayload{cmd1})
	waitForPendingResults(t, r, 1)

	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatalf("first sendHeartbeat: %v", err)
	}

	st := configapply.LoadState(dir)
	if st.LastAppliedCommandID != cmd1.CommandID {
		t.Fatalf("expected LastAppliedCommandID %q after first apply, got %q", cmd1.CommandID, st.LastAppliedCommandID)
	}
	if len(st.PendingResults) != 1 || st.PendingResults[0].CommandID != cmd1.CommandID {
		t.Fatalf("expected state to retain exactly cmd-1's entry after first ack, got %+v", st.PendingResults)
	}

	// Command 2: applies against the config left behind by command 1 — must
	// recompute baseHash from the CURRENT disk content, and update the fake
	// gateway's verify-matching config so command 2's own health gate passes.
	afterCmd1, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config after cmd-1: %v", err)
	}
	gw.setConfigs(map[string]interface{}{"port": 9090.0})
	cmd2 := commandPayload{
		CommandID: "cmd-2",
		BaseHash:  sha256HexForTest(afterCmd1),
		Content:   "port: 9090\n",
		Verify:    map[string]interface{}{"port": 9090},
	}
	r.handleCommandsFn([]commandPayload{cmd2})
	waitForPendingResults(t, r, 1)

	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatalf("second sendHeartbeat: %v", err)
	}

	st = configapply.LoadState(dir)
	if st.LastAppliedCommandID != cmd2.CommandID {
		t.Fatalf("expected LastAppliedCommandID %q after second apply, got %q", cmd2.CommandID, st.LastAppliedCommandID)
	}
	if len(st.PendingResults) != 1 || st.PendingResults[0].CommandID != cmd2.CommandID {
		t.Fatalf("expected state to retain EXACTLY cmd-2's entry after second ack (cmd-1 must be pruned, no orphan left behind), got %+v", st.PendingResults)
	}

	// Restart: a fresh Runner over the same config dir must re-send only
	// cmd-2's result, not a stale cmd-1 orphan.
	fresh := NewRunner(config.Config{
		BackendID:        1,
		AgentID:          "test-agent",
		GatewayType:      "clash",
		MihomoConfigPath: configPath,
	})
	fresh.loadPersistedCommandResults()
	fresh.mu.Lock()
	seeded := append([]commandResult(nil), fresh.pendingCommandResults...)
	fresh.mu.Unlock()
	if len(seeded) != 1 || seeded[0].CommandID != cmd2.CommandID {
		t.Fatalf("expected restart to re-seed exactly cmd-2's result, got %+v", seeded)
	}
}

// Minor: gate precedence is deterministic. When BOTH gates in
// dispatchCommand would independently fire (a non-clash gateway AND an
// unset config path), the gatewayType check runs first, so
// "unsupported-gateway" wins over "config-path-not-set".
func TestDispatchCommandGatePrecedenceGatewayWinsOverPath(t *testing.T) {
	r := NewRunner(config.Config{
		BackendID:   1,
		AgentID:     "test-agent",
		GatewayType: "surge",
		// MihomoConfigPath intentionally also left unset — both gates apply.
	})
	r.lockDir = t.TempDir()

	r.handleCommandsFn([]commandPayload{{CommandID: "cmd-both-gates"}})

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.pendingCommandResults) != 1 {
		t.Fatalf("expected 1 immediate failed result, got %d", len(r.pendingCommandResults))
	}
	got := r.pendingCommandResults[0]
	if got.Reason != "unsupported-gateway" {
		t.Fatalf("expected gate precedence to pick unsupported-gateway, got %q", got.Reason)
	}
}
