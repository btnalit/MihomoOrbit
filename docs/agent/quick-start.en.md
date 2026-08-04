# Agent Quick Start

[中文](./quick-start.md) | **English**

## 1) Create an Agent backend in UI

In `Settings -> Backends`:

1. Click "Add Backend"
2. Set mode to `Agent`
3. Choose gateway type: `Clash / Mihomo` or `Surge`
4. Save — the panel generates a backend token automatically

Then open **"View Agent Script"** and copy the one-line install command.

## 2) Install on remote host

### Clash / Mihomo gateway

```bash
curl -fsSL https://raw.githubusercontent.com/btnalit/MihomoOrbit/main/apps/agent/install.sh \
  | env ORBIT_SERVER='http://your-panel:3000' \
        ORBIT_BACKEND_ID='1' \
        ORBIT_BACKEND_TOKEN='ag_xxx' \
        ORBIT_GATEWAY_TYPE='clash' \
        ORBIT_GATEWAY_URL='http://127.0.0.1:9090' \
        ORBIT_GATEWAY_TOKEN='clash-secret' \
        sh
```

### Surge gateway

```bash
curl -fsSL https://raw.githubusercontent.com/btnalit/MihomoOrbit/main/apps/agent/install.sh \
  | env ORBIT_SERVER='http://your-panel:3000' \
        ORBIT_BACKEND_ID='2' \
        ORBIT_BACKEND_TOKEN='ag_yyy' \
        ORBIT_GATEWAY_TYPE='surge' \
        ORBIT_GATEWAY_URL='http://127.0.0.1:9091' \
        ORBIT_GATEWAY_TOKEN='surge-key' \
        sh
```

- `ORBIT_GATEWAY_TYPE`: `clash` for Clash/Mihomo, `surge` for Surge v5+
- `ORBIT_GATEWAY_TOKEN`: Clash uses it as `Authorization` bearer; Surge uses it as `x-key` header
- `ORBIT_GATEWAY_TOKEN` is optional — omit if no auth is configured on the gateway

The install script detects an existing installation automatically. If `orbit-agent` is already
present, it adds the new instance without re-downloading the binary.

## 3) Manage the agent

After install, use `orbitagent` to manage instances:

```bash
orbitagent list                        # list all configured instances
orbitagent status <instance>           # check running state
orbitagent logs <instance>             # tail live logs
orbitagent restart <instance>          # restart the process
orbitagent stop <instance>             # graceful stop (up to ~12s for final flush)
orbitagent upgrade                     # global upgrade (CLI + binary)
orbitagent remove <instance>           # stop + delete config
```

The default instance name is `backend-<id>` unless you set `ORBIT_INSTANCE_NAME`.

## 4) Verify in dashboard

- In backend list, click **"Test Connection"**
- Confirm agent health becomes `online`
- Confirm traffic is visible in the dashboard after ~30 seconds (first flush interval)

## Important notes

- Use the actual panel address in `ORBIT_SERVER`; avoid `localhost` unless panel is on the same host
- Each backend token is bound to one agent ID — do not reuse the same token across multiple hosts
- Rotate token in UI if leaked; old agent process will be rejected until reconfigured with new token
- Adding a second gateway on the same host: run the install script again with a different `ORBIT_BACKEND_ID` and `ORBIT_INSTANCE_NAME`; the script detects the existing binary and only adds the new instance
