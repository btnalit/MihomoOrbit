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

// maxReportDelay caps the 404 backoff curve. Once a collector doesn't
// recognize the config-file endpoint (not yet upgraded), retries settle onto
// this quiet, bounded cadence instead of climbing forever.
const maxReportDelay = time.Hour

// NextReportDelay computes the delay before the next report attempt given
// consecutive404 consecutive 404 responses from the collector. It doubles
// from base on every consecutive 404 and caps at maxReportDelay (1h), so an
// agent talking to an unupgraded collector backs off to a fixed quiet
// cadence rather than retrying at full speed forever or overflowing on an
// unbounded run of 404s.
func NextReportDelay(base time.Duration, consecutive404 int) time.Duration {
	if consecutive404 <= 0 {
		if base > maxReportDelay {
			return maxReportDelay
		}
		return base
	}
	delay := base
	for i := 0; i < consecutive404; i++ {
		if delay >= maxReportDelay {
			return maxReportDelay
		}
		delay *= 2
	}
	if delay > maxReportDelay {
		return maxReportDelay
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
	// Base is the interval between report attempts before any 404 backoff
	// is applied (normally cfg.ConfigCheckInterval).
	Base time.Duration
	// Post performs the actual network POST; see PostFunc.
	Post PostFunc

	BackendID       int
	AgentID         string
	ProtocolVersion int

	tracker        Tracker
	consecutive404 int
}

// RunOnce reads the config file once, reports it upstream if the Tracker
// says it's worth reporting, and returns the delay before the next attempt
// should run.
//
//   - If the snapshot is unchanged (and forceAfter hasn't elapsed), nothing
//     is posted and the current (non-backed-off) delay is returned.
//   - On a successful POST, the snapshot is marked reported and the 404
//     counter resets to 0.
//   - On a 404 response, the 404 counter increments and the snapshot is NOT
//     marked reported, so the same content is retried on the next attempt.
//   - On any other POST failure, the 404 counter resets to 0 (backoff is
//     specifically for "collector not upgraded yet", not transient errors)
//     and the snapshot is NOT marked reported.
func (r *Reporter) RunOnce(ctx context.Context, now time.Time) (nextDelay time.Duration) {
	snap := Read(r.ConfigPath)

	if r.tracker.ShouldReport(snap, now, ForceReportAfter) {
		payload := r.buildPayload(snap)
		status404, err := r.Post(ctx, r.Path, payload)
		switch {
		case err == nil:
			r.consecutive404 = 0
			r.tracker.MarkReported(snap, now)
		case status404:
			r.consecutive404++
		default:
			r.consecutive404 = 0
		}
	}

	return NextReportDelay(r.Base, r.consecutive404)
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
		ProtocolVersion: r.ProtocolVersion,
		ConfigFile:      field,
	}
}
