package configfile

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestNextReportDelayBacksOffOn404 pins the doubling-with-cap backoff curve:
// each additional consecutive 404 doubles the delay from base, capped at 1
// hour so an agent talking to an unupgraded collector settles onto a quiet,
// bounded retry cadence instead of hammering it forever.
func TestNextReportDelayBacksOffOn404(t *testing.T) {
	base := 60 * time.Second
	cases := []struct {
		n404 int
		want time.Duration
	}{
		{0, 60 * time.Second},
		{1, 2 * time.Minute},
		{2, 4 * time.Minute},
		{6, time.Hour},
		{10, time.Hour}, // capped at 1h
	}
	for _, c := range cases {
		if got := NextReportDelay(base, c.n404); got != c.want {
			t.Fatalf("n404=%d: got %v want %v", c.n404, got, c.want)
		}
	}
}

// TestReporterRunOnce exercises the full single-shot report flow against a
// fake PostFunc (no real HTTP): first run reports, an unchanged file dedups
// (no POST), a 404 response backs off without marking the snapshot reported
// (so the same content is retried), and a subsequent success resets the
// backoff and marks the snapshot reported.
func TestReporterRunOnce(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	write := func(content string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("port: 7890\nmode: rule\n")

	var okPosts int
	var lastPayload ConfigFilePayload
	okPost := PostFunc(func(_ context.Context, path string, payload interface{}) (bool, error) {
		okPosts++
		cp, ok := payload.(ConfigFilePayload)
		if !ok {
			t.Fatalf("unexpected payload type %T", payload)
		}
		lastPayload = cp
		if path != "/agent/config-file" {
			t.Fatalf("unexpected path %q", path)
		}
		return false, nil
	})

	rep := &Reporter{
		ConfigPath:      p,
		Path:            "/agent/config-file",
		Base:            60 * time.Second,
		BackendID:       3,
		AgentID:         "agent-abc123",
		ProtocolVersion: 1,
		Post:            okPost,
	}

	now := time.Unix(1000, 0)

	// 1) first run always reports.
	delay := rep.RunOnce(context.Background(), now)
	if okPosts != 1 {
		t.Fatalf("want 1 post on first run, got %d", okPosts)
	}
	if delay != rep.Base {
		t.Fatalf("want base delay %v after success, got %v", rep.Base, delay)
	}
	if lastPayload.BackendID != 3 || lastPayload.AgentID != "agent-abc123" || lastPayload.ProtocolVersion != 1 {
		t.Fatalf("envelope fields wrong: %+v", lastPayload)
	}
	if lastPayload.ConfigFile.Hash == "" || lastPayload.ConfigFile.Content == "" || lastPayload.ConfigFile.Size == 0 {
		t.Fatalf("configFile fields missing: %+v", lastPayload.ConfigFile)
	}
	if lastPayload.ConfigFile.Error != "" {
		t.Fatalf("success snapshot must not set error, got %+v", lastPayload.ConfigFile)
	}

	// 2) unchanged file, still within forceAfter: dedup, no new POST.
	delay = rep.RunOnce(context.Background(), now.Add(time.Minute))
	if okPosts != 1 {
		t.Fatalf("want dedup (still 1 post), got %d", okPosts)
	}
	if delay != rep.Base {
		t.Fatalf("delay should stay base while not backing off, got %v", delay)
	}

	// 3) file changes, collector 404s: backoff increments, snapshot NOT
	// marked reported (so the same changed content is retried next tick).
	write("port: 7891\nmode: rule\n")
	var post404 int
	rep.Post = func(_ context.Context, _ string, _ interface{}) (bool, error) {
		post404++
		return true, fmt.Errorf("server http 404: not found")
	}

	delay = rep.RunOnce(context.Background(), now.Add(2*time.Minute))
	if post404 != 1 {
		t.Fatalf("want 1 404 post, got %d", post404)
	}
	if want := NextReportDelay(rep.Base, 1); delay != want {
		t.Fatalf("want backoff delay %v, got %v", want, delay)
	}

	delay = rep.RunOnce(context.Background(), now.Add(3*time.Minute))
	if post404 != 2 {
		t.Fatalf("want retried POST since prior attempt was not marked reported, got %d posts", post404)
	}
	if want := NextReportDelay(rep.Base, 2); delay != want {
		t.Fatalf("want doubled backoff %v, got %v", want, delay)
	}

	// 4) collector recovers: success resets backoff and marks reported.
	rep.Post = okPost
	delay = rep.RunOnce(context.Background(), now.Add(4*time.Minute))
	if okPosts != 2 {
		t.Fatalf("want 2nd ok post, got %d", okPosts)
	}
	if delay != rep.Base {
		t.Fatalf("want base delay after recovery, got %v", delay)
	}

	// 5) unchanged again after recovery: dedup, no new POST.
	delay = rep.RunOnce(context.Background(), now.Add(5*time.Minute))
	if okPosts != 2 {
		t.Fatalf("want dedup after recovery (still 2 posts), got %d", okPosts)
	}
	if delay != rep.Base {
		t.Fatalf("want base delay while deduping, got %v", delay)
	}
}

// TestReporterRunOnceReportsReadError verifies that when the config file
// can't be read, RunOnce still reports — but with the error-snapshot shape
// from the contract ({ path, error }), omitting hash/content/size entirely.
func TestReporterRunOnceReportsReadError(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "nope.yaml")

	var got ConfigFilePayload
	var posts int
	rep := &Reporter{
		ConfigPath:      missing,
		Path:            "/agent/config-file",
		Base:            time.Second,
		BackendID:       1,
		AgentID:         "a",
		ProtocolVersion: 1,
		Post: func(_ context.Context, _ string, payload interface{}) (bool, error) {
			posts++
			got = payload.(ConfigFilePayload)
			return false, nil
		},
	}

	rep.RunOnce(context.Background(), time.Now())
	if posts != 1 {
		t.Fatalf("want 1 post, got %d", posts)
	}
	if got.ConfigFile.Path != missing {
		t.Fatalf("want path echoed, got %q", got.ConfigFile.Path)
	}
	if got.ConfigFile.Error == "" {
		t.Fatal("want error field set for unreadable file")
	}
	if got.ConfigFile.Content != "" || got.ConfigFile.Hash != "" || got.ConfigFile.Size != 0 || got.ConfigFile.ModTimeMs != 0 {
		t.Fatalf("error snapshot must omit content/hash/size/modTimeMs, got %+v", got.ConfigFile)
	}
}
