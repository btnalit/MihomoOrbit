// Package configfile reads the gateway's config.yaml from local disk, hashes
// it, and tracks whether a freshly read snapshot is worth reporting upstream.
// It is pure stdlib and does zero YAML parsing — the agent treats config
// content as an opaque byte blob for the collector/master to interpret.
package configfile

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"time"
)

// MaxConfigBytes caps how large a config file the agent will hold in memory.
// MIPS routers are memory-constrained, so Read stats the open file descriptor
// before reading it, rather than reading first and discarding an oversized
// result.
const MaxConfigBytes = 256 * 1024

// Snapshot is the result of one Read call. When Err is non-empty, Content
// and Hash are zero values — callers must check Err before trusting them.
type Snapshot struct {
	Path      string
	Hash      string // sha256 hex
	Content   []byte
	Size      int64
	ModTimeMs int64
	Err       string // "" | "too-large" | "read-failed: <detail>"
}

// Read reads path and returns a snapshot. If the file is oversized or
// unreadable, it returns a Snapshot with Err set instead of a Go error, so
// callers can report the error state upstream the same way they report a
// successful read.
//
// The file is opened once and both the size/mtime check and the content read
// go through that same descriptor. Stat-then-ReadFile (two separate calls
// against the path) would leave a TOCTOU window: config.yaml is routinely
// replaced via temp-file+rename (M2b's own write-back, editors, scp) between
// the two calls, so a path-based Stat can pass on the old, small file while
// a path-based ReadFile reads the new, possibly-oversized one in full. A
// single open pins the descriptor to one inode for the whole call, so a
// rename-over after Open cannot affect what gets read. As defense-in-depth
// against in-place growth (e.g. an appending writer to the same inode
// between the fd Stat and the read), the read itself is bounded by a
// LimitReader and re-checked after the fact.
func Read(path string) Snapshot {
	f, err := os.Open(path)
	if err != nil {
		return Snapshot{Path: path, Err: fmt.Sprintf("read-failed: %v", err)}
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return Snapshot{Path: path, Err: fmt.Sprintf("read-failed: %v", err)}
	}
	if info.Size() > MaxConfigBytes {
		return Snapshot{Path: path, Err: "too-large"}
	}

	content, err := io.ReadAll(io.LimitReader(f, MaxConfigBytes+1))
	if err != nil {
		return Snapshot{Path: path, Err: fmt.Sprintf("read-failed: %v", err)}
	}
	if len(content) > MaxConfigBytes {
		return Snapshot{Path: path, Err: "too-large"}
	}

	sum := sha256.Sum256(content)
	return Snapshot{
		Path:      path,
		Hash:      hex.EncodeToString(sum[:]),
		Content:   content,
		Size:      int64(len(content)),
		ModTimeMs: info.ModTime().UnixMilli(),
	}
}

// Tracker remembers the last snapshot reported upstream so the caller can
// avoid re-reporting an unchanged config on every poll.
type Tracker struct {
	lastHash       string
	lastErr        string
	lastReportedAt time.Time
}

// ShouldReport reports true when s differs from the last reported snapshot
// (by hash or error state), or when forceAfter has elapsed since the last
// report — the latter lets a collector that lost its store (e.g. reinstall)
// recover state without waiting for the config to actually change.
func (t *Tracker) ShouldReport(s Snapshot, now time.Time, forceAfter time.Duration) bool {
	if t.lastReportedAt.IsZero() {
		return true
	}
	if s.Hash != t.lastHash || s.Err != t.lastErr {
		return true
	}
	return now.Sub(t.lastReportedAt) >= forceAfter
}

// MarkReported records s as the last snapshot successfully reported at now.
func (t *Tracker) MarkReported(s Snapshot, now time.Time) {
	t.lastHash = s.Hash
	t.lastErr = s.Err
	t.lastReportedAt = now
}
