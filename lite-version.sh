#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# s.Orchestrator Lite — single-file bash version, sequential deployment
# ---------------------------------------------------------------------------

ORIGINAL_ARGS=("$@")

# --- Self-update check ------------------------------------------------------
SELF_UPDATE_URL="https://raw.githubusercontent.com/scolastico-dev/s.Orchestrator/main/lite-version.sh"

self_update_check() {
  local self_path
  self_path="$(realpath "$0" 2>/dev/null || true)"
  # Skip if not a real file on disk (e.g. piped via curl | bash)
  [[ -z "$self_path" || ! -f "$self_path" ]] && return
  # Skip if curl is unavailable
  command -v curl &>/dev/null || return
  # Skip if no md5 tool is available
  command -v md5sum &>/dev/null || command -v md5 &>/dev/null || return

  local latest
  latest="$(curl -sSfL "$SELF_UPDATE_URL" 2>/dev/null || true)"
  [[ -z "$latest" ]] && return

  local current_md5 latest_md5
  if command -v md5sum &>/dev/null; then
    current_md5="$(md5sum "$self_path" | awk '{print $1}')"
    latest_md5="$(printf '%s' "$latest" | md5sum | awk '{print $1}')"
  else
    current_md5="$(md5 -q "$self_path")"
    latest_md5="$(printf '%s' "$latest" | md5 -q)"
  fi

  [[ "$current_md5" == "$latest_md5" ]] && return

  echo ""
  echo "  A newer version of s.Orchestrator Lite is available!"
  read -r -p "  Update now? [y/N] " _upd_answer || _upd_answer=""
  if [[ "$_upd_answer" =~ ^[Yy]$ ]]; then
    printf '%s\n' "$latest" > "$self_path"
    chmod +x "$self_path"
    echo "  Updated! Restarting..."
    exec "$self_path" "${ORIGINAL_ARGS[@]}"
  fi
  echo ""
}

self_update_check

# --- Dependency check -------------------------------------------------------
MISSING=()
for cmd in ssh scp ssh-keyscan ssh-keygen jq; do
  command -v "$cmd" &>/dev/null || MISSING+=("$cmd")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: Required tools not found: ${MISSING[*]}" >&2
  exit 1
fi

# --- Defaults ---------------------------------------------------------------
CONFIG_PATH="config.json"
ASSETS_DIR="assets"
SCRIPTS_DIR="scripts"
REMOTE_PATH="/tmp/s-orchestrator"
LOG_DIR="logs"
SKIP_CONFIRM=0
DRY_RUN=0
EXEC_CMD=""
SERVERS_FILTER=""

# --- CLI parsing ------------------------------------------------------------
usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  -c, --config <path>       path to config JSON file            (default: config.json)
  -y, --skip-confirm        skip confirmation after connection tests
  -n, --dry-run             test connections, do not deploy
  --log-dir <path>          directory for per-server log files  (default: logs)
  --assets-dir <path>       local assets directory to upload    (default: assets)
  --scripts-dir <path>      local scripts directory             (default: scripts)
  --remote-path <path>      remote working directory            (default: /tmp/s-orchestrator)
  --exec <command>          run one command instead of the scripts dir
                            (assets and scripts are still uploaded)
  --servers <names>         comma-separated list of server names to target
  -h, --help                display this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--config)        CONFIG_PATH="$2"; shift 2 ;;
    -y|--skip-confirm)  SKIP_CONFIRM=1; shift ;;
    -n|--dry-run)       DRY_RUN=1; shift ;;
    --log-dir)          LOG_DIR="$2"; shift 2 ;;
    --assets-dir)       ASSETS_DIR="$2"; shift 2 ;;
    --scripts-dir)      SCRIPTS_DIR="$2"; shift 2 ;;
    --remote-path)      REMOTE_PATH="$2"; shift 2 ;;
    --exec)             EXEC_CMD="$2"; shift 2 ;;
    --servers)          SERVERS_FILTER="$2"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# --- Config validation ------------------------------------------------------
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "ERROR: Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

if ! jq empty "$CONFIG_PATH" 2>/dev/null; then
  echo "ERROR: Config file is not valid JSON: $CONFIG_PATH" >&2
  exit 1
fi

# Validate each server has required 'ip' field
INVALID=$(jq -r 'to_entries[] | select(.value.ip == null or .value.ip == "") | .key' "$CONFIG_PATH")
if [[ -n "$INVALID" ]]; then
  echo "ERROR: Missing required 'ip' field for servers: $INVALID" >&2
  exit 1
fi

# --- Build server list (with optional filter) --------------------------------
mapfile -t ALL_SERVERS < <(jq -r 'keys[]' "$CONFIG_PATH")

if [[ -n "$SERVERS_FILTER" ]]; then
  IFS=',' read -ra FILTER_LIST <<< "$SERVERS_FILTER"
  SERVERS=()
  UNKNOWN=()
  for _name in "${FILTER_LIST[@]}"; do
    _name="${_name// /}"  # trim spaces
    if jq -e --arg n "$_name" '.[$n]' "$CONFIG_PATH" &>/dev/null; then
      SERVERS+=("$_name")
    else
      UNKNOWN+=("$_name")
    fi
  done
  if [[ ${#UNKNOWN[@]} -gt 0 ]]; then
    echo "ERROR: Unknown server(s): ${UNKNOWN[*]}" >&2
    exit 1
  fi
else
  SERVERS=("${ALL_SERVERS[@]}")
fi

# --- Collect scripts --------------------------------------------------------
SCRIPTS=()
if [[ -d "$SCRIPTS_DIR" ]]; then
  while IFS= read -r -d '' f; do
    SCRIPTS+=("$(basename "$f")")
  done < <(find "$SCRIPTS_DIR" -maxdepth 1 -name '*.sh' -print0 | sort -z)
fi

# --- Setup log dir ----------------------------------------------------------
mkdir -p "$LOG_DIR"

# --- Helpers ----------------------------------------------------------------
log_server() {
  local name="$1" msg="$2"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$ts] [$name] $msg"
  echo "[$ts] $msg" >> "$LOG_DIR/$name.log"
}

ssh_args() {
  # Usage: ssh_args <name>  — prints ssh option flags
  local name="$1"
  local port user key_file known_hosts_file
  port="$(jq -r --arg n "$name" '.[$n].port // 22' "$CONFIG_PATH")"
  user="$(jq -r --arg n "$name" '.[$n].user // "root"' "$CONFIG_PATH")"
  key_file="$(jq -r --arg n "$name" '.[$n].keyFile // empty' "$CONFIG_PATH" 2>/dev/null || true)"
  known_hosts_file="$(jq -r --arg n "$name" '.[$n].knownHostsFile // empty' "$CONFIG_PATH" 2>/dev/null || true)"

  local args=(-o StrictHostKeyChecking=yes -o LogLevel=error -p "$port")
  [[ -n "$known_hosts_file" ]] && args+=(-o "UserKnownHostsFile=$known_hosts_file")
  [[ -n "$key_file" ]] && args+=(-i "$key_file")
  printf '%s\n' "${args[@]}"
}

# --- Host key enforcement (TOFU) --------------------------------------------
KNOWN_HOSTS="$HOME/.ssh/known_hosts"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
[[ -f "$KNOWN_HOSTS" ]] || { touch "$KNOWN_HOSTS"; chmod 600 "$KNOWN_HOSTS"; }

enforce_host_keys() {
  local mismatches=()

  # Phase 1: TOFU — fetch and confirm all key types for servers with no stored keys
  for name in "${SERVERS[@]}"; do
    local key_count
    key_count="$(jq -r --arg n "$name" '.[$n].hostKeys // [] | length' "$CONFIG_PATH")"
    [[ "$key_count" -gt 0 ]] && continue

    local ip port
    ip="$(jq -r --arg n "$name" '.[$n].ip' "$CONFIG_PATH")"
    port="$(jq -r --arg n "$name" '.[$n].port // 22' "$CONFIG_PATH")"

    echo "[host-keys] Fetching host keys for $name ($ip:$port)..."
    local raw_output
    raw_output="$(ssh-keyscan -T 10 -p "$port" "$ip" 2>/dev/null | grep -v '^#' || true)"
    if [[ -z "$raw_output" ]]; then
      echo "ERROR: Could not fetch host keys for '$name' ($ip:$port). Is the server reachable?" >&2
      exit 1
    fi

    # Build a JSON array of "keytype base64" strings from all returned key types
    local keys_json="[" first=1
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      local kt k
      kt="$(awk '{print $2}' <<<"$line")"
      k="$(awk '{print $3}' <<<"$line")"
      [[ -z "$kt" || -z "$k" ]] && continue
      [[ "$first" -eq 0 ]] && keys_json+=","
      keys_json+="\"$kt $k\""
      first=0
    done <<<"$raw_output"
    keys_json+="]"

    local key_count_found first_line first_type first_preview
    key_count_found="$(echo "$raw_output" | grep -c .)"
    first_line="$(echo "$raw_output" | head -1)"
    first_type="$(awk '{print $2}' <<<"$first_line")"
    first_preview="$(awk '{print $3}' <<<"$first_line" | cut -c1-30)"

    echo ""
    echo "  NEW HOST KEYS DETECTED"
    echo "  Server : $name ($ip:$port)"
    echo "  Keys   : $key_count_found type(s) — $first_type ${first_preview}..."
    echo ""
    read -r -p "  Save these host keys to config? [y/N] " answer || answer=""
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
      echo "Deployment aborted: user declined to save host keys." >&2
      exit 1
    fi

    if [[ "$DRY_RUN" -eq 0 ]]; then
      local tmp
      tmp="$(mktemp)"
      jq --arg n "$name" --argjson keys "$keys_json" '.[$n].hostKeys = $keys' "$CONFIG_PATH" > "$tmp"
      mv "$tmp" "$CONFIG_PATH"
    fi
  done

  # Phase 2: verify each stored key type against known_hosts; collect all mismatches
  for name in "${SERVERS[@]}"; do
    local ip port
    ip="$(jq -r --arg n "$name" '.[$n].ip' "$CONFIG_PATH")"
    port="$(jq -r --arg n "$name" '.[$n].port // 22' "$CONFIG_PATH")"

    # Use [ip]:port format for non-standard ports — plain ip only matches port-22 entries
    local ssh_host host_prefix
    if [[ "$port" -eq 22 ]]; then
      ssh_host="$ip"
      host_prefix="$ip"
    else
      ssh_host="[$ip]:$port"
      host_prefix="[$ip]:$port"
    fi

    # Fetch all known_hosts entries for this host in one call
    local keygen_out
    keygen_out="$(ssh-keygen -F "$ssh_host" -f "$KNOWN_HOSTS" 2>/dev/null || true)"

    # Iterate over every stored key type
    while IFS= read -r stored_key; do
      [[ -z "$stored_key" ]] && continue
      local key_type just_key
      key_type="${stored_key%% *}"
      just_key="${stored_key##* }"

      # Find the known_hosts line for this key type (skip comment lines)
      local existing_key_data
      existing_key_data="$(echo "$keygen_out" | grep -v '^#' | awk -v kt="$key_type" '$2==kt{print $3}' | head -1)"

      if [[ -n "$existing_key_data" ]]; then
        # This key type is already in known_hosts — check for mismatch
        if [[ "$existing_key_data" != "$just_key" ]]; then
          local fix_cmd
          if [[ "$port" -eq 22 ]]; then
            fix_cmd="  ssh-keygen -R $ip"
          else
            fix_cmd="  ssh-keygen -R $ip\n  ssh-keygen -R [$ip]:$port"
          fi
          mismatches+=("[SECURITY] Host key mismatch for '$name' ($ip), key type $key_type!
The $key_type key in your config does NOT match $KNOWN_HOSTS.
To fix, remove the conflicting entry:
$fix_cmd")
        fi
      else
        # Key type not yet in known_hosts — add it
        if [[ "$DRY_RUN" -eq 0 ]]; then
          echo "$host_prefix $stored_key" >> "$KNOWN_HOSTS"
        fi
      fi
    done < <(jq -r --arg n "$name" '.[$n].hostKeys // [] | .[]' "$CONFIG_PATH")
  done

  if [[ ${#mismatches[@]} -gt 0 ]]; then
    echo "" >&2
    for m in "${mismatches[@]}"; do
      echo "$m" >&2
      echo "" >&2
    done
    exit 1
  fi
}

# --- Connection test --------------------------------------------------------
test_connection() {
  local name="$1"
  local ip user port
  ip="$(jq -r --arg n "$name" '.[$n].ip' "$CONFIG_PATH")"
  user="$(jq -r --arg n "$name" '.[$n].user // "root"' "$CONFIG_PATH")"
  port="$(jq -r --arg n "$name" '.[$n].port // 22' "$CONFIG_PATH")"

  log_server "$name" "Checking connection..."

  local args=()
  while IFS= read -r arg; do
    args+=("$arg")
  done < <(ssh_args "$name")
  args+=(-o BatchMode=yes -o ConnectTimeout=10)

  if ssh "${args[@]}" "${user}@${ip}" exit &>/dev/null; then
    log_server "$name" "Connection OK"
    return 0
  else
    log_server "$name" "Connection FAILED"
    return 1
  fi
}

# --- Deploy one server ------------------------------------------------------
deploy_server() {
  local name="$1"
  local ip user port
  ip="$(jq -r --arg n "$name" '.[$n].ip' "$CONFIG_PATH")"
  user="$(jq -r --arg n "$name" '.[$n].user // "root"' "$CONFIG_PATH")"
  port="$(jq -r --arg n "$name" '.[$n].port // 22' "$CONFIG_PATH")"

  local ssh_opts=()
  while IFS= read -r arg; do
    ssh_opts+=("$arg")
  done < <(ssh_args "$name")

  local scp_port_arg=(-P "$port")
  local scp_opts=(-o StrictHostKeyChecking=yes -o LogLevel=error)
  local known_hosts_file key_file
  known_hosts_file="$(jq -r --arg n "$name" '.[$n].knownHostsFile // empty' "$CONFIG_PATH" 2>/dev/null || true)"
  key_file="$(jq -r --arg n "$name" '.[$n].keyFile // empty' "$CONFIG_PATH" 2>/dev/null || true)"
  [[ -n "$known_hosts_file" ]] && scp_opts+=(-o "UserKnownHostsFile=$known_hosts_file")
  [[ -n "$key_file" ]] && scp_opts+=(-i "$key_file")

  local asset_dir_name scripts_dir_name
  asset_dir_name="$(basename "$ASSETS_DIR")"
  scripts_dir_name="$(basename "$SCRIPTS_DIR")"

  # Build env string from injected + server env vars
  local env_pairs=()
  env_pairs+=("SERVER_NAME=$name")
  env_pairs+=("SERVER_IP=$ip")
  env_pairs+=("SERVER_USER=$user")
  env_pairs+=("SERVER_SSH_PORT=$port")
  env_pairs+=("ASSET_DIR=$REMOTE_PATH/$asset_dir_name")
  env_pairs+=("SCRIPT_DIR=$REMOTE_PATH/$scripts_dir_name")

  # Merge server-defined env vars (may override above)
  while IFS='=' read -r k v; do
    env_pairs+=("$k=$v")
  done < <(jq -r --arg n "$name" '.[$n].env // {} | to_entries[] | "\(.key)=\(.value)"' "$CONFIG_PATH")

  # Build env prefix for shell (single-quote values, escape internal single quotes)
  local env_string=""
  for pair in "${env_pairs[@]}"; do
    local k="${pair%%=*}"
    local v="${pair#*=}"
    local escaped_v="${v//\'/\'\\\'\'}"
    env_string+="$k='$escaped_v' "
  done

  # Step 1: create remote base dir
  log_server "$name" "Creating remote base directory..."
  ssh "${ssh_opts[@]}" "${user}@${ip}" "mkdir -p ${REMOTE_PATH}" \
    >> "$LOG_DIR/$name.log" 2>&1

  # Step 2: upload assets (if directory exists)
  if [[ -d "$ASSETS_DIR" ]]; then
    log_server "$name" "Uploading assets..."
    scp "${scp_opts[@]}" "${scp_port_arg[@]}" -r \
      "$ASSETS_DIR" "${user}@${ip}:${REMOTE_PATH}/" \
      >> "$LOG_DIR/$name.log" 2>&1
  fi

  # Step 3: upload scripts dir (if exec mode or scripts exist)
  if [[ -d "$SCRIPTS_DIR" && ( -n "$EXEC_CMD" || ${#SCRIPTS[@]} -gt 0 ) ]]; then
    log_server "$name" "Uploading scripts..."
    scp "${scp_opts[@]}" "${scp_port_arg[@]}" -r \
      "$SCRIPTS_DIR" "${user}@${ip}:${REMOTE_PATH}/" \
      >> "$LOG_DIR/$name.log" 2>&1
  fi

  # Step 4: run command(s)
  if [[ -n "$EXEC_CMD" ]]; then
    log_server "$name" "Running: $EXEC_CMD"
    local cmd="cd ${REMOTE_PATH} && ${env_string}${EXEC_CMD}"
    local ssh_rc=0
    ssh "${ssh_opts[@]}" -tt "${user}@${ip}" "$cmd" 2>&1 \
      | tee -a "$LOG_DIR/$name.log" \
      | sed "s/^/[$name] /" \
      || ssh_rc="${PIPESTATUS[0]}"
    if [[ "$ssh_rc" -ne 0 ]]; then
      return "$ssh_rc"
    fi
  else
    for script in "${SCRIPTS[@]}"; do
      log_server "$name" "Running: $script"
      local cmd="cd ${REMOTE_PATH} && chmod +x ./${scripts_dir_name}/${script} && ${env_string}./${scripts_dir_name}/${script}"
      local ssh_rc=0
      ssh "${ssh_opts[@]}" -tt "${user}@${ip}" "$cmd" 2>&1 \
        | tee -a "$LOG_DIR/$name.log" \
        | sed "s/^/[$name] /" \
        || ssh_rc="${PIPESTATUS[0]}"
      if [[ "$ssh_rc" -ne 0 ]]; then
        return "$ssh_rc"
      fi
    done
  fi

  # Step 5: cleanup
  log_server "$name" "Cleaning up remote directory..."
  ssh "${ssh_opts[@]}" "${user}@${ip}" "rm -rf ${REMOTE_PATH}" \
    >> "$LOG_DIR/$name.log" 2>&1

  log_server "$name" "COMPLETED SUCCESSFULLY"
}

# --- Main -------------------------------------------------------------------
echo "=== s.Orchestrator Lite ==="
echo ""

# Enforce host keys
enforce_host_keys

if [[ ${#SERVERS[@]} -eq 0 ]]; then
  echo "ERROR: No servers found in config." >&2
  exit 1
fi

# Test all connections sequentially
CONNECTION_FAILED=0
for name in "${SERVERS[@]}"; do
  if ! test_connection "$name"; then
    CONNECTION_FAILED=1
  fi
done

if [[ "$CONNECTION_FAILED" -eq 1 ]]; then
  echo "ERROR: One or more connection tests failed. Aborting." >&2
  exit 1
fi

# Confirmation prompt
if [[ "$SKIP_CONFIRM" -eq 0 ]]; then
  echo ""
  read -r -p "All connections OK. Start deployment? [y/N] " answer || answer=""
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "Deployment aborted by user." >&2
    exit 1
  fi
fi

echo ""

# Deploy to each server sequentially
FAILED_SERVERS=()
for name in "${SERVERS[@]}"; do
  echo "--- Deploying to: $name ---"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log_server "$name" "[DRY RUN] Would deploy to this server"
    continue
  fi

  if deploy_server "$name"; then
    :
  else
    log_server "$name" "DEPLOYMENT FAILED"
    FAILED_SERVERS+=("$name")
  fi
done

echo ""
if [[ ${#FAILED_SERVERS[@]} -gt 0 ]]; then
  echo "=== COMPLETED WITH ERRORS ==="
  echo "Failed servers: ${FAILED_SERVERS[*]}"
  exit 1
else
  echo "=== ALL DEPLOYMENTS COMPLETED SUCCESSFULLY ==="
fi
