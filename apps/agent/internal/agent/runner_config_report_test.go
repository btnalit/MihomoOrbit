package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/btnalit/MihomoOrbit/apps/agent/internal/config"
)

// TestPostConfigFileDetects404 exercises the runner's PostFunc closure
// (postConfigFile) against a real HTTP server via postJSONWithLatency: it
// must report status404=true only for an actual HTTP 404 response, and
// status404=false for both success and any other non-2xx status, since only
// a 404 (an unupgraded collector) should drive configfile.Reporter's backoff
// — a transient 5xx should not.
//
// This package doesn't compile natively on Windows (runner.go's
// syscall.Kill is Unix-only; see AGENTS.md/CLAUDE.md platform constraints),
// so this test only runs in CI (ubuntu, agent-build.yml). Locally it is
// verified via `GOOS=linux go vet ./...` and
// `GOOS=linux go test -c -o /dev/null ./internal/agent/` (compile-check
// only).
func TestPostConfigFileDetects404(t *testing.T) {
	var mu sync.Mutex
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		s := status
		mu.Unlock()
		w.WriteHeader(s)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	r := NewRunner(config.Config{
		ServerAPIBase:  srv.URL,
		RequestTimeout: 5 * time.Second,
		BackendID:      1,
		AgentID:        "test-agent",
	})

	// 200: success, status404 must be false and err nil.
	status404, err := r.postConfigFile(context.Background(), "/agent/config-file", map[string]string{"x": "y"})
	if err != nil || status404 {
		t.Fatalf("want success (status404=false, err=nil), got status404=%v err=%v", status404, err)
	}

	// 404: status404 must be true, err non-nil.
	mu.Lock()
	status = http.StatusNotFound
	mu.Unlock()
	status404, err = r.postConfigFile(context.Background(), "/agent/config-file", map[string]string{"x": "y"})
	if err == nil {
		t.Fatal("want error on 404 response")
	}
	if !status404 {
		t.Fatalf("want status404=true for a 404 response, got false (err=%v)", err)
	}
	if !strings.Contains(err.Error(), "404") {
		t.Fatalf("want error to mention 404, got: %v", err)
	}

	// 500: err non-nil but status404 must be false — a transient server
	// error is not "collector not upgraded" and must not drive backoff.
	mu.Lock()
	status = http.StatusInternalServerError
	mu.Unlock()
	status404, err = r.postConfigFile(context.Background(), "/agent/config-file", map[string]string{"x": "y"})
	if err == nil {
		t.Fatal("want error on 500 response")
	}
	if status404 {
		t.Fatalf("want status404=false for a non-404 error, got true (err=%v)", err)
	}
}
