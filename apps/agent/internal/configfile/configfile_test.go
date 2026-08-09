package configfile

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReadHappyPath(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.yaml")
	content := []byte("port: 7890\nmode: rule\n")
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatal(err)
	}
	s := Read(p)
	if s.Err != "" {
		t.Fatalf("unexpected err: %q", s.Err)
	}
	want := sha256.Sum256(content)
	if s.Hash != hex.EncodeToString(want[:]) {
		t.Fatalf("hash mismatch")
	}
	if s.Size != int64(len(content)) || !bytes.Equal(s.Content, content) {
		t.Fatal("content/size mismatch")
	}
	if s.ModTimeMs <= 0 {
		t.Fatal("modTime not captured")
	}
}

func TestReadMissingFile(t *testing.T) {
	s := Read(filepath.Join(t.TempDir(), "nope.yaml"))
	if !strings.HasPrefix(s.Err, "read-failed") {
		t.Fatalf("want read-failed, got %q", s.Err)
	}
}

func TestReadTooLarge(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "big.yaml")
	if err := os.WriteFile(p, bytes.Repeat([]byte("a"), MaxConfigBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if s := Read(p); s.Err != "too-large" {
		t.Fatalf("want too-large, got %q", s.Err)
	}
}

// TestReadBoundarySizes pins the exact-limit/over-limit boundary that Read's
// two size guards must agree on: the pre-read os.Stat check (fast path, no
// read) and the post-read len(content) check against the LimitReader result
// (defense-in-depth against a file that grows in-place between the fd Stat
// and the read completing). A file of exactly MaxConfigBytes must pass both
// checks; MaxConfigBytes+1 must fail the first one before any read happens.
func TestReadBoundarySizes(t *testing.T) {
	tests := []struct {
		name    string
		size    int
		wantErr string
	}{
		{name: "exactly at limit passes", size: MaxConfigBytes, wantErr: ""},
		{name: "one byte over limit fails", size: MaxConfigBytes + 1, wantErr: "too-large"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "config.yaml")
			content := bytes.Repeat([]byte("a"), tt.size)
			if err := os.WriteFile(p, content, 0o644); err != nil {
				t.Fatal(err)
			}

			s := Read(p)
			if s.Err != tt.wantErr {
				t.Fatalf("Err = %q, want %q", s.Err, tt.wantErr)
			}
			if tt.wantErr == "" {
				if s.Size != int64(tt.size) || len(s.Content) != tt.size {
					t.Fatalf("size/content mismatch: Size=%d len(Content)=%d want %d", s.Size, len(s.Content), tt.size)
				}
			}
		})
	}
}

func TestTrackerReportsOnChangeOnly(t *testing.T) {
	now := time.Unix(1000, 0)
	tr := &Tracker{}
	s1 := Snapshot{Hash: "h1"}
	if !tr.ShouldReport(s1, now, time.Hour) {
		t.Fatal("first snapshot must report")
	}
	tr.MarkReported(s1, now)
	if tr.ShouldReport(s1, now.Add(time.Minute), time.Hour) {
		t.Fatal("unchanged hash must not re-report")
	}
	if !tr.ShouldReport(Snapshot{Hash: "h2"}, now.Add(time.Minute), time.Hour) {
		t.Fatal("changed hash must report")
	}
	// error state change must also report
	if !tr.ShouldReport(Snapshot{Err: "too-large"}, now.Add(2*time.Minute), time.Hour) {
		t.Fatal("error state must report")
	}
	// periodic re-report after forceAfter elapses (self-heals if collector loses its store)
	if !tr.ShouldReport(s1, now.Add(2*time.Hour), time.Hour) {
		t.Fatal("forceAfter must re-report")
	}
}
