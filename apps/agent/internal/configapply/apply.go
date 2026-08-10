// Package configapply implements the agent's six-step atomic config
// write-back with a triple health gate (plan §5.3). It is a pure package:
// stdlib only, no dependency on internal/agent or internal/config, so it
// stays natively testable on any platform including Windows. The gateway
// dependency is expressed as the GatewayAPI interface below, which
// gateway.Client satisfies; tests use a fake.
package configapply

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Command is a config apply instruction, already decoded from the
// collector's heartbeat response (Task 3 converts the wire commandPayload
// into this).
type Command struct {
	CommandID  string
	BaseHash   string
	Content    string
	Verify     map[string]interface{}
	IssuedAtMs int64
}

// Result is the terminal outcome of an Apply call, reported back via the
// next heartbeat's commandResults (Task 3 converts this into the wire
// commandResult). JSON tags mirror the wire commandResult shape from Task 1.
type Result struct {
	CommandID     string `json:"commandId"`
	Result        string `json:"result"` // applied|conflict|rolled-back|failed
	Reason        string `json:"reason"`
	CompletedAtMs int64  `json:"completedAtMs"`
}

// Result status values.
const (
	StatusApplied    = "applied"
	StatusConflict   = "conflict"
	StatusRolledBack = "rolled-back"
	StatusFailed     = "failed"
)

// GatewayAPI is the subset of gateway.Client used by the six-step
// write-back. gateway.Client satisfies it; tests use a fake.
type GatewayAPI interface {
	PutConfigsReload(ctx context.Context, path string) error
	GetConfigsJSON(ctx context.Context) (map[string]interface{}, error)
	GetProxiesCount(ctx context.Context) (int, error)
}

// Applier performs the six-step atomic config write-back with a triple
// health gate.
type Applier struct {
	ConfigPath string
	Gateway    GatewayAPI

	NowFn   func() time.Time    // test injection; defaults to time.Now
	SleepFn func(time.Duration) // health-gate poll wait; defaults to time.Sleep

	HealthWindow time.Duration // default 15s
	BackupKeep   int           // default 3
}

const (
	stateFileName       = "orbit-agent-state.json"
	healthPollInterval  = time.Second
	defaultHealthWindow = 15 * time.Second
	defaultBackupKeep   = 3
)

// backupSeq disambiguates backup file names created within the same
// millisecond (see plan: "毫秒+计数命名不同名"). Package-level and
// monotonic for the process lifetime — the exact starting value across
// restarts is irrelevant since uniqueness only needs to hold among backups
// alive on disk at once, and the millisecond component already
// distinguishes across restarts in practice.
var backupSeq int64

func (a *Applier) now() time.Time {
	if a.NowFn != nil {
		return a.NowFn()
	}
	return time.Now()
}

func (a *Applier) sleep(d time.Duration) {
	if a.SleepFn != nil {
		a.SleepFn(d)
		return
	}
	time.Sleep(d)
}

func (a *Applier) healthWindow() time.Duration {
	if a.HealthWindow > 0 {
		return a.HealthWindow
	}
	return defaultHealthWindow
}

func (a *Applier) backupKeep() int {
	if a.BackupKeep > 0 {
		return a.BackupKeep
	}
	return defaultBackupKeep
}

// Apply executes the six-step atomic write-back for cmd and returns its
// terminal Result. Commands are dispatched at-least-once (each heartbeat
// re-sends any pending/dispatched command until it terminates), so
// redelivery of a commandId already recorded as the last-processed one is
// answered from persisted state without touching the config file or
// contacting the gateway again.
func (a *Applier) Apply(ctx context.Context, cmd Command) Result {
	dir := filepath.Dir(a.ConfigPath)
	st := LoadState(dir)

	if st.LastAppliedCommandID == cmd.CommandID {
		if r, ok := findResult(st.PendingResults, cmd.CommandID); ok {
			return r
		}
	}

	result := a.applySixSteps(ctx, cmd)

	st.LastAppliedCommandID = cmd.CommandID
	st.PendingResults = append(st.PendingResults, result)
	_ = SaveState(dir, st) // best-effort: loss only affects redelivery dedup / receipt staging, not the write-back itself

	return result
}

func findResult(results []Result, commandID string) (Result, bool) {
	for i := len(results) - 1; i >= 0; i-- {
		if results[i].CommandID == commandID {
			return results[i], true
		}
	}
	return Result{}, false
}

func (a *Applier) applySixSteps(ctx context.Context, cmd Command) Result {
	finish := func(status, reason string) Result {
		return Result{
			CommandID:     cmd.CommandID,
			Result:        status,
			Reason:        reason,
			CompletedAtMs: a.now().UnixMilli(),
		}
	}

	// Step 1: baseHash conflict check. Disk stays untouched, no backup, on
	// any mismatch or read failure.
	original, err := os.ReadFile(a.ConfigPath)
	if err != nil {
		return finish(StatusFailed, fmt.Sprintf("read config: %v", err))
	}
	if sha256Hex(original) != cmd.BaseHash {
		return finish(StatusConflict, "base-hash-mismatch")
	}

	info, err := os.Stat(a.ConfigPath)
	if err != nil {
		return finish(StatusFailed, fmt.Sprintf("stat config: %v", err))
	}
	mode := info.Mode()

	// Step 2: backup, then prune to the newest BackupKeep.
	backupPath, err := a.createBackup(original, mode)
	if err != nil {
		return finish(StatusFailed, fmt.Sprintf("backup: %v", err))
	}
	a.pruneBackups()

	// Step 3: atomic write of new content, same directory, preserving mode.
	if err := atomicWrite(a.ConfigPath, []byte(cmd.Content), mode); err != nil {
		return finish(StatusFailed, fmt.Sprintf("write config: %v", err))
	}

	absPath, err := filepath.Abs(a.ConfigPath)
	if err != nil {
		absPath = a.ConfigPath
	}

	// Step 4: trigger reload.
	ok := false
	reason := ""
	if reloadErr := a.Gateway.PutConfigsReload(ctx, absPath); reloadErr != nil {
		reason = fmt.Sprintf("reload-failed: %v", reloadErr)
	} else {
		// Step 5: triple health gate — (a) reload 2xx already satisfied above,
		// (b) GET /configs verify subset loose match, (c) proxies non-empty.
		ok, reason = a.healthGate(ctx, cmd)
	}

	if ok {
		return finish(StatusApplied, "")
	}

	// Step 6: rollback — restore backup, re-reload, report rolled-back.
	// A restore failure still reports rolled-back (self-lock field ban
	// guarantees the admin API channel is unaffected either way) but the
	// reason must say so.
	if restoreErr := a.restore(backupPath, mode); restoreErr != nil {
		return finish(StatusRolledBack, fmt.Sprintf("%s (trigger: %s)", restoreErr.Error(), reason))
	}
	_ = a.Gateway.PutConfigsReload(ctx, absPath) // best-effort re-reload of the restored content
	return finish(StatusRolledBack, reason)
}

// healthGate polls GET /configs + GET /proxies until both verify keys match
// (loose numeric compare) and the proxies count is non-zero, or the window
// elapses.
func (a *Applier) healthGate(ctx context.Context, cmd Command) (bool, string) {
	window := a.healthWindow()
	start := a.now()
	lastErr := ""

	for {
		cfg, err := a.Gateway.GetConfigsJSON(ctx)
		switch {
		case err != nil:
			lastErr = fmt.Sprintf("get configs: %v", err)
		case !verifyMatches(cfg, cmd.Verify):
			lastErr = "verify-mismatch"
		default:
			count, cerr := a.Gateway.GetProxiesCount(ctx)
			switch {
			case cerr != nil:
				lastErr = fmt.Sprintf("get proxies count: %v", cerr)
			case count <= 0:
				lastErr = "proxies-empty"
			default:
				return true, ""
			}
		}

		if !a.now().Before(start.Add(window)) {
			return false, "health-check-timeout: " + lastErr
		}
		a.sleep(healthPollInterval)
	}
}

// verifyMatches reports whether every key in want is present in actual with
// a loosely-equal value (numeric values compared as float64).
func verifyMatches(actual, want map[string]interface{}) bool {
	for k, wantVal := range want {
		gotVal, ok := actual[k]
		if !ok || !looseEqual(wantVal, gotVal) {
			return false
		}
	}
	return true
}

func looseEqual(a, b interface{}) bool {
	if af, aok := toFloat64(a); aok {
		if bf, bok := toFloat64(b); bok {
			return af == bf
		}
		return false
	}
	return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b)
}

func toFloat64(v interface{}) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

// createBackup writes original as a new, uniquely-named backup file
// (config.yaml.bak-<ms>-<seq>) in the same directory, preserving mode.
func (a *Applier) createBackup(content []byte, mode os.FileMode) (string, error) {
	dir := filepath.Dir(a.ConfigPath)
	base := filepath.Base(a.ConfigPath)
	ms := a.now().UnixMilli()
	seq := atomic.AddInt64(&backupSeq, 1)
	path := filepath.Join(dir, fmt.Sprintf("%s.bak-%d-%d", base, ms, seq))
	if err := atomicWrite(path, content, mode); err != nil {
		return "", err
	}
	return path, nil
}

type backupFile struct {
	name string
	ms   int64
	seq  int64
}

// pruneBackups keeps only the newest BackupKeep backups (by ms, then seq)
// for a.ConfigPath's basename, deleting the rest.
func (a *Applier) pruneBackups() {
	dir := filepath.Dir(a.ConfigPath)
	base := filepath.Base(a.ConfigPath)
	prefix := base + ".bak-"

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}

	var backups []backupFile
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		ms, seq, ok := parseBackupSuffix(name[len(prefix):])
		if !ok {
			continue
		}
		backups = append(backups, backupFile{name: name, ms: ms, seq: seq})
	}

	keep := a.backupKeep()
	if len(backups) <= keep {
		return
	}

	sort.Slice(backups, func(i, j int) bool {
		if backups[i].ms != backups[j].ms {
			return backups[i].ms > backups[j].ms
		}
		return backups[i].seq > backups[j].seq
	})

	for _, b := range backups[keep:] {
		_ = os.Remove(filepath.Join(dir, b.name))
	}
}

func parseBackupSuffix(suffix string) (ms int64, seq int64, ok bool) {
	parts := strings.SplitN(suffix, "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	msVal, err1 := strconv.ParseInt(parts[0], 10, 64)
	seqVal, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return msVal, seqVal, true
}

// restore overwrites a.ConfigPath with the backup's content. Errors are
// wrapped so the caller's reason string always contains "restore-failed".
func (a *Applier) restore(backupPath string, mode os.FileMode) error {
	data, err := os.ReadFile(backupPath)
	if err != nil {
		return fmt.Errorf("restore-failed: read backup: %w", err)
	}
	if err := atomicWrite(a.ConfigPath, data, mode); err != nil {
		return fmt.Errorf("restore-failed: write restored config: %w", err)
	}
	return nil
}

// atomicWrite writes content to a temp file in target's directory, sets its
// mode, and renames it over target. The temp file is removed on any failure
// so a failed rename never leaves debris behind (scenario 9).
func atomicWrite(target string, content []byte, mode os.FileMode) error {
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, filepath.Base(target)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Chmod(tmpPath, mode); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, target); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
