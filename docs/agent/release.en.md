# Agent Release and Packaging

[中文](./release.md) | **English**

## Tagging strategy

- Agent release workflow triggers on tags: `agent-v*`
- Example: `agent-v0.2.0`

## Generated assets

For each target OS/arch, workflow publishes two tarballs:

- Versioned: `neko-agent_<tag>_<os>_<arch>.tar.gz`
- Latest alias: `neko-agent_<os>_<arch>.tar.gz`

Also publishes:

- `checksums.txt` (SHA256 for all tarballs)

## CI workflows

- `.github/workflows/agent-build.yml`
  - Runs on PR/push
  - Executes `go test ./...`
  - Cross-build matrix validation

- `.github/workflows/agent-release.yml`
  - Runs on `agent-v*` tag push
  - Cross-builds, archives, generates checksums
  - Publishes release assets to GitHub Releases

## Compatibility gate (recommended)

Collector validates incoming agent compatibility on heartbeat/report:

- `MIN_AGENT_PROTOCOL_VERSION` (default `1`)
- `MIN_AGENT_VERSION` (optional, e.g. `1.3.8`)

When incompatible, API returns `426` with machine-readable code:

- `AGENT_PROTOCOL_TOO_OLD`
- `AGENT_VERSION_REQUIRED`
- `AGENT_VERSION_TOO_OLD`

## Compatibility matrix template

| Agent Version | Min Server Version | Protocol |
| --- | --- | --- |
| `agent-v1.3.1` | `v1.3.1` | `1` |
| `agent-v1.3.8` | `v1.3.1` | `1` |

Numbers may skip when no agent release is needed.

## Naming conventions

- Binary inside tarball is always `neko-agent`
- Tarball name carries platform identity for user download and script detection
- Linux variants explicitly distinguish `amd64/arm64/armv7/mips/mipsle`
