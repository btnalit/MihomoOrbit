# Release Checklist

Use this checklist before shipping a new Neko Master release that includes Agent mode.

## Release lines

- Main product release tag: `vX.Y.Z` (builds Docker images)
- Agent client release tag: `agent-vX.Y.Z` (publishes multi-arch agent packages)

`agent-v*` does not publish Docker images.

## Pre-release validation

Run locally from repo root:

```bash
pnpm --filter @neko-master/collector build
pnpm --filter @neko-master/web exec tsc --noEmit
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
  - `neko-agent_<tag>_<os>_<arch>.tar.gz`
  - `neko-agent_<os>_<arch>.tar.gz`
  - `checksums.txt`

## Post-release checks

1. Open GitHub release page and verify all target architectures are present.
2. Validate one Linux host install using script:

```bash
curl -fsSL https://raw.githubusercontent.com/foru17/neko-master/main/apps/agent/install.sh \
  | env NEKO_SERVER='http://<panel>:3000' \
        NEKO_BACKEND_ID='<id>' \
        NEKO_BACKEND_TOKEN='<token>' \
        NEKO_GATEWAY_TYPE='clash' \
        NEKO_GATEWAY_URL='http://127.0.0.1:9090' \
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
