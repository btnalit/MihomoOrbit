package configapply

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeGateway is a table-driven-friendly GatewayAPI fake. Each hook is
// called with the 0-based index of that method's invocation so tests can
// script eventual-consistency behavior.
type fakeGateway struct {
	reloadErr    error
	reloadCalls  int
	reloadPaths  []string
	onReload     func(callIndex int) // side effect hook, e.g. deleting backups

	configsFn    func(callIndex int) (map[string]interface{}, error)
	configsCalls int

	proxiesFn    func(callIndex int) (int, error)
	proxiesCalls int
}

func (f *fakeGateway) PutConfigsReload(ctx context.Context, path string) error {
	idx := f.reloadCalls
	f.reloadCalls++
	f.reloadPaths = append(f.reloadPaths, path)
	if f.onReload != nil {
		f.onReload(idx)
	}
	return f.reloadErr
}

func (f *fakeGateway) GetConfigsJSON(ctx context.Context) (map[string]interface{}, error) {
	idx := f.configsCalls
	f.configsCalls++
	if f.configsFn == nil {
		return map[string]interface{}{}, nil
	}
	return f.configsFn(idx)
}

func (f *fakeGateway) GetProxiesCount(ctx context.Context) (int, error) {
	idx := f.proxiesCalls
	f.proxiesCalls++
	if f.proxiesFn == nil {
		return 1, nil
	}
	return f.proxiesFn(idx)
}

// fakeClock lets tests make the 15s health window elapse instantly:
// healthGate's SleepFn advances the clock instead of blocking.
type fakeClock struct {
	t time.Time
}

func (c *fakeClock) now() time.Time        { return c.t }
func (c *fakeClock) sleep(d time.Duration) { c.t = c.t.Add(d) }

func writeFile(t *testing.T, path string, content []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, content, mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func listBackups(t *testing.T, dir, configName string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var names []string
	prefix := configName + ".bak-"
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), prefix) {
			names = append(names, e.Name())
		}
	}
	return names
}

func newApplier(configPath string, gw GatewayAPI, clock *fakeClock) *Applier {
	return &Applier{
		ConfigPath:   configPath,
		Gateway:      gw,
		NowFn:        clock.now,
		SleepFn:      clock.sleep,
		HealthWindow: 15 * time.Second,
		BackupKeep:   3,
	}
}

// Scenario 1: happy path — all six steps pass, disk == cmd.Content, a
// backup exists, and the original file mode is preserved through the
// temp-file+rename write. Mode preservation is checked against the mode
// actually observed for the original file (via os.Stat) rather than a
// hardcoded 0644: Windows normalizes permission bits to 0666/0444 based
// solely on the read-only attribute, so a literal 0644 round-trip isn't a
// meaningful assertion there, while round-tripping "whatever this OS
// reports" is meaningful on every platform and is exactly what step 3
// (os.Stat before / os.Chmod after) is responsible for. On the Linux
// target, 0644 is preserved bit-for-bit.
func TestApplyHappyPath(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\nmode: rule\n")
	writeFile(t, configPath, original, 0644)

	wantMode, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("stat original: %v", err)
	}

	gw := &fakeGateway{
		configsFn: func(int) (map[string]interface{}, error) {
			return map[string]interface{}{"port": 8080.0, "mode": "rule"}, nil
		},
		proxiesFn: func(int) (int, error) { return 3, nil },
	}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)

	cmd := Command{
		CommandID: "cmd-1",
		BaseHash:  sha256Hex(original),
		Content:   "port: 8080\nmode: rule\n",
		Verify:    map[string]interface{}{"port": 8080, "mode": "rule"},
	}

	res := applier.Apply(context.Background(), cmd)

	if res.Result != StatusApplied {
		t.Fatalf("expected applied, got %+v", res)
	}
	if res.CommandID != cmd.CommandID {
		t.Fatalf("expected commandId echoed, got %q", res.CommandID)
	}

	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != cmd.Content {
		t.Fatalf("expected disk content %q, got %q", cmd.Content, string(got))
	}

	gotInfo, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("stat after apply: %v", err)
	}
	if gotInfo.Mode() != wantMode.Mode() {
		t.Fatalf("expected mode %v preserved, got %v", wantMode.Mode(), gotInfo.Mode())
	}

	backups := listBackups(t, dir, "config.yaml")
	if len(backups) != 1 {
		t.Fatalf("expected 1 backup, got %v", backups)
	}
	backupContent, err := os.ReadFile(filepath.Join(dir, backups[0]))
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if string(backupContent) != string(original) {
		t.Fatalf("expected backup to hold original content, got %q", string(backupContent))
	}

	if gw.reloadCalls != 1 {
		t.Fatalf("expected 1 reload call, got %d", gw.reloadCalls)
	}
}

// Scenario 2: baseHash mismatch → conflict, disk untouched, no backup.
func TestApplyBaseHashConflict(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\nmode: rule\n")
	writeFile(t, configPath, original, 0644)

	gw := &fakeGateway{}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)

	cmd := Command{
		CommandID: "cmd-2",
		BaseHash:  "0000000000000000000000000000000000000000000000000000000000000000",
		Content:   "port: 9999\n",
		Verify:    map[string]interface{}{"port": 9999},
	}

	res := applier.Apply(context.Background(), cmd)

	if res.Result != StatusConflict {
		t.Fatalf("expected conflict, got %+v", res)
	}

	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("expected disk untouched, got %q", string(got))
	}

	if backups := listBackups(t, dir, "config.yaml"); len(backups) != 0 {
		t.Fatalf("expected no backups, got %v", backups)
	}
	if gw.reloadCalls != 0 || gw.configsCalls != 0 {
		t.Fatalf("expected no gateway calls, got reload=%d configs=%d", gw.reloadCalls, gw.configsCalls)
	}
}

// Scenario 3: reload returns non-2xx → restore from backup + a second
// reload call → rolled-back, disk restored to the original content.
func TestApplyReloadFailureRollsBack(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\nmode: rule\n")
	writeFile(t, configPath, original, 0644)

	gw := &fakeGateway{reloadErr: errors.New("mihomo: 400 bad path")}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)

	cmd := Command{
		CommandID: "cmd-3",
		BaseHash:  sha256Hex(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}

	res := applier.Apply(context.Background(), cmd)

	if res.Result != StatusRolledBack {
		t.Fatalf("expected rolled-back, got %+v", res)
	}
	if gw.reloadCalls != 2 {
		t.Fatalf("expected reload called twice (initial + restore re-reload), got %d", gw.reloadCalls)
	}

	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("expected disk restored to original, got %q", string(got))
	}
}

// Scenario 4a: verify keys are eventually consistent (match on the Nth
// GetConfigsJSON call) → the poll succeeds within the window → applied.
func TestApplyVerifyEventuallyConsistentApplies(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	writeFile(t, configPath, original, 0644)

	const matchOnCall = 3 // 0,1,2 mismatch; call index 3 matches
	gw := &fakeGateway{
		configsFn: func(idx int) (map[string]interface{}, error) {
			if idx < matchOnCall {
				return map[string]interface{}{"port": 7890.0}, nil // stale/old value
			}
			return map[string]interface{}{"port": 8080.0}, nil
		},
		proxiesFn: func(int) (int, error) { return 2, nil },
	}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)

	cmd := Command{
		CommandID: "cmd-4a",
		BaseHash:  sha256Hex(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}

	res := applier.Apply(context.Background(), cmd)

	if res.Result != StatusApplied {
		t.Fatalf("expected applied after eventual consistency, got %+v", res)
	}
	if gw.configsCalls != matchOnCall+1 {
		t.Fatalf("expected %d GetConfigsJSON calls, got %d", matchOnCall+1, gw.configsCalls)
	}
}

// Scenario 4b: verify keys never become consistent → the poll exhausts the
// health window → rolled-back.
func TestApplyVerifyNeverConsistentRollsBack(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	writeFile(t, configPath, original, 0644)

	gw := &fakeGateway{
		configsFn: func(int) (map[string]interface{}, error) {
			return map[string]interface{}{"port": 7890.0}, nil // never updates
		},
		proxiesFn: func(int) (int, error) { return 2, nil },
	}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)
	applier.HealthWindow = 15 * time.Second

	cmd := Command{
		CommandID: "cmd-4b",
		BaseHash:  sha256Hex(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}

	res := applier.Apply(context.Background(), cmd)

	if res.Result != StatusRolledBack {
		t.Fatalf("expected rolled-back after timeout, got %+v", res)
	}
	if !strings.Contains(res.Reason, "health-check-timeout") {
		t.Fatalf("expected timeout reason, got %q", res.Reason)
	}
	if gw.configsCalls < 14 || gw.configsCalls > 17 {
		t.Fatalf("expected roughly window/interval polls, got %d", gw.configsCalls)
	}

	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("expected disk restored to original, got %q", string(got))
	}
}

// Scenario 5: verify matches immediately but GetProxiesCount is always 0 →
// the health gate never succeeds → rolled-back.
func TestApplyEmptyProxiesRollsBack(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	writeFile(t, configPath, original, 0644)

	gw := &fakeGateway{
		configsFn: func(int) (map[string]interface{}, error) {
			return map[string]interface{}{"port": 8080.0}, nil
		},
		proxiesFn: func(int) (int, error) { return 0, nil },
	}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)

	cmd := Command{
		CommandID: "cmd-5",
		BaseHash:  sha256Hex(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}

	res := applier.Apply(context.Background(), cmd)

	if res.Result != StatusRolledBack {
		t.Fatalf("expected rolled-back when proxies count is 0, got %+v", res)
	}

	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("expected disk restored to original, got %q", string(got))
	}
}

// Scenario 6: backup retention — 5 consecutive successful applies leave
// exactly BackupKeep(=3) backup files, holding the newest 3 pre-apply
// contents. NowFn is pinned to a fixed instant (no advancement) so every
// backup created in this test shares the same millisecond, which forces
// the assertion to actually exercise the ms+seq tie-break rather than
// incidentally passing because clock ticks already made names unique.
func TestApplyBackupRetentionKeepsNewestThree(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 0\n")
	writeFile(t, configPath, original, 0644)

	gw := &fakeGateway{
		configsFn: func(int) (map[string]interface{}, error) {
			return map[string]interface{}{}, nil // no verify keys required below
		},
		proxiesFn: func(int) (int, error) { return 1, nil },
	}
	fixed := time.Now()
	clock := &fakeClock{t: fixed}
	applier := newApplier(configPath, gw, clock)

	beforeContents := []string{string(original)}
	current := original
	for i := 1; i <= 5; i++ {
		baseHash := sha256Hex(current)
		next := []byte(fmt.Sprintf("port: %d\n", 8000+i))
		cmd := Command{
			CommandID: fmt.Sprintf("cmd-6-%d", i),
			BaseHash:  baseHash,
			Content:   string(next),
			Verify:    map[string]interface{}{},
		}
		res := applier.Apply(context.Background(), cmd)
		if res.Result != StatusApplied {
			t.Fatalf("apply %d: expected applied, got %+v", i, res)
		}
		if i < 5 {
			beforeContents = append(beforeContents, string(next))
		}
		current = next
	}

	backups := listBackups(t, dir, "config.yaml")
	if len(backups) != 3 {
		t.Fatalf("expected exactly 3 backups, got %v", backups)
	}

	// The 5 applies captured beforeContents[0..4] as backups (original +
	// the 4 intermediate contents); the newest 3 are the last 3 entries.
	wantSurvivors := map[string]bool{}
	for _, c := range beforeContents[len(beforeContents)-3:] {
		wantSurvivors[c] = true
	}
	gotSurvivors := map[string]bool{}
	for _, name := range backups {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read backup %s: %v", name, err)
		}
		gotSurvivors[string(data)] = true
	}
	for c := range wantSurvivors {
		if !gotSurvivors[c] {
			t.Fatalf("expected surviving backup content %q, survivors=%v", c, gotSurvivors)
		}
	}
}

// Scenario 7 (Apply half): redelivery of the same commandId returns the
// previously recorded Result without touching disk or the gateway again.
func TestApplyIdempotentReplay(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	writeFile(t, configPath, original, 0644)

	gw := &fakeGateway{
		configsFn: func(int) (map[string]interface{}, error) {
			return map[string]interface{}{"port": 8080.0}, nil
		},
		proxiesFn: func(int) (int, error) { return 1, nil },
	}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)

	cmd := Command{
		CommandID: "cmd-7",
		BaseHash:  sha256Hex(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}

	first := applier.Apply(context.Background(), cmd)
	if first.Result != StatusApplied {
		t.Fatalf("expected first apply to succeed, got %+v", first)
	}
	if gw.reloadCalls != 1 {
		t.Fatalf("expected 1 reload after first apply, got %d", gw.reloadCalls)
	}

	afterFirst, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config after first apply: %v", err)
	}
	backupsAfterFirst := listBackups(t, dir, "config.yaml")

	second := applier.Apply(context.Background(), cmd)
	if second != first {
		t.Fatalf("expected replay to return identical Result, first=%+v second=%+v", first, second)
	}
	if gw.reloadCalls != 1 {
		t.Fatalf("expected no additional reload on replay, got %d", gw.reloadCalls)
	}

	afterSecond, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config after replay: %v", err)
	}
	if string(afterSecond) != string(afterFirst) {
		t.Fatalf("expected disk untouched by replay")
	}
	if backupsAfterSecond := listBackups(t, dir, "config.yaml"); len(backupsAfterSecond) != len(backupsAfterFirst) {
		t.Fatalf("expected no additional backup on replay, before=%v after=%v", backupsAfterFirst, backupsAfterSecond)
	}
}

// Scenario 8: restore failure (backup file deleted out from under us,
// simulated via the fake gateway deleting it as a side effect of the
// failing reload call) → rolled-back with a reason containing
// "restore-failed", and only the initial reload call happens (the
// restore-triggered re-reload is skipped since restore itself failed).
func TestApplyRestoreFailureReportsReason(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("port: 7890\n")
	writeFile(t, configPath, original, 0644)

	gw := &fakeGateway{
		reloadErr: errors.New("mihomo: 500 internal error"),
		onReload: func(int) {
			matches := listBackups(t, dir, "config.yaml")
			for _, name := range matches {
				_ = os.Remove(filepath.Join(dir, name))
			}
		},
	}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)

	cmd := Command{
		CommandID: "cmd-8",
		BaseHash:  sha256Hex(original),
		Content:   "port: 8080\n",
		Verify:    map[string]interface{}{"port": 8080},
	}

	res := applier.Apply(context.Background(), cmd)

	if res.Result != StatusRolledBack {
		t.Fatalf("expected rolled-back, got %+v", res)
	}
	if !strings.Contains(res.Reason, "restore-failed") {
		t.Fatalf("expected reason to contain restore-failed, got %q", res.Reason)
	}
	if gw.reloadCalls != 1 {
		t.Fatalf("expected only the initial reload call (restore failed before the re-reload), got %d", gw.reloadCalls)
	}

	// Disk can't be reverted since the backup is gone — the new content is
	// what's left, matching the plan's stated trade-off (self-lock field ban
	// keeps the admin API channel usable regardless of this outcome).
	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(got) != cmd.Content {
		t.Fatalf("expected new content left on disk after failed restore, got %q", string(got))
	}
}

// Scenario 9: a failed os.Rename inside atomicWrite never leaves a temp
// file behind. Renaming a regular file over an existing directory fails on
// both Windows (MoveFileEx) and Unix (EISDIR), making this portable.
func TestAtomicWriteCleansUpTempFileOnRenameFailure(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "config.yaml")
	if err := os.Mkdir(target, 0755); err != nil {
		t.Fatalf("mkdir target: %v", err)
	}

	err := atomicWrite(target, []byte("content"), 0644)
	if err == nil {
		t.Fatal("expected atomicWrite to fail when target is a directory")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("expected no leftover temp file, found %q", e.Name())
		}
	}
}

// I2 (M2b final review): looseEqual must compare a string-vs-string pair
// case-insensitively (mirrors the collector's own lowercasing of
// mode/log-level at verify-extraction time) while leaving every other
// comparison shape untouched.
func TestLooseEqualCaseInsensitiveStrings(t *testing.T) {
	cases := []struct {
		name string
		a, b interface{}
		want bool
	}{
		{"exact match", "rule", "rule", true},
		{"case-only difference, expected upper", "Rule", "rule", true},
		{"case-only difference, actual upper", "rule", "RULE", true},
		{"different values entirely", "rule", "direct", false},
		{"numeric still compares as float64, not string", 7890, 7890.0, true},
		{"numeric mismatch", 7890, 7891.0, false},
		// `a` is a string but `b` is not, so the new string-vs-string branch
		// doesn't apply (its own `bok` check fails) — falls through to the
		// pre-existing %v-formatted comparison, unchanged by this fix ("7890"
		// vs float64 7890.0 both format to "7890", so this was already true
		// before I2 and stays true after — pinned here as a no-regression
		// check, not a new case-insensitivity assertion).
		{"string vs number falls back to pre-existing formatted compare (unchanged by this fix)", "7890", 7890.0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := looseEqual(c.a, c.b)
			if got != c.want {
				t.Fatalf("looseEqual(%#v, %#v) = %v, want %v", c.a, c.b, got, c.want)
			}
		})
	}
}

// I2 end-to-end: a `mode: Rule` verify expectation (as the collector would
// send it, pre-lowercasing-fix) must still health-gate-pass against
// mihomo's own lower-case `"rule"` report — pins the agent-side half of the
// case-insensitivity fix at the Apply() level, not just the looseEqual unit.
func TestApplyVerifyCaseInsensitiveModeMatches(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	original := []byte("mode: rule\n")
	writeFile(t, configPath, original, 0644)

	gw := &fakeGateway{
		configsFn: func(int) (map[string]interface{}, error) {
			return map[string]interface{}{"mode": "rule"}, nil // mihomo's own lower-case report
		},
		proxiesFn: func(int) (int, error) { return 2, nil },
	}
	clock := &fakeClock{t: time.Now()}
	applier := newApplier(configPath, gw, clock)

	cmd := Command{
		CommandID: "cmd-i2",
		BaseHash:  sha256Hex(original),
		Content:   "mode: Rule\n",
		Verify:    map[string]interface{}{"mode": "Rule"}, // collector's verify, unlowercased on purpose
	}

	res := applier.Apply(context.Background(), cmd)

	if res.Result != StatusApplied {
		t.Fatalf("expected applied (case-insensitive verify match), got %+v", res)
	}
}
