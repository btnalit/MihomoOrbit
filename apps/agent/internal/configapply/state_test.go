package configapply

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Scenario 7 (State half): SaveState/LoadState round trip.
func TestSaveLoadStateRoundTrip(t *testing.T) {
	dir := t.TempDir()

	want := State{
		LastAppliedCommandID: "cmd-abc123",
		PendingResults: []Result{
			{CommandID: "cmd-abc122", Result: StatusApplied, Reason: "", CompletedAtMs: 1000},
			{CommandID: "cmd-abc123", Result: StatusRolledBack, Reason: "health-check-timeout", CompletedAtMs: 2000},
		},
	}

	if err := SaveState(dir, want); err != nil {
		t.Fatalf("SaveState: %v", err)
	}

	got := LoadState(dir)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip mismatch:\n got=%+v\nwant=%+v", got, want)
	}
}

// LoadState on a directory with no state file yet must return zero-value
// State (bootstrap case), not an error or panic.
func TestLoadStateMissingFileReturnsZeroValue(t *testing.T) {
	dir := t.TempDir()

	got := LoadState(dir)
	if got.LastAppliedCommandID != "" || len(got.PendingResults) != 0 {
		t.Fatalf("expected zero-value State, got %+v", got)
	}
}

// A corrupt state file is also treated as bootstrap/empty rather than
// propagating a decode error — this is best-effort bookkeeping, not the
// source of truth for the config file itself.
func TestLoadStateCorruptFileReturnsZeroValue(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "orbit-agent-state.json"), []byte("{not json"), 0644); err != nil {
		t.Fatalf("write corrupt state: %v", err)
	}

	got := LoadState(dir)
	if got.LastAppliedCommandID != "" || len(got.PendingResults) != 0 {
		t.Fatalf("expected zero-value State on corrupt file, got %+v", got)
	}
}

// SaveState writes via temp file + rename: no leftover temp file, and the
// state file itself lands with the expected name in dir.
func TestSaveStateWritesAtomically(t *testing.T) {
	dir := t.TempDir()

	if err := SaveState(dir, State{LastAppliedCommandID: "cmd-x"}); err != nil {
		t.Fatalf("SaveState: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	foundStateFile := false
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("expected no leftover temp file, found %q", e.Name())
		}
		if e.Name() == "orbit-agent-state.json" {
			foundStateFile = true
		}
	}
	if !foundStateFile {
		t.Fatal("expected orbit-agent-state.json to exist")
	}
}
