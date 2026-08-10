package gateway

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"net/http"
	"net/http/httptest"

	"github.com/btnalit/MihomoOrbit/apps/agent/internal/configapply"
)

// Compile-time proof that Client satisfies configapply.GatewayAPI — the
// contract configapply's six-step write-back is written against.
var _ configapply.GatewayAPI = (*Client)(nil)

func TestCollectSurgeSupportsFlexibleFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"requests": [
				{
					"id": 123,
					"remoteHost": "example.com:443",
					"remoteAddress": "93.184.216.34:443",
					"localAddress": "192.168.1.2:56123",
					"policyName": "Proxy",
					"originalPolicyName": "MATCH",
					"rule": "DOMAIN-SUFFIX,example.com",
					"notes": "single-note",
					"outBytes": "100.9",
					"inBytes": 200,
					"time": "1700000000123"
				}
			]
		}`))
	}))
	defer server.Close()

	client := NewClient(server.Client(), "surge", server.URL+"/v1/requests/recent", "")
	snapshots, err := client.Collect(context.Background())
	if err != nil {
		t.Fatalf("Collect returned error: %v", err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("expected 1 snapshot, got %d", len(snapshots))
	}

	s := snapshots[0]
	if s.ID != "123" {
		t.Fatalf("expected id 123, got %q", s.ID)
	}
	if s.Domain != "example.com" {
		t.Fatalf("expected domain example.com, got %q", s.Domain)
	}
	if s.Upload != 100 {
		t.Fatalf("expected upload 100, got %d", s.Upload)
	}
	if s.Download != 200 {
		t.Fatalf("expected download 200, got %d", s.Download)
	}
	if s.TimestampMs != 1700000000123 {
		t.Fatalf("expected timestamp 1700000000123, got %d", s.TimestampMs)
	}
}

func TestCollectSurgeDecodeErrorIncludesDebugHint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"requests":[{"id":{"bad":1}}]}`))
	}))
	defer server.Close()

	client := NewClient(server.Client(), "surge", server.URL+"/v1/requests/recent", "")
	_, err := client.Collect(context.Background())
	if err == nil {
		t.Fatal("expected decode error, got nil")
	}

	msg := err.Error()
	if !strings.Contains(msg, "decode surge response") {
		t.Fatalf("expected decode error message, got: %s", msg)
	}
	if !strings.Contains(msg, "first request id type=object") {
		t.Fatalf("expected debug id type hint, got: %s", msg)
	}
}

func TestPutConfigsReloadSendsExpectedRequest(t *testing.T) {
	var gotMethod, gotPath, gotQuery, gotAuth, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient(server.Client(), "clash", server.URL, "secret-token")
	err := client.PutConfigsReload(context.Background(), "/etc/mihomo/config.yaml")
	if err != nil {
		t.Fatalf("PutConfigsReload returned error: %v", err)
	}

	if gotMethod != http.MethodPut {
		t.Fatalf("expected PUT, got %s", gotMethod)
	}
	if gotPath != "/configs" {
		t.Fatalf("expected path /configs, got %s", gotPath)
	}
	if gotQuery != "force=true" {
		t.Fatalf("expected query force=true, got %s", gotQuery)
	}
	if gotAuth != "Bearer secret-token" {
		t.Fatalf("expected Authorization header, got %q", gotAuth)
	}

	var payload map[string]string
	if err := json.Unmarshal([]byte(gotBody), &payload); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if payload["path"] != "/etc/mihomo/config.yaml" {
		t.Fatalf("expected body path, got %+v", payload)
	}
}

func TestPutConfigsReloadNonSurgeUsesXKeyHeader(t *testing.T) {
	var gotAuth, gotXKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotXKey = r.Header.Get("X-Key")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.Client(), "surge", server.URL, "surge-token")
	if err := client.PutConfigsReload(context.Background(), "/etc/surge/config.conf"); err != nil {
		t.Fatalf("PutConfigsReload returned error: %v", err)
	}
	if gotXKey != "surge-token" {
		t.Fatalf("expected X-Key header for surge, got %q", gotXKey)
	}
	if gotAuth != "" {
		t.Fatalf("expected no Authorization header for surge, got %q", gotAuth)
	}
}

func TestPutConfigsReloadNonSuccessReturnsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer server.Close()

	client := NewClient(server.Client(), "clash", server.URL, "")
	err := client.PutConfigsReload(context.Background(), "/etc/mihomo/config.yaml")
	if err == nil {
		t.Fatal("expected error on non-2xx response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected error to mention status code, got: %v", err)
	}
}

func TestGetConfigsJSONDecodesGenericMap(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/configs" {
			t.Errorf("expected path /configs, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"port":7890,"mode":"rule","allow-lan":false}`))
	}))
	defer server.Close()

	client := NewClient(server.Client(), "clash", server.URL, "")
	got, err := client.GetConfigsJSON(context.Background())
	if err != nil {
		t.Fatalf("GetConfigsJSON returned error: %v", err)
	}
	if got["port"] != 7890.0 {
		t.Fatalf("expected port 7890, got %v", got["port"])
	}
	if got["mode"] != "rule" {
		t.Fatalf("expected mode rule, got %v", got["mode"])
	}
	if got["allow-lan"] != false {
		t.Fatalf("expected allow-lan false, got %v", got["allow-lan"])
	}
}

func TestGetProxiesCountReusesProxiesResponseShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/proxies" {
			t.Errorf("expected path /proxies, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"proxies":{"DIRECT":{"name":"DIRECT","type":"Direct"},"PROXY":{"name":"PROXY","type":"Selector","now":"DIRECT"}}}`))
	}))
	defer server.Close()

	client := NewClient(server.Client(), "clash", server.URL, "")
	count, err := client.GetProxiesCount(context.Background())
	if err != nil {
		t.Fatalf("GetProxiesCount returned error: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected count 2, got %d", count)
	}
}

func TestGetProxiesCountEmpty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"proxies":{}}`))
	}))
	defer server.Close()

	client := NewClient(server.Client(), "clash", server.URL, "")
	count, err := client.GetProxiesCount(context.Background())
	if err != nil {
		t.Fatalf("GetProxiesCount returned error: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected count 0, got %d", count)
	}
}
