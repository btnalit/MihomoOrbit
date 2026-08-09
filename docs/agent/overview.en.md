# Agent Mode Overview

[中文](./overview.md) | **English**

## What Agent mode solves

Agent mode allows a centralized MihomoOrbit panel to receive data from remote LAN gateways without direct collector-to-gateway access.

- Panel service runs in one central location (cloud VPS, NAS, server)
- Agent runs close to each gateway (OpenWrt, Linux host, router companion box)
- Agent pulls local gateway data and reports to panel over HTTP API

This is ideal for multi-site homes/labs and distributed deployments.

## Data flow

1. Create a backend with the Agent option enabled; MihomoOrbit generates the token automatically
2. Agent polls Clash/Surge gateway API locally
3. Agent submits batch deltas to `/api/agent/report`
4. Agent sends periodic heartbeat to `/api/agent/heartbeat`
5. Dashboard reads unified backend statistics and realtime cache

## Direct vs Agent

- `Direct`
  - collector connects gateway directly
  - lowest latency for local setup
  - requires network reachability from collector to gateway
- `Agent`
  - collector does not pull remote gateway directly
  - one extra hop (agent report), better network isolation
  - easier for cross-LAN / NAT / private subnet deployments

## Security model

- Agent backend token is system-generated and treated as a credential
- Token rotation invalidates old running agents
- `agentId` defaults to a value `orbitagent` generates locally — `"agent-" + sha256(backend-token)[:16]`, stable across restarts — or can be set explicitly with `--agent-id`; the panel never derives this value itself
- **Binding is first-come, first-served**: the first heartbeat that presents a valid token atomically claims the `agentId` it carries for that backend. Any later heartbeat for the same backend carrying a different `agentId` is rejected with `409 AGENT_BINDING_FIXED` — even if the token matches
- Rebinding is an explicit admin operation, with exactly two paths: unbind in backend settings (keeps the token, clears the binding — the next heartbeat claims it again), or rotate the token (also clears the binding)
- To use `--agent-id` explicitly, keep it consistent for a given token — changing it mid-flight hits the same `AGENT_BINDING_FIXED` rejection

## Gateway type support

The agent supports two gateway types:

- `clash` — connects to Clash / Mihomo via WebSocket (`/connections` endpoint); real-time push
- `surge` — polls Surge HTTP API (`/v1/requests/recent`) every 2 seconds; no WebSocket required

Both types go through the same report pipeline to the panel. Set `--gateway-type` accordingly.

## Multi-instance support

A single host can run multiple agent instances simultaneously, each reporting to a different
backend on the same or different panels. The `orbitagent` CLI manager handles instance
isolation using separate config and PID files per instance name.

Example: one host running both a Clash and a Surge gateway:

```
orbitagent list
home-clash   running   backend-id=1  gateway=clash
home-surge   running   backend-id=2  gateway=surge
```

## Process isolation (PID lock)

Each agent instance holds a PID lock to prevent duplicate processes for the same backend.
If an instance crashes and leaves a stale PID file, `orbitagent start` will report it as
already running. See troubleshooting guide for how to resolve this.
