# Agent Troubleshooting

[中文](./troubleshooting.md) | **English**

## `exec format error`

Cause: binary architecture mismatch.

Check:

```sh
file ./orbit-agent
uname -m
```

Fix: use matching release package for current target.

## Agent always offline

Checklist:

- `--server-url` points to panel host (not remote machine localhost)
- backend token is current (not rotated/expired)
- backend is in Agent mode
- heartbeat endpoint reachable from agent host

## `Invalid agent token`

- token mismatch between agent process and backend config
- rotate token in UI and restart agent with new token

## `AGENT_BINDING_FIXED`

Cause: this backend is already bound to one `agentId`, and another `agentId` sent a heartbeat with the same token (409, no timeout window — rebinding must be an explicit admin operation).

Fix:

- Unbind the agent in backend settings (`POST /api/backends/:id/agent/unbind`); the new agent claims the binding on its next heartbeat
- Or rotate the backend's agent token (this also clears the binding), then restart the agent with the new token

## `426` compatibility errors

Possible codes:

- `AGENT_PROTOCOL_TOO_OLD`
- `AGENT_VERSION_REQUIRED`
- `AGENT_VERSION_TOO_OLD`

Fix:

- upgrade agent to a newer release package
- check collector env requirements:
  - `MIN_AGENT_PROTOCOL_VERSION`
  - `MIN_AGENT_VERSION`

## Surge decode errors

Recent agent parser supports mixed field formats (`id` number/string, numeric strings).
If still failing, collect error logs and open an issue with response sample.

## Agent won't start: PID file / already running

The agent binary uses a PID lock file to prevent running the same backend ID twice.
If a previous crash left a stale PID file, the new process exits immediately.

Check:

```bash
orbitagent status <instance>
```

If it says "stopped" but the agent won't start:

```bash
# locate and remove stale PID file
ls /var/run/orbit-agent/
rm /var/run/orbit-agent/<instance>.pid
orbitagent start <instance>
```

## `orbitagent stop` takes a long time

This is expected. When stopped, the agent waits up to 10 seconds to flush the final batch
of traffic data to the panel before exiting. The stop command waits up to 12 seconds before
sending SIGKILL.

If you need to force-kill immediately:

```bash
pid=$(cat /var/run/orbit-agent/<instance>.pid)
kill -9 "$pid"
rm -f /var/run/orbit-agent/<instance>.pid
```

Note: force-killing may lose the last ~30s of traffic data that has not yet been flushed.

## `orbitagent logs` shows no output

The log file is created after the first successful start. If the agent fails immediately on
start, check for errors with:

```bash
journalctl -u orbit-agent-<instance> -n 50    # if using systemd
# or check the log file directly
cat /var/run/orbit-agent/<instance>.log
```

## Agent reports but dashboard shows no data

Possible causes:

1. Gateway type mismatch — verify `--gateway-type` matches actual gateway (`clash` vs `surge`)
2. Gateway URL unreachable from agent host — test with `curl http://<gateway-url>/version`
3. First flush hasn't happened yet — wait 30 seconds (default flush interval)
4. Backend is in Direct mode, not Agent mode — check backend settings in UI
