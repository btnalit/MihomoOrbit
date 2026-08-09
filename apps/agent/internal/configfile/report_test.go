package configfile

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestNextReportDelayBackoffCurve pins the doubling-with-cap backoff curve:
// each additional consecutive failure (404 or otherwise) doubles the delay
// from base, capped at max(1h, base) so an agent talking to a persistently
// failing collector settles onto a quiet, bounded retry cadence instead of
// hammering it forever — while a base ABOVE 1h is never capped down below
// itself (T3: the 1h ceiling bounds the backoff CURVE, it does not override
// operator intent when there's no backoff in effect, nor shrink the curve
// below the operator's own configured interval).
func TestNextReportDelayBackoffCurve(t *testing.T) {
	base := 60 * time.Second
	cases := []struct {
		name string
		base time.Duration
		n    int
		want time.Duration
	}{
		{"no backoff: returns base unchanged", base, 0, 60 * time.Second},
		{"1 failure: doubles once", base, 1, 2 * time.Minute},
		{"2 failures: doubles twice", base, 2, 4 * time.Minute},
		{"6 failures: reaches the 1h ceiling", base, 6, time.Hour},
		{"10 failures: stays capped at 1h", base, 10, time.Hour},
		{
			"boundary (T3): base above 1h with NO backoff returns base unchanged " +
				"— operator intent wins, the ceiling doesn't apply when n==0",
			90 * time.Minute, 0, 90 * time.Minute,
		},
		{
			"boundary (T3): base above 1h WITH backoff caps the curve at base itself, " +
				"never below it and never at the fixed 1h floor",
			90 * time.Minute, 1, 90 * time.Minute,
		},
		{
			"boundary (T3): base above 1h stays capped at base across more failures too",
			90 * time.Minute, 5, 90 * time.Minute,
		},
	}
	for _, c := range cases {
		if got := NextReportDelay(c.base, c.n); got != c.want {
			t.Fatalf("%s: base=%v n=%d: got %v want %v", c.name, c.base, c.n, got, c.want)
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
		AgentVersion:    "agent-v0.3.0",
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
	if lastPayload.AgentVersion != "agent-v0.3.0" {
		t.Fatalf("want agentVersion carried through the envelope, got %+v", lastPayload)
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

// TestReporterRunOnceBacksOffOnNonPersistentFailure (I3b) pins that a
// non-404 POST failure (a 5xx, a network error, ...) ALSO drives the backoff
// counter, not just 404 — before this fix, a non-404 error reset the
// counter to 0 every time, so a collector that was merely erroring (rather
// than genuinely unrecognizing the endpoint) got hammered at full speed
// forever instead of backing off.
func TestReporterRunOnceBacksOffOnNonPersistentFailure(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(p, []byte("port: 7890\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var posts int
	rep := &Reporter{
		ConfigPath:      p,
		Path:            "/agent/config-file",
		Base:            60 * time.Second,
		BackendID:       1,
		AgentID:         "a",
		ProtocolVersion: 1,
		Post: func(_ context.Context, _ string, _ interface{}) (bool, error) {
			posts++
			// status404=false: a transient 500, not "collector not upgraded".
			return false, fmt.Errorf("server http 500: internal error")
		},
	}

	now := time.Unix(2000, 0)

	delay := rep.RunOnce(context.Background(), now)
	if posts != 1 {
		t.Fatalf("want 1 post, got %d", posts)
	}
	if want := NextReportDelay(rep.Base, 1); delay != want {
		t.Fatalf("want backoff delay %v after 1 non-404 failure, got %v", want, delay)
	}

	// Same (unread-changed) content is retried since nothing was marked
	// reported, and the counter keeps climbing on repeated non-404 failure.
	delay = rep.RunOnce(context.Background(), now.Add(time.Minute))
	if posts != 2 {
		t.Fatalf("want retried POST (snapshot not marked reported), got %d posts", posts)
	}
	if want := NextReportDelay(rep.Base, 2); delay != want {
		t.Fatalf("want doubled backoff delay %v after 2 non-404 failures, got %v", want, delay)
	}

	// Recovery resets the counter back to base delay, same as the 404 case.
	rep.Post = func(_ context.Context, _ string, _ interface{}) (bool, error) {
		posts++
		return false, nil
	}
	delay = rep.RunOnce(context.Background(), now.Add(2*time.Minute))
	if delay != rep.Base {
		t.Fatalf("want base delay after recovery, got %v", delay)
	}
}

// TestReporterRunOnceLogsOnlyFirstFailureAndTransitions (I3c) pins that Logf
// is called on the FIRST failure and on each state transition (fail->ok,
// ok->fail) but never on every tick — repeated failures/successes in the
// same state must not spam the log at the check-interval cadence.
func TestReporterRunOnceLogsOnlyFirstFailureAndTransitions(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(p, []byte("port: 7890\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var logs []string
	failing := true
	rep := &Reporter{
		ConfigPath:      p,
		Path:            "/agent/config-file",
		Base:            time.Second,
		BackendID:       1,
		AgentID:         "a",
		ProtocolVersion: 1,
		Logf: func(format string, args ...interface{}) {
			logs = append(logs, fmt.Sprintf(format, args...))
		},
		Post: func(_ context.Context, _ string, _ interface{}) (bool, error) {
			if failing {
				return false, fmt.Errorf("server http 500: internal error")
			}
			return false, nil
		},
	}

	now := time.Unix(3000, 0)

	// A successful FIRST attempt is not a "transition" (no prior state) and
	// must not log.
	failing = false
	rep.RunOnce(context.Background(), now)
	if len(logs) != 0 {
		t.Fatalf("want no log on initial success, got %v", logs)
	}

	// Force a re-report by advancing past forceAfter isn't needed here since
	// we want a content change to trigger the next attempt deterministically.
	if err := os.WriteFile(p, []byte("port: 7891\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// First failure: must log exactly once.
	failing = true
	rep.RunOnce(context.Background(), now.Add(time.Minute))
	if len(logs) != 1 {
		t.Fatalf("want exactly 1 log on first failure, got %v", logs)
	}

	// Repeated failure (same content, still unreported so it retries): must
	// NOT log again.
	rep.RunOnce(context.Background(), now.Add(2*time.Minute))
	if len(logs) != 1 {
		t.Fatalf("want no additional log on repeated failure, got %v", logs)
	}

	// Recovery: must log exactly once more (fail -> ok transition).
	failing = false
	rep.RunOnce(context.Background(), now.Add(3*time.Minute))
	if len(logs) != 2 {
		t.Fatalf("want exactly 1 additional log on recovery, got %v", logs)
	}

	// Repeated success (unchanged, dedup'd): must not log again.
	rep.RunOnce(context.Background(), now.Add(4*time.Minute))
	if len(logs) != 2 {
		t.Fatalf("want no additional log while deduping after recovery, got %v", logs)
	}
}
