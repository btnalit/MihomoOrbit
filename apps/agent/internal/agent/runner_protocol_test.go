package agent

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/btnalit/MihomoOrbit/apps/agent/internal/config"
)

// This package doesn't compile natively on Windows (runner.go's syscall.Kill
// is Unix-only; see AGENTS.md/CLAUDE.md platform constraints), so these
// tests only run in CI (ubuntu, agent-build.yml). Locally they are verified
// via `GOOS=linux go vet ./...` and
// `GOOS=linux go test -c -o /dev/null ./internal/agent/` (compile-check
// only).

// fakeCommand is the shape the fake httptest collector below writes back
// for /agent/heartbeat's "commands" field.
type fakeCommand struct {
	CommandID  string                 `json:"commandId"`
	Type       string                 `json:"type"`
	BaseHash   string                 `json:"baseHash"`
	Content    string                 `json:"content"`
	Verify     map[string]interface{} `json:"verify"`
	IssuedAtMs int64                  `json:"issuedAtMs"`
}

// newProtocolTestRunner builds a Runner pointed at srv with a per-test
// lockDir, same pattern as newTestRunner in runner_test.go.
func newProtocolTestRunner(t *testing.T, srv *httptest.Server) *Runner {
	t.Helper()
	r := NewRunner(config.Config{
		ServerAPIBase:  srv.URL,
		RequestTimeout: 5 * time.Second,
		BackendID:      1,
		AgentID:        "test-agent",
	})
	r.lockDir = t.TempDir()
	return r
}

// TestSendHeartbeatDeliversCommandsToHandler covers scenario ①: a heartbeat
// response carrying one command must reach the injected handleCommandsFn.
func TestSendHeartbeatDeliversCommandsToHandler(t *testing.T) {
	cmd := fakeCommand{
		CommandID:  "cmd_abc123",
		Type:       "apply-config",
		BaseHash:   "deadbeef",
		Content:    "port: 7890\n",
		Verify:     map[string]interface{}{"port": float64(7890)},
		IssuedAtMs: 1722840000000,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		resp := struct {
			Success  bool          `json:"success"`
			Commands []fakeCommand `json:"commands"`
		}{Success: true, Commands: []fakeCommand{cmd}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	r := newProtocolTestRunner(t, srv)

	var mu sync.Mutex
	var received []commandPayload
	r.handleCommandsFn = func(cmds []commandPayload) {
		mu.Lock()
		defer mu.Unlock()
		received = append(received, cmds...)
	}

	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatalf("sendHeartbeat returned error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Fatalf("expected handleCommandsFn to receive 1 command, got %d", len(received))
	}
	if received[0].CommandID != cmd.CommandID {
		t.Fatalf("expected commandId %q, got %q", cmd.CommandID, received[0].CommandID)
	}
	if received[0].BaseHash != cmd.BaseHash || received[0].Content != cmd.Content {
		t.Fatalf("command payload mismatch: %+v", received[0])
	}
}

// TestSendHeartbeatCarriesAndClearsCommandResults covers scenario ②:
// protocolVersion must be 2 in the request body, pending commandResults must
// be attached to that request, and cleared once the collector answers 2xx.
func TestSendHeartbeatCarriesAndClearsCommandResults(t *testing.T) {
	var mu sync.Mutex
	var gotPayload heartbeatPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// postJSONWithLatency always sends gzip-compressed request bodies
		// (Content-Encoding: gzip); net/http's server does not
		// auto-decompress request bodies (only chunked transfer-encoding is
		// handled for you), so this fake collector must gunzip itself.
		gr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Errorf("gunzip heartbeat request body: %v", err)
			w.WriteHeader(http.StatusOK)
			return
		}
		defer gr.Close()
		var p heartbeatPayload
		if err := json.NewDecoder(gr).Decode(&p); err != nil {
			t.Errorf("collector failed to decode heartbeat payload: %v", err)
		}
		mu.Lock()
		gotPayload = p
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"commands":[]}`))
	}))
	defer srv.Close()

	r := newProtocolTestRunner(t, srv)
	r.pendingCommandResults = []commandResult{
		{CommandID: "cmd_1", Result: "applied", CompletedAtMs: 1722840001000},
	}

	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatalf("sendHeartbeat returned error: %v", err)
	}

	mu.Lock()
	p := gotPayload
	mu.Unlock()

	if p.ProtocolVersion != 2 {
		t.Fatalf("expected protocolVersion 2, got %d", p.ProtocolVersion)
	}
	if len(p.CommandResults) != 1 || p.CommandResults[0].CommandID != "cmd_1" {
		t.Fatalf("expected commandResults to carry cmd_1, got %+v", p.CommandResults)
	}

	r.mu.Lock()
	remaining := len(r.pendingCommandResults)
	r.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("expected pendingCommandResults cleared after 2xx, got %d remaining", remaining)
	}
}

// TestSendHeartbeatOversizeResponseErrors covers scenario ③: a response body
// over 512KB must error and must NOT invoke handleCommandsFn.
func TestSendHeartbeatOversizeResponseErrors(t *testing.T) {
	oversizeContent := strings.Repeat("a", (512<<10)+1024)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		resp := struct {
			Success  bool          `json:"success"`
			Commands []fakeCommand `json:"commands"`
		}{Success: true, Commands: []fakeCommand{{CommandID: "cmd_big", Content: oversizeContent}}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	r := newProtocolTestRunner(t, srv)

	called := false
	r.handleCommandsFn = func(cmds []commandPayload) { called = true }

	err := r.sendHeartbeat(context.Background())
	if err == nil {
		t.Fatal("expected error for oversize response body")
	}
	if called {
		t.Fatal("handleCommandsFn must not be called when response body exceeds the size limit")
	}
}

// TestOtherPostPathsNeverTriggerCommandHandler covers scenario ④: the dual
// contract's agent half. /agent/report, /agent/config, and
// /agent/policy-state all share postJSON (the thin wrapper around
// postJSONWithLatency that every non-heartbeat call site uses) — it discards
// the response body by construction, so even a collector that (incorrectly)
// includes commands on these paths can never reach handleCommandsFn. This
// exercises the exact shared function those three call sites use, against a
// collector response shaped like a heartbeat response with commands.
func TestOtherPostPathsNeverTriggerCommandHandler(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		resp := struct {
			Success  bool          `json:"success"`
			Commands []fakeCommand `json:"commands"`
		}{Success: true, Commands: []fakeCommand{{CommandID: "cmd_should_be_ignored"}}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	r := newProtocolTestRunner(t, srv)
	called := false
	r.handleCommandsFn = func(cmds []commandPayload) { called = true }

	for _, path := range []string{"/agent/report", "/agent/config", "/agent/policy-state"} {
		if err := r.postJSON(context.Background(), path, map[string]string{"x": "y"}); err != nil {
			t.Fatalf("postJSON(%s) returned error: %v", path, err)
		}
	}

	if called {
		t.Fatal("handleCommandsFn must not be triggered by /agent/config, /agent/policy-state, or /agent/report responses")
	}
}
