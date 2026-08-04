package gateway

import (
	"context"
	"strings"
	"testing"

	"net/http"
	"net/http/httptest"
)

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
