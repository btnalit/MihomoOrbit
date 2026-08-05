package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/btnalit/MihomoOrbit/apps/agent/internal/config"
	"github.com/btnalit/MihomoOrbit/apps/agent/internal/domain"
)

// newTestRunner builds a Runner whose lock files live under a per-test
// t.TempDir() instead of the shared OS temp dir. Sharing os.TempDir() across
// tests (or parallel test runs) with fixed backend IDs is what caused the
// original flake: leftover lock files from a previous run, or a concurrent
// run using the same ID, collide.
func newTestRunner(t *testing.T, backendID int) *Runner {
	t.Helper()
	r := NewRunner(config.Config{BackendID: backendID})
	r.lockDir = t.TempDir()
	return r
}

// withFakeProcessRunning temporarily replaces isProcessRunningFn — the seam
// acquireLockAt and checkLockOwnership use to decide held-vs-stale — so
// tests can drive that decision deterministically without depending on real
// process PIDs, permissions, or timing.
func withFakeProcessRunning(t *testing.T, fn func(pid int) bool) {
	t.Helper()
	orig := isProcessRunningFn
	isProcessRunningFn = fn
	t.Cleanup(func() { isProcessRunningFn = orig })
}

// withFakeProcComm temporarily replaces readProcComm — the seam
// isProcessRunning uses to read /proc/<pid>/comm — so tests can assert on
// the comm-matching logic itself using a real, always-alive PID (typically
// the test binary's own) without needing a real process named neko-agent or
// orbit-agent.
func withFakeProcComm(t *testing.T, comm string) {
	t.Helper()
	orig := readProcComm
	readProcComm = func(int) ([]byte, error) { return []byte(comm), nil }
	t.Cleanup(func() { readProcComm = orig })
}

func TestIngestSnapshotsDeltaCalculation(t *testing.T) {
	runner := NewRunner(config.Config{
		ServerAPIBase:       "http://localhost:3000/api",
		BackendID:           1,
		BackendToken:        "token",
		AgentID:             "agent-test",
		GatewayType:         "surge",
		GatewayEndpoint:     "http://127.0.0.1:9091/v1/requests/recent",
		ReportInterval:      time.Second,
		HeartbeatInterval:   time.Second,
		GatewayPollInterval: time.Second,
		RequestTimeout:      time.Second,
		ReportBatchSize:     100,
		MaxPendingUpdates:   1000,
		StaleFlowTimeout:    time.Minute,
	})

	runner.ingestSnapshots([]domain.FlowSnapshot{{
		ID:       "flow-1",
		Upload:   10,
		Download: 20,
		Chains:   []string{"Proxy"},
		Rule:     "MATCH",
	}}, 1000)

	first := runner.takeBatch(10)
	if len(first) != 1 {
		t.Fatalf("expected first batch len 1, got %d", len(first))
	}
	if first[0].Upload != 10 || first[0].Download != 20 {
		t.Fatalf("expected first delta 10/20, got %d/%d", first[0].Upload, first[0].Download)
	}
	if first[0].Connections != 1 {
		t.Fatalf("expected first connections 1, got %d", first[0].Connections)
	}

	runner.ingestSnapshots([]domain.FlowSnapshot{{
		ID:       "flow-1",
		Upload:   25,
		Download: 50,
		Chains:   []string{"Proxy"},
		Rule:     "MATCH",
	}}, 2000)

	second := runner.takeBatch(10)
	if len(second) != 1 {
		t.Fatalf("expected second batch len 1, got %d", len(second))
	}
	if second[0].Upload != 15 || second[0].Download != 30 {
		t.Fatalf("expected second delta 15/30, got %d/%d", second[0].Upload, second[0].Download)
	}
	if second[0].Connections != 0 {
		t.Fatalf("expected second connections 0, got %d", second[0].Connections)
	}

	runner.ingestSnapshots([]domain.FlowSnapshot{{
		ID:       "flow-1",
		Upload:   5,
		Download: 3,
		Chains:   []string{"Proxy"},
		Rule:     "MATCH",
	}}, 3000)

	// Counter reset (upload went backwards 25 -> 5): match the direct gateway
	// collector and count the current value as new traffic, re-counting the
	// connection, instead of silently dropping it.
	third := runner.takeBatch(10)
	if len(third) != 1 {
		t.Fatalf("expected third batch len 1 when counters reset, got %d", len(third))
	}
	if third[0].Upload != 5 || third[0].Download != 3 {
		t.Fatalf("expected reset to count current 5/3 as new traffic, got %d/%d", third[0].Upload, third[0].Download)
	}
	if third[0].Connections != 1 {
		t.Fatalf("expected reset to re-count connection (1), got %d", third[0].Connections)
	}
}

func TestIngestSnapshotsFirstTrafficAfterZeroCarriesConnection(t *testing.T) {
	runner := NewRunner(config.Config{
		ServerAPIBase:       "http://localhost:3000/api",
		BackendID:           1,
		BackendToken:        "token",
		AgentID:             "agent-test",
		GatewayType:         "clash",
		GatewayEndpoint:     "http://127.0.0.1:9090",
		ReportInterval:      time.Second,
		HeartbeatInterval:   time.Second,
		GatewayPollInterval: time.Second,
		RequestTimeout:      time.Second,
		ReportBatchSize:     100,
		MaxPendingUpdates:   1000,
		StaleFlowTimeout:    time.Minute,
	})

	runner.ingestSnapshots([]domain.FlowSnapshot{{
		ID:       "flow-2",
		Upload:   0,
		Download: 0,
		Chains:   []string{"DIRECT"},
		Rule:     "Match",
	}}, 1000)

	if batch := runner.takeBatch(10); len(batch) != 0 {
		t.Fatalf("expected no batch for zero traffic, got %d", len(batch))
	}

	runner.ingestSnapshots([]domain.FlowSnapshot{{
		ID:       "flow-2",
		Upload:   8,
		Download: 5,
		Chains:   []string{"DIRECT"},
		Rule:     "Match",
	}}, 2000)

	second := runner.takeBatch(10)
	if len(second) != 1 {
		t.Fatalf("expected one update after first traffic, got %d", len(second))
	}
	if second[0].Upload != 8 || second[0].Download != 5 {
		t.Fatalf("expected delta 8/5, got %d/%d", second[0].Upload, second[0].Download)
	}
	if second[0].Connections != 1 {
		t.Fatalf("expected connections 1 for first non-zero traffic, got %d", second[0].Connections)
	}
}

// 双锁:改名后必须同时占用新旧两个锁路径。锁文件是新旧 agent 二进制之间
// 唯一的互斥点——默认 agentId 由 backendToken 哈希派生,与二进制名无关,
// 服务端无法区分二者,残留的 neko-agent 会与本 agent 同时上报导致流量翻倍。
func TestLockPathsCoverLegacyAndNew(t *testing.T) {
	r := NewRunner(config.Config{BackendID: 42})
	got := r.lockPaths()
	want := []string{
		filepath.Join(os.TempDir(), "orbit-agent-backend-42.lock"),
		filepath.Join(os.TempDir(), "neko-agent-backend-42.lock"),
	}
	if len(got) != len(want) {
		t.Fatalf("lockPaths() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("lockPaths()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestAcquireLockFailsWhenLegacyLockHeld(t *testing.T) {
	r := newTestRunner(t, 1)

	// 模拟同机残留的上游 neko-agent 持有旧锁:PID 必须不同于本进程 PID,
	// 否则会绕过 isProcessRunningFn 分支,只测到 O_EXCL 冲突而非存活判定
	// (这正是 I4 里旧测试失败的原因)。isProcessRunningFn 被 fake 为始终
	// "存活",专门验证 acquireLock 在存活进程持锁时必须失败。
	foreignPID := os.Getpid() + 1
	withFakeProcessRunning(t, func(pid int) bool { return pid == foreignPID })

	legacy := filepath.Join(r.lockDir, "neko-agent-backend-1.lock")
	if err := os.WriteFile(legacy, []byte(strconv.Itoa(foreignPID)), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := r.acquireLock(); err == nil {
		r.releaseLock()
		t.Fatal("acquireLock() succeeded while a legacy neko-agent lock was held; duplicate reporting would double-count traffic")
	}

	// 回滚校验:旧锁获取失败时,先拿到的新锁必须已释放,不能留下孤儿锁文件
	orbit := filepath.Join(r.lockDir, "orbit-agent-backend-1.lock")
	if _, err := os.Stat(orbit); err == nil {
		os.Remove(orbit)
		t.Fatal("acquireLock() left the orbit lock behind after failing on the legacy lock")
	}
}

func TestAcquireLockCreatesBothLocksThenReleasesThem(t *testing.T) {
	r := newTestRunner(t, 2)
	if err := r.acquireLock(); err != nil {
		t.Fatalf("acquireLock() = %v, want nil", err)
	}
	for _, p := range r.lockPaths() {
		if _, err := os.Stat(p); err != nil {
			r.releaseLock()
			t.Fatalf("lock file %q was not created: %v", p, err)
		}
	}
	r.releaseLock()
	for _, p := range r.lockPaths() {
		if _, err := os.Stat(p); err == nil {
			os.Remove(p)
			t.Fatalf("lock file %q survived releaseLock()", p)
		}
	}
}

// isProcessRunning's comm matching is the crux of I3: the runner's lock only
// protects against a legacy neko-agent when that agent's own (unpatched)
// isProcessRunning would in turn recognize orbit-agent as alive. These cases
// exercise the real isProcessRunning (not a fake) against a real, always-live
// PID (our own test process) with a faked comm, so the assertions are about
// the actual string-matching logic, not process liveness.
func TestIsProcessRunningMatchesAgentCommNames(t *testing.T) {
	pid := os.Getpid()
	cases := []struct {
		name string
		comm string
		want bool
	}{
		{"legacy neko-agent comm", "neko-agent\n", true},
		{"new orbit-agent comm", "orbit-agent\n", true},
		{"unrelated process comm", "some-other-proc\n", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withFakeProcComm(t, tc.comm)
			if got := isProcessRunning(pid); got != tc.want {
				t.Fatalf("isProcessRunning(%d) with comm %q = %v, want %v", pid, tc.comm, got, tc.want)
			}
		})
	}
}

func TestAcquireLockAtFailsWhenForeignPidIsLive(t *testing.T) {
	r := newTestRunner(t, 3)
	lockPath := filepath.Join(r.lockDir, "live.lock")
	foreignPID := os.Getpid() + 1
	if err := os.WriteFile(lockPath, []byte(strconv.Itoa(foreignPID)), 0o644); err != nil {
		t.Fatal(err)
	}
	withFakeProcessRunning(t, func(pid int) bool { return pid == foreignPID })

	if file, err := r.acquireLockAt(lockPath); err == nil {
		file.Close()
		t.Fatal("acquireLockAt() succeeded despite a live foreign agent PID holding the lock")
	}
}

func TestAcquireLockAtTreatsDeadForeignPidAsStaleAndSucceeds(t *testing.T) {
	r := newTestRunner(t, 4)
	lockPath := filepath.Join(r.lockDir, "stale.lock")
	foreignPID := os.Getpid() + 1
	if err := os.WriteFile(lockPath, []byte(strconv.Itoa(foreignPID)), 0o644); err != nil {
		t.Fatal(err)
	}
	withFakeProcessRunning(t, func(int) bool { return false })

	file, err := r.acquireLockAt(lockPath)
	if err != nil {
		t.Fatalf("acquireLockAt() = %v, want nil (dead foreign lock should be reclaimed)", err)
	}
	defer func() {
		file.Close()
		os.Remove(lockPath)
	}()

	var gotPID int
	data, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("reacquired lock file unreadable: %v", err)
	}
	fmt.Sscanf(string(data), "%d", &gotPID)
	if gotPID != os.Getpid() {
		t.Fatalf("reacquired lock file pid = %d, want our own pid %d", gotPID, os.Getpid())
	}
}

// I3: the periodic self-check must detect when a live foreign agent process
// has taken over one of our lock files and signal that the runner should
// exit — checkLockOwnership() is the synchronously-callable decision
// function underlying that check (runLockWatchLoop is just a ticker wrapper
// around it), so this drives it directly without waiting on the real
// 60s interval.
//
// This targets the legacy lock (lockPaths()[1]) deliberately: that's the
// real I3 vector — upstream neko-agent's own isProcessRunning only ever
// touches neko-agent-backend-<id>.lock, never the orbit-agent one.
func TestCheckLockOwnershipDetectsTheftAndSignalsExit(t *testing.T) {
	r := newTestRunner(t, 5)
	if err := r.acquireLock(); err != nil {
		t.Fatalf("acquireLock() = %v, want nil", err)
	}
	defer r.releaseLock()

	stolenPath := r.lockFiles[1].Name()
	foreignPID := os.Getpid() + 1
	if err := os.WriteFile(stolenPath, []byte(strconv.Itoa(foreignPID)), 0o644); err != nil {
		t.Fatal(err)
	}
	withFakeProcessRunning(t, func(pid int) bool { return pid == foreignPID })

	if lost := r.checkLockOwnership(); !lost {
		t.Fatal("checkLockOwnership() = false, want true when a live foreign agent holds one of our locks")
	}
	if r.lockFiles[1] != nil {
		t.Fatal("checkLockOwnership() must clear the lock slot it couldn't reacquire, so releaseLock() doesn't delete the foreign agent's lock file")
	}
	if _, err := os.Stat(stolenPath); err != nil {
		t.Fatalf("stolen lock file should be left untouched on disk, stat error: %v", err)
	}
}

// The false-alarm case the takeover check must not trip on: acquireLockAt
// can fail for reasons that are not a confirmed live foreign PID holding the
// lock — e.g. the file currently contains unparseable content or PID 0,
// which trips acquireLockAt's own `pid > 0 && pid != os.Getpid()`
// short-circuit (skipping its liveness/stale check) straight into an
// O_EXCL-exists error. checkLockOwnership must not treat that as a
// takeover and exit; it should log and leave the slot to retry.
func TestCheckLockOwnershipDoesNotExitOnUnconfirmedFailure(t *testing.T) {
	r := newTestRunner(t, 9)
	if err := r.acquireLock(); err != nil {
		t.Fatalf("acquireLock() = %v, want nil", err)
	}
	defer r.releaseLock()

	path := r.lockFiles[0].Name()
	if err := os.WriteFile(path, []byte("not-a-pid"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Never reached in this scenario (the garbled content fails PID parsing
	// before isProcessRunningFn would be consulted); set explicitly so the
	// test fails loudly instead of exercising the real /proc reader if that
	// invariant ever changes.
	withFakeProcessRunning(t, func(int) bool { return false })

	if lost := r.checkLockOwnership(); lost {
		t.Fatal("checkLockOwnership() = true, want false: garbled lock file content is not a confirmed foreign takeover")
	}
	if r.lockFiles[0] == nil {
		t.Fatal("checkLockOwnership() should not permanently abandon a slot it hasn't confirmed lost — it must remain retryable on the next check")
	}
}

func TestCheckLockOwnershipReacquiresMissingLock(t *testing.T) {
	r := newTestRunner(t, 6)
	if err := r.acquireLock(); err != nil {
		t.Fatalf("acquireLock() = %v, want nil", err)
	}
	defer r.releaseLock()

	missingPath := r.lockFiles[0].Name()
	if err := os.Remove(missingPath); err != nil {
		t.Fatal(err)
	}

	if lost := r.checkLockOwnership(); lost {
		t.Fatal("checkLockOwnership() = true, want false when the lock file is simply missing and reacquirable")
	}
	if r.lockFiles[0] == nil {
		t.Fatal("checkLockOwnership() should replace the missing lock with a freshly reacquired file handle")
	}

	var gotPID int
	data, err := os.ReadFile(missingPath)
	if err != nil {
		t.Fatalf("reacquired lock file missing on disk: %v", err)
	}
	fmt.Sscanf(string(data), "%d", &gotPID)
	if gotPID != os.Getpid() {
		t.Fatalf("reacquired lock file pid = %d, want our own pid %d", gotPID, os.Getpid())
	}
}

func TestCheckLockOwnershipNoOpWhenStillOwned(t *testing.T) {
	r := newTestRunner(t, 7)
	if err := r.acquireLock(); err != nil {
		t.Fatalf("acquireLock() = %v, want nil", err)
	}
	defer r.releaseLock()

	original := make([]*os.File, len(r.lockFiles))
	copy(original, r.lockFiles)

	if lost := r.checkLockOwnership(); lost {
		t.Fatal("checkLockOwnership() = true, want false when every lock is still owned by us")
	}
	for i, f := range r.lockFiles {
		if f != original[i] {
			t.Fatalf("checkLockOwnership() replaced lock file handle %d though ownership was unchanged", i)
		}
	}
}

func TestReleaseLockDoesNotPanicOnNilSlot(t *testing.T) {
	r := newTestRunner(t, 8)
	if err := r.acquireLock(); err != nil {
		t.Fatalf("acquireLock() = %v, want nil", err)
	}
	r.lockFiles[0].Close()
	os.Remove(r.lockFiles[0].Name())
	r.lockFiles[0] = nil // simulate checkLockOwnership() giving up on a stolen lock

	r.releaseLock() // must not panic
}
