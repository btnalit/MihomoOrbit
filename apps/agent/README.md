# Neko Agent (Go)

A standalone executable agent for LAN data collection and reporting to MihomoOrbit.

## Architecture

The agent follows a layered Go structure so that `main` stays thin and business logic is testable.

- `main.go`: process entrypoint, wiring, signal handling
- `internal/config`: CLI parsing, validation, endpoint normalization
- `internal/agent`: runtime loops (collector/report/heartbeat), queue/retry/state management
- `internal/gateway`: Clash/Surge adapters, payload decoding, protocol-specific normalization
- `internal/domain`: shared domain models (`FlowSnapshot`, `TrafficUpdate`)

## Build

```bash
cd apps/agent

# local build
GOCACHE=/tmp/go-build go build -o orbit-agent .

# linux amd64
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOCACHE=/tmp/go-build go build -trimpath -ldflags "-s -w" -o dist/orbit-agent-linux-amd64 .

# linux arm64
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOCACHE=/tmp/go-build go build -trimpath -ldflags "-s -w" -o dist/orbit-agent-linux-arm64 .
```

## Run

### Clash

```bash
./orbit-agent \
  --server-url https://your-orbit.example.com \
  --backend-id 1 \
  --backend-token <backend-token> \
  --gateway-type clash \
  --gateway-url http://192.168.1.1:9090 \
  --gateway-token <optional-clash-secret>
```

### One-line Install Script (`curl | sh`)

```bash
curl -fsSL https://raw.githubusercontent.com/btnalit/MihomoOrbit/main/apps/agent/install.sh \
  | env ORBIT_SERVER="https://your-orbit.example.com" \
        ORBIT_BACKEND_ID="1" \
        ORBIT_BACKEND_TOKEN="<backend-token>" \
        ORBIT_GATEWAY_TYPE="clash" \
        ORBIT_GATEWAY_URL="http://192.168.1.1:9090" \
        sh
```

Installer also provides `orbitagent` manager for friendly operations:

```bash
orbitagent status backend-1
orbitagent logs backend-1
orbitagent restart backend-1
orbitagent upgrade
orbitagent upgrade agent-v1.3.2
orbitagent remove backend-1
orbitagent uninstall
```

Pin release version (recommended for production):

```bash
curl -fsSL https://raw.githubusercontent.com/btnalit/MihomoOrbit/main/apps/agent/install.sh \
  | env ORBIT_AGENT_VERSION="agent-v0.2.0" \
        ORBIT_SERVER="https://your-orbit.example.com" \
        ORBIT_BACKEND_ID="1" \
        ORBIT_BACKEND_TOKEN="<backend-token>" \
        ORBIT_GATEWAY_TYPE="clash" \
        ORBIT_GATEWAY_URL="http://192.168.1.1:9090" \
        sh
```

Quiet mode (no runtime logs):

```bash
./orbit-agent ... --log=false
```

### Surge

```bash
./orbit-agent \
  --server-url https://your-orbit.example.com \
  --backend-id 2 \
  --backend-token <backend-token> \
  --gateway-type surge \
  --gateway-url http://127.0.0.1:9091 \
  --gateway-token <optional-surge-key>
```

## Key flags

- `--agent-id`: custom agent id (default: `hostname-pid`)
- `--report-interval`: report interval (default `2s`)
- `--heartbeat-interval`: heartbeat interval (default `30s`)
- `--gateway-poll-interval`: gateway polling interval (default `2s`)
- `--report-batch-size`: max updates per report (default `1000`)
- `--max-pending-updates`: local queue cap (default `50000`)
- `--request-timeout`: HTTP timeout (default `15s`)
- `--log`: enable runtime logs (default `true`, set `--log=false` to disable)
- `--version`: print version

Install script env (optional):

- `ORBIT_GATEWAY_TOKEN`: gateway token
- `ORBIT_AUTO_START`: `true|false` (default `true`, starts now and registers boot autostart when supported)
- `ORBIT_LOG`: `true|false` (default `true`)
- `ORBIT_INSTALL_DIR`: install path (default `$HOME/.local/bin`)
- `ORBIT_AGENT_VERSION`: release tag, default `latest` (for tagged version use `agent-vX.Y.Z`)
- `ORBIT_PACKAGE_URL`: direct package URL override (tar.gz)
- `ORBIT_CHECKSUMS_URL`: checksums URL override

## Release artifact naming

Per release tag (`agent-v*`), CI publishes:

- `orbit-agent_<tag>_<os>_<arch>.tar.gz` (versioned)
- `orbit-agent_<os>_<arch>.tar.gz` (latest alias)
- `checksums.txt`

Binary name inside tarball is always `orbit-agent`.
