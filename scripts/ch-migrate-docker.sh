#!/usr/bin/env bash

set -euo pipefail

SQLITE_PATH="/app/data/stats.db"
MAX_DELTA="1"
TRUNCATE_FLAG="--truncate"
FROM_ARG=""
TO_ARG=""

while [[ $# -gt 0 ]]; do
	case "$1" in
	--sqlite-path)
		SQLITE_PATH="$2"
		shift 2
		;;
	--from)
		FROM_ARG="--from $2"
		shift 2
		;;
	--to)
		TO_ARG="--to $2"
		shift 2
		;;
	--max-delta)
		MAX_DELTA="$2"
		shift 2
		;;
	--append)
		TRUNCATE_FLAG=""
		shift
		;;
	-h | --help)
		cat <<'EOF'
Usage: scripts/ch-migrate-docker.sh [options]

Options:
  --sqlite-path <path>   SQLite path inside container (default: /app/data/stats.db)
  --from <iso-time>      Optional migration start time (e.g. 2026-02-01T00:00:00Z)
  --to <iso-time>        Optional migration end time
  --max-delta <percent>  Verify threshold percent (default: 1)
  --append               Do not truncate ClickHouse tables before import
  -h, --help             Show this help

Examples:
  scripts/ch-migrate-docker.sh
  scripts/ch-migrate-docker.sh --append
  scripts/ch-migrate-docker.sh --from 2026-02-01T00:00:00Z --to 2026-02-20T00:00:00Z
EOF
		exit 0
		;;
	*)
		echo "Unknown argument: $1" >&2
		exit 1
		;;
	esac
done

echo "[1/4] Starting containers (including ClickHouse profile)..."
docker compose --profile clickhouse up -d

echo "[2/4] Migrating SQLite -> ClickHouse..."
docker compose exec -T \
	-e CH_ENABLED=1 \
	neko-master \
	node /app/apps/collector/dist/scripts/migrate-sqlite-to-clickhouse.js \
	--sqlite "$SQLITE_PATH" \
	$TRUNCATE_FLAG \
	$FROM_ARG \
	$TO_ARG

echo "[3/4] Verifying SQLite vs ClickHouse..."
docker compose exec -T \
	-e CH_ENABLED=1 \
	neko-master \
	node /app/apps/collector/dist/scripts/verify-sqlite-clickhouse.js \
	--sqlite "$SQLITE_PATH" \
	--max-delta "$MAX_DELTA" \
	--fail-on-delta \
	$FROM_ARG \
	$TO_ARG

echo "[4/4] Done. Recommended next step: set STATS_QUERY_SOURCE=auto and restart"
echo "    docker compose up -d"
