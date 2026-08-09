package configfile

import (
	"context"
	"time"
)

// ForceReportAfter is the ceiling on how long a Reporter can go without
// re-sending an unchanged config file. It's passed as Tracker.ShouldReport's
// forceAfter so a collector that lost its store (reinstall, disk wipe) can
// recover state without waiting for config.yaml to actually change.
const ForceReportAfter = time.Hour

// maxReportDelay is the floor for the backoff curve's ceiling. Once a
// collector is persistently failing (unrecognized config-file endpoint,
// 5xx, network error, ...), retries settle onto this quiet, bounded cadence
// instead of climbing forever — see NextReportDelay for how it combines with
// base.
const maxReportDelay = time.Hour

// NextReportDelay computes the delay before the next report attempt given
// consecutiveFailures consecutive failed report attempts (of any kind — 404,
// other HTTP status, network error; see Reporter.RunOnce).
//
// The 1h ceiling applies to the BACKOFF CURVE only, not to the operator's
// configured base interval:
//   - consecutiveFailures <= 0 (no backoff in effect): returns base
//     unchanged, even if base > 1h. An operator who explicitly configured a
//     longer check interval gets exactly that interval back — the ceiling
//     exists to bound how far failures can push the delay, not to second-
//     guess a deliberately slow base.
//   - consecutiveFailures > 0: the curve doubles from base on every
//     consecutive failure and caps at max(maxReportDelay, base), so it can
//     never produce a delay smaller than the operator's own base (which
//     would look like backoff going backwards) while still bounding runaway
//     growth for the common case of base <= 1h.
func NextReportDelay(base time.Duration, consecutiveFailures int) time.Duration {
	if consecutiveFailures <= 0 {
		return base
	}
	ceiling := maxReportDelay
	if base > ceiling {
		ceiling = base
	}
	delay := base
	for i := 0; i < consecutiveFailures; i++ {
		if delay >= ceiling {
			return ceiling
		}
		delay *= 2
	}
	if delay > ceiling {
		return ceiling
	}
	return delay
}

// ConfigFileField is the wire shape of the "configFile" object in the
// config-file report envelope (contract: docs/superpowers/plans/
// 2026-08-09-m2a-agent-config-visibility.md, "契约速查"). On a successful
// Read, Hash/Content/Size/ModTimeMs are populated and Error is empty. On a
// Read failure (unreadable file, oversized file, non-UTF-8 content), only
// Path and Error are meaningfully set; Hash and ModTimeMs are omitted from
// the wire payload via omitempty, matching the contract's reduced error
// shape closely (the collector's error branch only inspects Error and
// ignores the rest — see the plan's "configFile.error 分支只记日志...不落库").
//
// Content and Size deliberately do NOT use omitempty, so on the error
// branch they still serialize as "content":"" / "size":0 alongside "error"
// rather than being dropped. buildPayload already branches explicitly on
// snap.Err to decide which fields to populate, so omitempty bought nothing
// there — and on the success branch, omitempty would have incorrectly
// dropped a legitimately empty (0-byte) config file's "content"/"size"
// fields, since Content=="" and Size==0 are valid non-error values, not
// "unset".
type ConfigFileField struct {
	Path      string `json:"path"`
	Hash      string `json:"hash,omitempty"`
	Content   string `json:"content"`
	Size      int64  `json:"size"`
	ModTimeMs int64  `json:"modTimeMs,omitempty"`
	Error     string `json:"error,omitempty"`
}

// ConfigFilePayload is the full wire envelope POSTed to the collector's
// /agent/config-file endpoint.
type ConfigFilePayload struct {
	BackendID       int             `json:"backendId"`
	AgentID         string          `json:"agentId"`
	AgentVersion    string          `json:"agentVersion,omitempty"`
	ProtocolVersion int             `json:"protocolVersion"`
	ConfigFile      ConfigFileField `json:"configFile"`
}

// PostFunc performs one POST of a config-file report envelope to path and
// reports whether the response was HTTP 404 — the signal a Reporter needs to
// tell "collector hasn't been upgraded yet, back off" apart from any other
// failure. status404 is only meaningful when err is non-nil; it is always
// false on success. The runner supplies this as a closure over its existing
// postJSONWithLatency helper so configfile stays free of any HTTP client or
// import on internal/agent/internal/config (no import cycle).
type PostFunc func(ctx context.Context, path string, payload interface{}) (status404 bool, err error)

// Reporter owns the read-hash-dedup-report cycle for one mihomo config.yaml
// path: it reads the file, asks its Tracker whether the snapshot is worth
// reporting, and if so POSTs it via Post, adjusting its 404 backoff state
// from the result.
//
// BackendID, AgentID and ProtocolVersion are carried as fields (rather than
// injected by the Post closure) so the full wire envelope — including the
// contract's top-level identity fields — is assembled in one place inside
// this package, and RunOnce can be tested end-to-end against a fake PostFunc
// without any HTTP/JSON scaffolding in the caller.
type Reporter struct {
	// ConfigPath is the mihomo config.yaml path on disk to read each tick.
	ConfigPath string
	// Path is the collector POST path, e.g. "/agent/config-file".
	Path string
	// Base is the interval between report attempts before any backoff is
	// applied (normally cfg.ConfigCheckInterval).
	Base time.Duration
	// Post performs the actual network POST; see PostFunc.
	Post PostFunc
	// Logf is an optional injectable logger. Nil (the default, and what
	// every test leaves it as) means silent — no logging occurs. The runner
	// wires this to log.Printf, matching the rest of runner.go: log output
	// is gated globally (main.go redirects it to io.Discard when
	// !cfg.LogEnabled), not by a per-call-site check here.
	Logf func(format string, args ...interface{})

	BackendID       int
	AgentID         string
	AgentVersion    string
	ProtocolVersion int

	tracker             Tracker
	consecutiveFailures int
	// lastOutcomeKnown/lastOutcomeOK track the previous POST attempt's
	// result so RunOnce can log only the FIRST failure and each state
	// transition (fail->ok, ok->fail) — never every tick, which would spam
	// the log at the configured check interval for as long as a collector
	// stays down.
	lastOutcomeKnown bool
	lastOutcomeOK    bool
}

// RunOnce reads the config file once, reports it upstream if the Tracker
// says it's worth reporting, and returns the delay before the next attempt
// should run.
//
//   - If the snapshot is unchanged (and forceAfter hasn't elapsed), nothing
//     is posted and the current (non-backed-off) delay is returned.
//   - On a successful POST, the snapshot is marked reported and the
//     consecutive-failure counter resets to 0.
//   - On ANY POST failure — a 404 (collector not yet upgraded) or any other
//     error (5xx, network error, ...) alike — the consecutive-failure
//     counter increments and the snapshot is NOT marked reported, so the
//     same content is retried on the next attempt. A single shared counter
//     backs off on persistent failure of any kind, not just 404, since a
//     collector that's merely down or erroring deserves the same quiet
//     retry cadence as one that hasn't been upgraded yet.
func (r *Reporter) RunOnce(ctx context.Context, now time.Time) (nextDelay time.Duration) {
	snap := Read(r.ConfigPath)

	if r.tracker.ShouldReport(snap, now, ForceReportAfter) {
		payload := r.buildPayload(snap)
		status404, err := r.Post(ctx, r.Path, payload)
		if err == nil {
			r.consecutiveFailures = 0
			r.tracker.MarkReported(snap, now)
			if r.lastOutcomeKnown && !r.lastOutcomeOK {
				r.logf("configfile: report recovered (path=%s)", r.ConfigPath)
			}
			r.lastOutcomeKnown = true
			r.lastOutcomeOK = true
		} else {
			r.consecutiveFailures++
			if !r.lastOutcomeKnown || r.lastOutcomeOK {
				r.logf("configfile: report failed (path=%s status404=%v): %v", r.ConfigPath, status404, err)
			}
			r.lastOutcomeKnown = true
			r.lastOutcomeOK = false
		}
	}

	return NextReportDelay(r.Base, r.consecutiveFailures)
}

// logf calls Logf if set, else does nothing (default no-op — every existing
// test leaves Logf nil and relies on this).
func (r *Reporter) logf(format string, args ...interface{}) {
	if r.Logf == nil {
		return
	}
	r.Logf(format, args...)
}

// buildPayload assembles the wire envelope for snap, using the reduced
// error shape when snap.Err is set (see ConfigFileField).
func (r *Reporter) buildPayload(snap Snapshot) ConfigFilePayload {
	field := ConfigFileField{Path: snap.Path}
	if snap.Err != "" {
		field.Error = snap.Err
	} else {
		field.Hash = snap.Hash
		field.Content = string(snap.Content)
		field.Size = snap.Size
		field.ModTimeMs = snap.ModTimeMs
	}
	return ConfigFilePayload{
		BackendID:       r.BackendID,
		AgentID:         r.AgentID,
		AgentVersion:    r.AgentVersion,
		ProtocolVersion: r.ProtocolVersion,
		ConfigFile:      field,
	}
}
