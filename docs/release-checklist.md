# Release Checklist

Use this checklist before shipping a new MihomoOrbit release that includes Agent mode.

## Release lines

- Main product release tag: `vX.Y.Z` (builds Docker images)
- Agent client release tag: `agent-vX.Y.Z` (publishes multi-arch agent packages)

`agent-v*` does not publish Docker images.

## Pre-release validation

Run locally from repo root:

```bash
pnpm --filter @mihomo-orbit/collector build
pnpm --filter @mihomo-orbit/web exec tsc --noEmit
```

Run agent checks:

```bash
cd apps/agent
go test ./...
sh -n install.sh
cd ../..
sh -n setup.sh
```

## Publish steps

### 1) Main product (Docker)

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Expected result:

- Docker workflow runs
- Docker Hub / GHCR updated

### 2) Agent packages

```bash
git tag agent-vX.Y.Z
git push origin agent-vX.Y.Z
```

Expected result:

- `Agent Release` workflow runs
- Release assets uploaded:
  - `orbit-agent_<tag>_<os>_<arch>.tar.gz`
  - `orbit-agent_<os>_<arch>.tar.gz`
  - `checksums.txt`

## Post-release checks

1. Open GitHub release page and verify all target architectures are present.
2. Validate one Linux host install using script:

```bash
curl -fsSL https://raw.githubusercontent.com/btnalit/MihomoOrbit/main/apps/agent/install.sh \
  | env ORBIT_SERVER='http://<panel>:3000' \
        ORBIT_BACKEND_ID='<id>' \
        ORBIT_BACKEND_TOKEN='<token>' \
        ORBIT_GATEWAY_TYPE='clash' \
        ORBIT_GATEWAY_URL='http://127.0.0.1:9090' \
        sh
```

3. In UI, verify:
   - backend health can become online
   - rotate token invalidates old process
   - updated token works after restart

## Compatibility policy

- Agent version can skip numbers when no agent release is needed.
- Maintain matrix in `docs/agent/release.md`:
  - `Agent version -> minimum server version`
  - optional server gate:
    - `MIN_AGENT_PROTOCOL_VERSION`
    - `MIN_AGENT_VERSION`
- Protocol version 2 (M2b): adds config apply/rollback command dispatch over
  heartbeat (`commandResults` request field, `commands` response field —
  see `docs/agent/release.md`'s "协议版本 2" section for the full note).
  `MIN_AGENT_PROTOCOL_VERSION` stays `1` — this is a deliberate exception to
  the "bump protocol + raise minimum in the same commit" convention
  (`AGENTS.md` key contract 6): protocol-1 agents keep monitoring normally,
  they just never receive `commands`.
