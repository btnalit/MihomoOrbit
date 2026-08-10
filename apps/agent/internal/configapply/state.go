package configapply

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// State is the agent's config-apply bookkeeping, persisted as
// orbit-agent-state.json in the config file's own directory so it survives
// process restarts. LastAppliedCommandID dedupes command redelivery (see
// Applier.Apply); PendingResults stages terminal results not yet delivered
// to the collector (Task 3 clears entries once a heartbeat's commandResults
// round-trip a 2xx).
type State struct {
	LastAppliedCommandID string   `json:"lastAppliedCommandId"`
	PendingResults       []Result `json:"pendingResults"`
}

// LoadState reads orbit-agent-state.json from dir. A missing or corrupt
// file is treated as empty state — this is bootstrap/best-effort
// bookkeeping, not a source of truth for the config file itself.
func LoadState(dir string) State {
	data, err := os.ReadFile(filepath.Join(dir, stateFileName))
	if err != nil {
		return State{}
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return State{}
	}
	return s
}

// SaveState writes s to orbit-agent-state.json in dir via temp file + rename
// so a crash mid-write never leaves a corrupt state file.
func SaveState(dir string, s State) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, stateFileName), data, 0o644)
}
