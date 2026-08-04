package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/btnalit/MihomoOrbit/apps/agent/internal/config"
	"github.com/btnalit/MihomoOrbit/apps/agent/internal/domain"
)

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
	// 模拟同机残留的上游 neko-agent 持有旧锁
	legacy := filepath.Join(os.TempDir(), "neko-agent-backend-4242.lock")
	if err := os.WriteFile(legacy, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(legacy)

	r := NewRunner(config.Config{BackendID: 4242})
	if err := r.acquireLock(); err == nil {
		r.releaseLock()
		t.Fatal("acquireLock() succeeded while a legacy neko-agent lock was held; duplicate reporting would double-count traffic")
	}

	// 回滚校验:旧锁获取失败时,先拿到的新锁必须已释放,不能留下孤儿锁文件
	orbit := filepath.Join(os.TempDir(), "orbit-agent-backend-4242.lock")
	if _, err := os.Stat(orbit); err == nil {
		os.Remove(orbit)
		t.Fatal("acquireLock() left the orbit lock behind after failing on the legacy lock")
	}
}

func TestAcquireLockCreatesBothLocksThenReleasesThem(t *testing.T) {
	r := NewRunner(config.Config{BackendID: 4243})
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
