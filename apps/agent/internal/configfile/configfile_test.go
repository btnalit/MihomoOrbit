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

// TestReadRejectsNonUTF8 pins the invariant that Read never returns a
// successful Snapshot whose Content isn't valid UTF-8: the wire payload
// carries Content as a JSON string, and json.Marshal silently substitutes
// invalid byte sequences with U+FFFD — which would desync the reported hash
// (computed over the true raw bytes) from what actually reaches the
// collector, with no error anywhere. A non-UTF-8 file must instead route
// through the same error-report path as "too-large"/"read-failed" (Err set,
// Content/Hash left zero).
func TestReadRejectsNonUTF8(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
		wantErr string
	}{
		{
			name:    "invalid byte sequence rejected",
			content: []byte{0xff, 0xfe, 'a'},
			wantErr: "not-utf8",
		},
		{
			name:    "valid multibyte UTF-8 passes",
			content: []byte("port: 7890\n# 中文注释\n"),
			wantErr: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "config.yaml")
			if err := os.WriteFile(p, tt.content, 0o644); err != nil {
				t.Fatal(err)
			}

			s := Read(p)
			if s.Err != tt.wantErr {
				t.Fatalf("Err = %q, want %q", s.Err, tt.wantErr)
			}
			if tt.wantErr == "" {
				want := sha256.Sum256(tt.content)
				if s.Hash != hex.EncodeToString(want[:]) {
					t.Fatal("hash mismatch for valid UTF-8 content")
				}
				if !bytes.Equal(s.Content, tt.content) {
					t.Fatal("content mismatch for valid UTF-8 content")
				}
			} else {
				if s.Content != nil || s.Hash != "" {
					t.Fatalf("non-utf8 snapshot must not carry Content/Hash, got Content=%q Hash=%q", s.Content, s.Hash)
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
