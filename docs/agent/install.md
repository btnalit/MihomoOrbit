# Agent 安装指南

**中文 | [English](./install.en.md)**

## 支持的目标平台

发布产物覆盖：

- `darwin-amd64`
- `darwin-arm64`
- `linux-amd64`
- `linux-arm64`
- `linux-armv7`
- `linux-mips`
- `linux-mipsle`

## 通过脚本安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/btnalit/MihomoOrbit/main/apps/agent/install.sh \
  | env ORBIT_SERVER='http://your-panel:3000' \
        ORBIT_BACKEND_ID='13' \
        ORBIT_BACKEND_TOKEN='ag_xxx' \
        ORBIT_GATEWAY_TYPE='clash' \
        ORBIT_GATEWAY_URL='http://127.0.0.1:9090' \
        sh
```

可选环境变量：

- `ORBIT_GATEWAY_TOKEN`：网关认证 token
- `ORBIT_AGENT_VERSION`：`latest`（默认）或具体标签如 `agent-v0.2.0`
- `ORBIT_INSTALL_DIR`：安装目录（默认 `$HOME/.local/bin`）
- `ORBIT_AUTO_START`：`true|false`（默认 `true`，安装后立即启动并自动注册开机自启）
- `ORBIT_LOG`：`true|false`（默认 `true`）
- `ORBIT_LOG_FILE`：运行时日志文件路径
- `ORBIT_PACKAGE_URL`：自定义软件包 URL
- `ORBIT_CHECKSUMS_URL`：自定义校验和 URL
- `ORBIT_INSTANCE_NAME`：`orbitagent` 管理器中的实例名（默认 `backend-<id>`）
- `ORBIT_BIN_LINK_MODE`：全局 bin 目录软链模式（`auto|true|false`，默认 `auto`）
- `ORBIT_LINK_DIR`：软链目标目录（默认 `/usr/local/bin`）
- `ORBIT_MIHOMO_CONFIG`：要监视的 mihomo `config.yaml` 路径（可选；留空则禁用配置可见性上报）
- `ORBIT_CONFIG_CHECK_INTERVAL`：配置文件检查间隔（默认 `60s`，下限钳制为 `10s`）

安装完成后，使用以下命令管理 Agent：

```bash
orbitagent status <instance>
orbitagent logs <instance>
orbitagent restart <instance>
orbitagent upgrade
orbitagent upgrade agent-vX.Y.Z
orbitagent remove <instance>
```

卸载二进制：

```bash
orbitagent uninstall
```

## 手动安装

1. 从 GitHub Releases 下载对应平台的压缩包
2. 使用 `checksums.txt` 验证哈希
3. 解压 `orbit-agent`
4. 携带后端参数直接运行可执行文件

## 安装了哪些文件

安装脚本在 `ORBIT_INSTALL_DIR`（默认 `~/.local/bin`）中放置两个二进制文件：

- `orbit-agent` — 数据采集守护进程（持续运行，向面板上报数据）
- `orbitagent` — CLI 管理器（Shell 脚本，管理实例生命周期：start / stop / upgrade / remove）

`orbitagent` 管理器的存储位置：

- 实例配置：`CONFIG_DIR`（默认 `/etc/orbit-agent/<name>.env`）
- PID 与日志文件：`STATE_DIR`（默认 `/var/run/orbit-agent/`）

## 开机自启配置

从 `agent-v0.2.1` 开始，安装脚本在 `ORBIT_AUTO_START=true` 时会自动尝试注册系统开机自启（systemd / OpenWrt procd / launchd / cron 回退）。
若当前环境权限不足或不支持自动注册，可使用手动方式配置系统服务，确保重启后自动恢复运行。

### Linux — systemd

创建 `/etc/systemd/system/orbit-agent-<instance>.service`（将 `<instance>` 替换为实例名，如 `backend-1`）：

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

若设置了 `ORBIT_GATEWAY_TOKEN`，在 `ExecStart` 末尾追加：

```ini
ExecStart=/usr/local/bin/orbit-agent \
  ...
  --gateway-token ${ORBIT_GATEWAY_TOKEN}
```

若设置了 `ORBIT_MIHOMO_CONFIG` / `ORBIT_CONFIG_CHECK_INTERVAL`（启用配置文件可见性上报），同样在 `ExecStart` 末尾追加：

```ini
ExecStart=/usr/local/bin/orbit-agent \
  ...
  --mihomo-config ${ORBIT_MIHOMO_CONFIG} \
  --config-check-interval ${ORBIT_CONFIG_CHECK_INTERVAL}
```

启用并启动：

```bash
systemctl daemon-reload
systemctl enable orbit-agent-<instance>
systemctl start orbit-agent-<instance>
systemctl status orbit-agent-<instance>
```

查看日志：

```bash
journalctl -u orbit-agent-<instance> -f
```

> 注意：若 `orbit-agent` 安装在 `~/.local/bin`（非 root），需相应调整 `ExecStart` 路径，并考虑以非 root 用户运行服务。

### macOS — launchd

创建 `~/Library/LaunchAgents/io.mihomo-orbit.agent.<instance>.plist`：

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

加载服务：

```bash
launchctl load ~/Library/LaunchAgents/io.mihomo-orbit.agent.<instance>.plist
```

卸载服务：

```bash
launchctl unload ~/Library/LaunchAgents/io.mihomo-orbit.agent.<instance>.plist
```

### OpenWrt — init.d

创建 `/etc/init.d/orbit-agent`：

```sh
#!/bin/sh /etc/rc.common
USE_PROCD=1
START=95
STOP=10

PROG=/usr/local/bin/orbit-agent
INSTANCE=backend-1   # 按需修改
CONF=/etc/orbit-agent/${INSTANCE}.env

start_service() {
    # 加载配置
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
    [ -n "$ORBIT_MIHOMO_CONFIG" ] && \
        procd_append_param command --mihomo-config "$ORBIT_MIHOMO_CONFIG"
    [ -n "$ORBIT_CONFIG_CHECK_INTERVAL" ] && \
        procd_append_param command --config-check-interval "$ORBIT_CONFIG_CHECK_INTERVAL"
    procd_set_param respawn 3600 5 5
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
}
```

启用：

```bash
chmod +x /etc/init.d/orbit-agent
/etc/init.d/orbit-agent enable
/etc/init.d/orbit-agent start
```

## OpenWrt 注意事项

安装前确认架构：

```sh
uname -m
opkg print-architecture
```

常见对应关系：

- `x86_64` → `linux-amd64`
- `aarch64` → `linux-arm64`
- `armv7*` → `linux-armv7`
- `mips` → `linux-mips`
- `mipsle` → `linux-mipsle`
