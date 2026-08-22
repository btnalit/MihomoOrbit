# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The Chinese changelog ([CHANGELOG.md](./CHANGELOG.md)) is the primary record and
also carries the upstream neko-master history predating the fork.

## [0.3.0] - 2026-08-22

From a monitoring panel to a full management panel: real-time management and
config editing land, plus three rounds of frontend quality hardening.

### Added

- **Real-time management (M1)**: proxy-group page (node selection, group speed
  test, latency badges), live connections table (search, sort, kill), live logs
  (level filter), runtime settings (mode / log level / allow-LAN, affecting the
  running core only) — all fed through the collector's WebSocket relay
  (ref-counted upstreams, circuit breaker, 500-entry log ring).
- **Unified backend model (M1c)**: one backend = an API channel (monitoring /
  management) plus an optional Agent channel (config editing); pages are gated
  by `monitoring / management / configEdit` capabilities; direct credentials
  and agent tokens are mutually exclusive to prevent double-writes.
- **Config editing (M2)**: metadata-driven `config.yaml` form editor; Go agent
  v2 executes a six-step atomic write-back carried over heartbeats (base-hash
  conflict detection, three rotating backups, atomic replace, reload, triple
  health gate, automatic rollback), with version history and one-click
  rollback; sensitive-field masking with comment/anchor fidelity (CST-level
  substitution).
- **Providers page (M1.5)**: rule/proxy provider listing and manual refresh;
  hidden-group filter, non-Selector member locking and group icons.
- **Management UX (M1.7)**: pagination for connections/logs (logs switch to
  newest-first); adaptive proxy-group node grid with in-group search and a
  collapsed latency summary bar; config editor gains dialer-proxy name
  suggestions (pick an existing proxy/group or type freely), the full official
  34-cipher Shadowsocks list, vmess `zero`, built-in policies plus individual
  proxies in the rule policy select, and nested group membership.
- Release automation: pushing a `v*` tag now creates the GitHub Release
  automatically after the image push succeeds (body extracted from this file,
  `docker-compose.yml` and `.env.example` attached), with a tag ↔ root
  `package.json` version consistency gate.

### Fixed

- Agent health thresholds (30s/8s) sat below the 30s heartbeat interval and
  caused guaranteed flapping → 75s, overridable via
  `AGENT_HEARTBEAT_TIMEOUT_MS` / `AGENT_MANUAL_TEST_TIMEOUT_MS`.
- Sidebar jumped whenever a popup opened: the base scroll-lock armor targeted
  `html` while react-remove-scroll marks `body`, so `overflow: hidden` on body
  re-anchored the sticky sidebar — override corrected.
- Connections page stuck on its skeleton forever against idle backends
  (mihomo serializes zero connections as `connections: null`; such frames were
  dropped wholesale).
- Kill button clicks silently missed under the 1s live re-sort (frame
  application now freezes while a pointer is held over the table).
- Add/edit backend dialogs had no height cap — Save/Cancel unreachable on
  short viewports.
- Dialer-proxy suggestion dropdown dismissed by its own opening click gesture.
- Stale PWA cache pinned phones to the old UI (service-worker cache version
  had never been bumped).
- Desktop sidebar could not scroll once nav items overflowed; new pages
  aligned to base styling (spacing, shadows, dark variants, empty states).
- i18n: change-token error showed a raw key path; backend verify animation had
  hardcoded English strings.

### Upgrade notes

- First startup runs an automatic backend-table schema migration (M1c); the
  one-time migration output in the logs is expected.
- Config editing requires binding an agent (`agent-v2.0.0`+) to the backend;
  monitoring/management-only backends need no agent and behave as before.
- The minimum accepted agent protocol version remains 1 — older agents keep
  heartbeating, but config editing requires v2.

## [0.1.0] - 2026-08-04

Hard fork of neko-master v1.4.5 as **MihomoOrbit**.

- Full identifier rename across npm scope, Go module, agent runtime, browser
  storage, Docker/CI (see `docs/migration-from-neko.md`).
- Authentication is now **mandatory**: both bypass branches closed, one-time
  setup token on first run, 16-char minimum, salted scrypt hashing,
  rate-limited verification. Legacy sha256 hashes are treated as unconfigured
  and force a re-setup.
- The agent keeps the legacy lock path so a leftover `neko-agent` cannot
  double-count traffic; `install.sh` refuses to install alongside one.
- `backendCapabilities()` contract added to `@mihomo-orbit/shared` and exposed
  on the backend list API.
- Repaired the `check:api-routes` gate (stale path, two uncovered controllers).
- The version deliberately resets to `0.1.0`, down from upstream neko-master's
  `1.4.0` — a fork restart, not a downgrade. GHCR/tag history before this
  point belongs to the upstream project's numbering.
