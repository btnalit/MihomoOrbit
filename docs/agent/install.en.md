# Agent Install Guide

[中文](./install.md) | **English**

## Supported targets

Release artifacts are published for:

- `darwin-amd64`
- `darwin-arm64`
- `linux-amd64`
- `linux-arm64`
- `linux-armv7`
- `linux-mips`
- `linux-mipsle`

## Install via script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/btnalit/MihomoOrbit/main/apps/agent/install.sh \
  | env ORBIT_SERVER='http://your-panel:3000' \
        ORBIT_BACKEND_ID='13' \
        ORBIT_BACKEND_TOKEN='ag_xxx' \
        ORBIT_GATEWAY_TYPE='clash' \
        ORBIT_GATEWAY_URL='http://127.0.0.1:9090' \
        sh
```

Optional env:

- `ORBIT_GATEWAY_TOKEN`: gateway auth token
- `ORBIT_AGENT_VERSION`: `latest` (default) or explicit tag like `agent-v0.2.0`
- `ORBIT_INSTALL_DIR`: install directory (default `$HOME/.local/bin`)
- `ORBIT_AUTO_START`: `true|false` (default `true`, starts immediately and auto-registers boot autostart)
- `ORBIT_LOG`: `true|false` (default `true`)
- `ORBIT_LOG_FILE`: runtime log file path
- `ORBIT_PACKAGE_URL`: custom package URL override
- `ORBIT_CHECKSUMS_URL`: custom checksums URL override
- `ORBIT_INSTANCE_NAME`: instance name for `orbitagent` manager (default `backend-<id>`)
- `ORBIT_BIN_LINK_MODE`: `auto|true|false` for symlink into global bin dir (default `auto`)
- `ORBIT_LINK_DIR`: global bin dir for symlink (default `/usr/local/bin`)

After install, manage agent with:

```bash
orbitagent status <instance>
orbitagent logs <instance>
orbitagent restart <instance>
orbitagent upgrade
orbitagent upgrade agent-vX.Y.Z
orbitagent remove <instance>
```

Uninstall binaries:

```bash
orbitagent uninstall
```

## Manual install

1. Download the correct tarball from GitHub Releases
2. Verify hash using `checksums.txt`
3. Extract `orbit-agent`
4. Run executable with backend parameters

## OpenWrt note

Before build selection, check architecture:

```sh
uname -m
opkg print-architecture
```

Common mapping:

- `x86_64` -> `linux-amd64`
- `aarch64` -> `linux-arm64`
- `armv7*` -> `linux-armv7`
- `mips` -> `linux-mips`
- `mipsle` -> `linux-mipsle`

## What gets installed

The install script places two binaries into `ORBIT_INSTALL_DIR` (default `~/.local/bin`):

- `orbit-agent` — the data collection daemon (runs continuously, reports to panel)
- `orbitagent` — the CLI manager for lifecycle operations (start / stop / upgrade / remove)

The `orbitagent` manager stores:

- Instance configs in `CONFIG_DIR` (default `/etc/orbit-agent/<name>.env`)
- PID and log files in `STATE_DIR` (default `/var/run/orbit-agent/`)

## Autostart on system boot

Since `agent-v0.2.1`, when `ORBIT_AUTO_START=true` the installer automatically attempts to
register boot autostart (systemd / OpenWrt procd / launchd / cron fallback).
If permissions are insufficient or the platform is unsupported, configure a system service
manually so the agent survives reboots.

### Linux — systemd

Create `/etc/systemd/system/orbit-agent-<instance>.service` (replace `<instance>` with your
instance name, e.g. `backend-1`):

```ini
[Unit]
Description=MihomoOrbit Agent (<instance>)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
EnvironmentFile=/etc/orbit-agent/<instance>.env
ExecStart=/usr/local/bin/orbit-agent \
  --server-url ${ORBIT_SERVER} \
  --backend-id ${ORBIT_BACKEND_ID} \
  --backend-token ${ORBIT_BACKEND_TOKEN} \
  --gateway-type ${ORBIT_GATEWAY_TYPE} \
  --gateway-url ${ORBIT_GATEWAY_URL}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

If `ORBIT_GATEWAY_TOKEN` is set, append it to `ExecStart`:

```ini
ExecStart=/usr/local/bin/orbit-agent \
  ...
  --gateway-token ${ORBIT_GATEWAY_TOKEN}
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable orbit-agent-<instance>
systemctl start orbit-agent-<instance>
systemctl status orbit-agent-<instance>
```

View logs:

```bash
journalctl -u orbit-agent-<instance> -f
```

> Note: If `orbit-agent` is installed to `~/.local/bin` (non-root), adjust `ExecStart` path
> accordingly and consider running the service under a non-root user.

### macOS — launchd

Create `~/Library/LaunchAgents/io.mihomo-orbit.agent.<instance>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.mihomo-orbit.agent.<instance></string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/orbit-agent</string>
    <string>--server-url</string>
    <string>http://your-panel:3000</string>
    <string>--backend-id</string>
    <string>1</string>
    <string>--backend-token</string>
    <string>ag_xxx</string>
    <string>--gateway-type</string>
    <string>clash</string>
    <string>--gateway-url</string>
    <string>http://127.0.0.1:9090</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/orbit-agent-<instance>.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/orbit-agent-<instance>.log</string>
</dict>
</plist>
```

Load the service:

```bash
launchctl load ~/Library/LaunchAgents/io.mihomo-orbit.agent.<instance>.plist
```

Unload:

```bash
launchctl unload ~/Library/LaunchAgents/io.mihomo-orbit.agent.<instance>.plist
```

### OpenWrt — init.d

Create `/etc/init.d/orbit-agent`:

```sh
#!/bin/sh /etc/rc.common
USE_PROCD=1
START=95
STOP=10

PROG=/usr/local/bin/orbit-agent
INSTANCE=backend-1   # change as needed
CONF=/etc/orbit-agent/${INSTANCE}.env

start_service() {
    # load config
    [ -f "$CONF" ] && . "$CONF"
    procd_open_instance
    procd_set_param command "$PROG" \
        --server-url "$ORBIT_SERVER" \
        --backend-id "$ORBIT_BACKEND_ID" \
        --backend-token "$ORBIT_BACKEND_TOKEN" \
        --gateway-type "$ORBIT_GATEWAY_TYPE" \
        --gateway-url "$ORBIT_GATEWAY_URL"
    [ -n "$ORBIT_GATEWAY_TOKEN" ] && \
        procd_append_param command --gateway-token "$ORBIT_GATEWAY_TOKEN"
    procd_set_param respawn 3600 5 5
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
}
```

Enable:

```bash
chmod +x /etc/init.d/orbit-agent
/etc/init.d/orbit-agent enable
/etc/init.d/orbit-agent start
```
