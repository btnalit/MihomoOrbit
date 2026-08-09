#!/usr/bin/env sh
set -eu

# MihomoOrbit Agent Install Script
# Features:
#   - Detects existing orbitagent installation
#   - Uses local orbitagent if available
#   - Supports adding multiple backend instances

VERSION="0.2.0"

require_env() {
	key="$1"
	eval "val=\${$key:-}"
	if [ -z "$val" ]; then
		echo "[orbit-agent] error: env $key is required" >&2
		exit 1
	fi
}

show_intro() {
	cat <<'EOF'
╔════════════════════════════════════════════════════════════╗
║                    MihomoOrbit Agent                      ║
╚════════════════════════════════════════════════════════════╝

MihomoOrbit is a centralized traffic analytics panel.
Agent runs near your local gateway and reports data securely to the panel.

Project:
  https://github.com/btnalit/MihomoOrbit

Agent docs:
  https://github.com/btnalit/MihomoOrbit/tree/main/docs/agent

EOF
}

# 拦截同机残留的上游 neko-agent。二者共用后端令牌时,默认 agentId 由令牌哈希
# 派生、与二进制名无关,服务端无法区分,会把同一份流量统计两遍。新 agent 的双锁
# 会让它直接拒绝启动,所以这里提前给出可执行的卸载指引而不是让它静默失败。
detect_legacy_neko_agent() {
	if command -v nekoagent >/dev/null 2>&1; then
		return 0
	fi
	for path in "$HOME/.local/bin/nekoagent" "/usr/local/bin/nekoagent" /etc/init.d/neko-agent /etc/neko-agent; do
		if [ -e "$path" ]; then
			return 0
		fi
	done
	if command -v pgrep >/dev/null 2>&1 && pgrep -f 'neko-agent' >/dev/null 2>&1; then
		return 0
	fi
	if command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --all 2>/dev/null | grep -q 'neko-agent'; then
		return 0
	fi
	return 1
}

detect_existing_install() {
	# Check for orbitagent in common locations
	if command -v orbitagent >/dev/null 2>&1; then
		echo "$(command -v orbitagent)"
		return 0
	fi

	# Check default install locations
	for path in "$HOME/.local/bin/orbitagent" "/usr/local/bin/orbitagent"; do
		if [ -x "$path" ]; then
			echo "$path"
			return 0
		fi
	done

	# Not found
	return 1
}

download_file() {
	url="$1"
	output="$2"
	# Propagate the downloader's exit status (a plain `return 0` would mask
	# failures when callers invoke this inside a condition under `set -e`).
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --connect-timeout 10 --max-time 120 --retry 3 --retry-delay 2 "$url" -o "$output"
		return $?
	fi
	if command -v wget >/dev/null 2>&1; then
		wget -qO "$output" --timeout=120 --tries=3 "$url"
		return $?
	fi
	echo "[orbit-agent] error: curl or wget is required" >&2
	exit 1
}

normalize_os() {
	raw="$(uname -s | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')"
	case "$raw" in
	linux) echo "linux" ;;
	darwin) echo "darwin" ;;
	*)
		echo "[orbit-agent] error: unsupported OS: $raw" >&2
		exit 1
		;;
	esac
}

normalize_arch() {
	raw="$(uname -m | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')"
	case "$raw" in
	x86_64 | amd64) echo "amd64" ;;
	aarch64 | arm64) echo "arm64" ;;
	armv7l | armv7 | armhf) echo "armv7" ;;
	mips) echo "mips" ;;
	mipsle) echo "mipsle" ;;
	*)
		echo "[orbit-agent] error: unsupported architecture: $raw" >&2
		echo "[orbit-agent] hint: set ORBIT_PACKAGE_URL manually if your target is exotic" >&2
		exit 1
		;;
	esac
}

# Query GitHub releases API for the latest agent tag (e.g. "agent-v0.2.0").
# Returns empty string on failure.
#
# The repo publishes BOTH main-app (v*) and agent (agent-v*) releases into the
# same namespace, and either may be marked "latest". So we must NOT use the
# releases/latest endpoint — it can resolve to a main-app release that carries
# no agent binaries. Instead list recent releases and pick the newest agent-v*.
get_latest_remote_tag() {
	repo="${1:-btnalit/MihomoOrbit}"
	api_url="https://api.github.com/repos/${repo}/releases?per_page=100"
	tag=""
	if command -v curl >/dev/null 2>&1; then
		tag="$(curl -fsSL "$api_url" 2>/dev/null | awk -F'"' '/"tag_name"/{print $4}' | grep '^agent-v' | head -1)"
	elif command -v wget >/dev/null 2>&1; then
		tag="$(wget -qO- "$api_url" 2>/dev/null | awk -F'"' '/"tag_name"/{print $4}' | grep '^agent-v' | head -1)"
	fi
	printf '%s\n' "$tag"
}

compute_sha256() {
	file="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file" | awk '{print $1}'
		return 0
	fi
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$file" | awk '{print $1}'
		return 0
	fi
	if command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 "$file" | awk '{print $2}'
		return 0
	fi
	echo ""
}

# Use local orbitagent to add instance
use_local_agent() {
	orbitagent_path="$1"
	instance_name="${ORBIT_INSTANCE_NAME:-backend-${ORBIT_BACKEND_ID}}"

	echo "[orbit-agent] detected existing installation: $orbitagent_path"
	echo "[orbit-agent] using local orbitagent to add instance..."

	# Build add command
	set -- \
		"$orbitagent_path" add "$instance_name" \
		--server-url "$ORBIT_SERVER" \
		--backend-id "$ORBIT_BACKEND_ID" \
		--backend-token "$ORBIT_BACKEND_TOKEN" \
		--gateway-type "$ORBIT_GATEWAY_TYPE" \
		--gateway-url "$ORBIT_GATEWAY_URL"

	if [ -n "${ORBIT_GATEWAY_TOKEN:-}" ]; then
		set -- "$@" --gateway-token "$ORBIT_GATEWAY_TOKEN"
	fi

	if [ -n "${ORBIT_MIHOMO_CONFIG:-}" ]; then
		set -- "$@" --mihomo-config "$ORBIT_MIHOMO_CONFIG"
	fi

	if [ -n "${ORBIT_CONFIG_CHECK_INTERVAL:-}" ]; then
		set -- "$@" --config-check-interval "$ORBIT_CONFIG_CHECK_INTERVAL"
	fi

	if [ "${ORBIT_AUTO_START:-true}" != "true" ]; then
		set -- "$@" --no-start
	fi

	# Execute
	"$@"

	if [ "${ORBIT_AUTO_START:-true}" = "true" ]; then
		if "$orbitagent_path" enable-autostart "$instance_name"; then
			echo "[orbit-agent] boot autostart enabled for: $instance_name"
		else
			echo "[orbit-agent] warning: failed to enable boot autostart (instance still configured)"
			echo "[orbit-agent] hint: run manually: $orbitagent_path enable-autostart $instance_name"
		fi
	fi
}

show_plan() {
	token_mode="not set"
	if [ -n "${ORBIT_GATEWAY_TOKEN:-}" ]; then
		token_mode="provided"
	fi

	cat <<EOF
[orbit-agent] install plan:
  target:            ${os}/${arch}
  version:           ${ORBIT_AGENT_VERSION}
  backend id:        ${ORBIT_BACKEND_ID}
  instance:          ${ORBIT_INSTANCE_NAME}
  gateway type:      ${ORBIT_GATEWAY_TYPE}
  gateway url:       ${ORBIT_GATEWAY_URL}
  gateway token:     ${token_mode}
  install dir:       ${ORBIT_INSTALL_DIR}
  auto start:        ${ORBIT_AUTO_START}
EOF
}

# Main installation flow
main() {
	require_env "ORBIT_SERVER"
	require_env "ORBIT_BACKEND_ID"
	require_env "ORBIT_BACKEND_TOKEN"
	require_env "ORBIT_GATEWAY_URL"

	show_intro

	if detect_legacy_neko_agent; then
		echo "[orbit-agent] error: an existing neko-agent installation was detected." >&2
		echo "[orbit-agent] Running both agents against the same backend double-counts all traffic," >&2
		echo "[orbit-agent] and orbit-agent will refuse to start while the legacy lock is held." >&2
		echo "[orbit-agent] Uninstall it first, e.g.:" >&2
		echo "[orbit-agent]   nekoagent remove <instance>   # or: /etc/init.d/neko-agent stop && rm -rf /etc/neko-agent" >&2
		echo "[orbit-agent] Override at your own risk with ORBIT_FORCE_INSTALL=1" >&2
		if [ "${ORBIT_FORCE_INSTALL:-0}" != "1" ]; then
			exit 1
		fi
		echo "[orbit-agent] warning: ORBIT_FORCE_INSTALL=1 set — continuing despite legacy neko-agent" >&2
	fi

	# Environment defaults
	ORBIT_GATEWAY_TYPE="${ORBIT_GATEWAY_TYPE:-clash}"
	ORBIT_GATEWAY_TOKEN="${ORBIT_GATEWAY_TOKEN:-}"
	ORBIT_AGENT_REPO="${ORBIT_AGENT_REPO:-btnalit/MihomoOrbit}"
	ORBIT_AGENT_VERSION="${ORBIT_AGENT_VERSION:-latest}"
	ORBIT_PACKAGE_URL="${ORBIT_PACKAGE_URL:-}"
	ORBIT_CHECKSUMS_URL="${ORBIT_CHECKSUMS_URL:-}"
	ORBIT_CLI_URL="${ORBIT_CLI_URL:-}"
	# ORBIT_AGENT_REF: override the git branch/ref used to download the orbitagent manager script.
	# Useful for testing unreleased branches (e.g. ORBIT_AGENT_REF=refactor/clickhouse).
	# When unset: uses "main" for latest, or the version tag for pinned versions.
	ORBIT_AGENT_REF="${ORBIT_AGENT_REF:-}"
	ORBIT_INSTALL_DIR="${ORBIT_INSTALL_DIR:-$HOME/.local/bin}"
	ORBIT_BIN_LINK_MODE="${ORBIT_BIN_LINK_MODE:-auto}"
	ORBIT_LINK_DIR="${ORBIT_LINK_DIR:-/usr/local/bin}"
	ORBIT_LOG="${ORBIT_LOG:-true}"
	ORBIT_AUTO_START="${ORBIT_AUTO_START:-true}"
	ORBIT_INSTANCE_NAME="${ORBIT_INSTANCE_NAME:-backend-${ORBIT_BACKEND_ID}}"

	os="$(normalize_os)"
	arch="$(normalize_arch)"

	# Check if orbitagent is already installed
	existing_agent="$(detect_existing_install || true)"

	# If already installed, check whether the binary is up-to-date before deciding
	if [ -n "$existing_agent" ] && [ "${ORBIT_FORCE_INSTALL:-false}" != "true" ]; then
		# Locate the orbit-agent binary (same dir as orbitagent, or /usr/local/bin fallback)
		existing_bin="$(dirname "$existing_agent")/orbit-agent"
		[ -x "$existing_bin" ] || existing_bin="/usr/local/bin/orbit-agent"

		local_version=""
		if [ -x "$existing_bin" ]; then
			local_version="$("$existing_bin" --version 2>/dev/null | head -1 || true)"
		fi

		# Determine target plain version (strip "agent-v" prefix)
		if [ "$ORBIT_AGENT_VERSION" = "latest" ]; then
			resolved_tag="$(get_latest_remote_tag "$ORBIT_AGENT_REPO")"
			remote_tag="$resolved_tag"
			target_version="${remote_tag#agent-v}"
		else
			target_version="${ORBIT_AGENT_VERSION#agent-v}"
			target_version="${target_version#v}"
		fi

		# If versions match, skip download and just add the instance
		if [ -n "$local_version" ] && [ -n "$target_version" ] && [ "$local_version" = "$target_version" ]; then
			echo "[orbit-agent] binary already at $local_version, skipping download"
			use_local_agent "$existing_agent"
			exit 0
		fi

		if [ -n "$local_version" ]; then
			echo "[orbit-agent] binary update: $local_version -> ${target_version:-latest}"
		else
			echo "[orbit-agent] binary not found or version unknown, downloading..."
		fi
		# Fall through to full download/install, then re-use existing orbitagent to add instance
	fi

	# Full installation needed
	show_plan

	if [ "$ORBIT_AGENT_VERSION" = "latest" ]; then
		# Resolve "latest" to a concrete agent-v* tag. releases/latest/download is
		# unsafe here: it points at whatever release GitHub marks latest, which may
		# be a main-app v* release with no agent binaries (→ 404).
		resolved_tag="${resolved_tag:-$(get_latest_remote_tag "$ORBIT_AGENT_REPO")}"
		if [ -z "$resolved_tag" ]; then
			echo "[orbit-agent] error: could not determine latest agent version from GitHub API" >&2
			echo "[orbit-agent] hint: check network access or pin a version: ORBIT_AGENT_VERSION=agent-vX.Y.Z" >&2
			exit 1
		fi
		release_path="releases/download/${resolved_tag}"
		asset="orbit-agent_${os}_${arch}.tar.gz"
	else
		release_path="releases/download/${ORBIT_AGENT_VERSION}"
		asset="orbit-agent_${ORBIT_AGENT_VERSION}_${os}_${arch}.tar.gz"
	fi

	checksums_asset="checksums.txt"

	if [ -n "$ORBIT_PACKAGE_URL" ]; then
		package_url="$ORBIT_PACKAGE_URL"
	else
		package_url="https://github.com/${ORBIT_AGENT_REPO}/${release_path}/${asset}"
	fi

	if [ -n "$ORBIT_CHECKSUMS_URL" ]; then
		checksums_url="$ORBIT_CHECKSUMS_URL"
	else
		checksums_url="https://github.com/${ORBIT_AGENT_REPO}/${release_path}/${checksums_asset}"
	fi

	if [ -n "$ORBIT_CLI_URL" ]; then
		cli_url="$ORBIT_CLI_URL"
	else
		if [ -n "$ORBIT_AGENT_REF" ]; then
			cli_ref="$ORBIT_AGENT_REF"
		elif [ "$ORBIT_AGENT_VERSION" = "latest" ]; then
			cli_ref="main"
		else
			cli_ref="$ORBIT_AGENT_VERSION"
		fi
		cli_url="https://raw.githubusercontent.com/${ORBIT_AGENT_REPO}/${cli_ref}/apps/agent/orbitagent"
	fi

	tmp_dir="${TMPDIR:-/tmp}/orbit-agent.$$"
	mkdir -p "$tmp_dir"
	trap 'rm -rf "$tmp_dir"' EXIT INT TERM

	archive_path="$tmp_dir/orbit-agent.tar.gz"
	checksums_path="$tmp_dir/checksums.txt"
	cli_path="$tmp_dir/orbitagent"

	echo "[orbit-agent] downloading package: $package_url"
	download_file "$package_url" "$archive_path"

	if [ -z "$ORBIT_PACKAGE_URL" ]; then
		echo "[orbit-agent] downloading checksums: $checksums_url"
		download_file "$checksums_url" "$checksums_path"

		expected_hash="$(awk '$2 == "'"$asset"'" {print $1}' "$checksums_path" | head -n 1)"
		if [ -z "$expected_hash" ]; then
			echo "[orbit-agent] error: cannot find checksum for $asset" >&2
			exit 1
		fi

		actual_hash="$(compute_sha256 "$archive_path")"
		if [ -z "$actual_hash" ]; then
			echo "[orbit-agent] error: missing sha256 tooling (sha256sum/shasum/openssl)" >&2
			exit 1
		fi

		if [ "$expected_hash" != "$actual_hash" ]; then
			echo "[orbit-agent] error: checksum mismatch for $asset" >&2
			echo "[orbit-agent] expected: $expected_hash" >&2
			echo "[orbit-agent] actual:   $actual_hash" >&2
			exit 1
		fi
	fi

	mkdir -p "$tmp_dir/extract"
	tar -xzf "$archive_path" -C "$tmp_dir/extract"

	binary_source="$tmp_dir/extract/orbit-agent"
	if [ ! -f "$binary_source" ]; then
		echo "[orbit-agent] error: extracted archive does not contain orbit-agent" >&2
		exit 1
	fi

	chmod +x "$binary_source"
	mkdir -p "$ORBIT_INSTALL_DIR"
	install_target="$ORBIT_INSTALL_DIR/orbit-agent"
	mv "$binary_source" "$install_target"
	chmod +x "$install_target"

	echo "[orbit-agent] downloading manager cli: $cli_url"
	download_file "$cli_url" "$cli_path"
	chmod +x "$cli_path"
	cli_target="$ORBIT_INSTALL_DIR/orbitagent"
	mv "$cli_path" "$cli_target"
	chmod +x "$cli_target"

	linked_to_path="false"
	if [ "$ORBIT_BIN_LINK_MODE" != "false" ]; then
		can_link="false"
		if [ "$ORBIT_BIN_LINK_MODE" = "true" ]; then
			can_link="true"
		elif [ -d "$ORBIT_LINK_DIR" ] && [ -w "$ORBIT_LINK_DIR" ]; then
			can_link="true"
		fi

		if [ "$can_link" = "true" ]; then
			if mkdir -p "$ORBIT_LINK_DIR" 2>/dev/null; then
				if ln -sf "$install_target" "$ORBIT_LINK_DIR/orbit-agent" 2>/dev/null &&
					ln -sf "$cli_target" "$ORBIT_LINK_DIR/orbitagent" 2>/dev/null; then
					linked_to_path="true"
					echo "[orbit-agent] linked binaries into: $ORBIT_LINK_DIR"
				fi
			fi
		fi
	fi

	if [ "$linked_to_path" = "false" ] && ! echo ":$PATH:" | grep -q ":$ORBIT_INSTALL_DIR:"; then
		echo "[orbit-agent] warning: $ORBIT_INSTALL_DIR is not in PATH"
		echo "[orbit-agent] hint: use full path: $cli_target status $ORBIT_INSTANCE_NAME"
		echo "[orbit-agent] hint: add PATH in shell profile: export PATH=\"$ORBIT_INSTALL_DIR:\$PATH\""
	fi

	# Use the newly installed orbitagent to add instance
	set -- add "$ORBIT_INSTANCE_NAME" \
		--server-url "$ORBIT_SERVER" \
		--backend-id "$ORBIT_BACKEND_ID" \
		--backend-token "$ORBIT_BACKEND_TOKEN" \
		--gateway-type "$ORBIT_GATEWAY_TYPE" \
		--gateway-url "$ORBIT_GATEWAY_URL"
	if [ -n "$ORBIT_GATEWAY_TOKEN" ]; then
		set -- "$@" --gateway-token "$ORBIT_GATEWAY_TOKEN"
	fi
	if [ -n "${ORBIT_MIHOMO_CONFIG:-}" ]; then
		set -- "$@" --mihomo-config "$ORBIT_MIHOMO_CONFIG"
	fi
	if [ -n "${ORBIT_CONFIG_CHECK_INTERVAL:-}" ]; then
		set -- "$@" --config-check-interval "$ORBIT_CONFIG_CHECK_INTERVAL"
	fi
	if [ "$ORBIT_AUTO_START" != "true" ]; then
		set -- "$@" --no-start
	fi
	"$cli_target" "$@"

	if [ "$ORBIT_AUTO_START" = "true" ]; then
		if "$cli_target" enable-autostart "$ORBIT_INSTANCE_NAME"; then
			echo "[orbit-agent] boot autostart enabled for: $ORBIT_INSTANCE_NAME"
		else
			echo "[orbit-agent] warning: failed to enable boot autostart (instance still configured)"
			echo "[orbit-agent] hint: run manually: $cli_target enable-autostart $ORBIT_INSTANCE_NAME"
		fi
	fi

	echo "[orbit-agent] installed to: $install_target"
	echo "[orbit-agent] management cli: $cli_target"
	echo "[orbit-agent] configured instance: $ORBIT_INSTANCE_NAME"
	echo "[orbit-agent] common commands:"
	echo "  orbitagent list"
	echo "  orbitagent start $ORBIT_INSTANCE_NAME"
	echo "  orbitagent stop $ORBIT_INSTANCE_NAME"
	echo "  orbitagent status $ORBIT_INSTANCE_NAME"
	echo "  orbitagent logs $ORBIT_INSTANCE_NAME"
	echo "  orbitagent upgrade"
	echo "  orbitagent remove $ORBIT_INSTANCE_NAME"
}

main "$@"
