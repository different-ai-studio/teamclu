#!/usr/bin/env bash
# Repair the managed agent runtime (Node.js + pi + MCP SDK) in branded amuxd homes.
#
# Symptom: onboarding stops at "安装 agent 运行时" with either
#   - a network/download failure, or
#   - "运行时已安装，但仍未报告就绪"
#
# Cause: each desktop brand keeps its own amuxd home (~/.amuxd for TeamClu,
# ~/.amuxd-teamclaw for TeamClaw dev builds, ~/.amuxd-copilot361 for Copilot361).
# A runtime downloaded into the wrong home — or a partial install in the right
# one — leaves the app stuck even though ~/.amuxd/cache may look complete.
#
# This script:
#   1. discovers every amuxd home in use (known brands + ~/.amuxd-* on disk)
#   2. runs `amuxd doctor` per home
#   3. when another home already has a satisfied runtime, copies cache/node + pi
#      npm artifacts first (fast, no network)
#   4. otherwise runs `amuxd install-pi` for that home
#
# Usage:
#   scripts/repair-agent-runtime.sh                 # interactive
#   scripts/repair-agent-runtime.sh -y              # apply without confirm
#   scripts/repair-agent-runtime.sh -n              # dry-run (list only)
#   scripts/repair-agent-runtime.sh -y --short-name teamclaw
#   scripts/repair-agent-runtime.sh -y --home ~/.amuxd-copilot361
#   scripts/repair-agent-runtime.sh -y --no-migrate # always download/install
#
# Environment:
#   AMUXD_BIN  path to amuxd (auto-detected when unset)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OFFICIAL_BRAND_SHORT_NAME="teamclu"
OFFICIAL_AMUXD_DIR="${HOME}/.amuxd"

yes_mode=0
dry_run=0
no_migrate=0
cli_short_name=""
cli_home=""

usage() {
  cat <<'EOF'
Usage: scripts/repair-agent-runtime.sh [options]

Options:
  -y              Apply without confirmation
  -n              Dry-run: show what would be done
  --short-name S  Repair only this brand (teamclu, teamclaw, copilot361, …)
  --home PATH     Repair only this amuxd home (overrides --short-name)
  --no-migrate    Skip copying cache from another satisfied home; always install-pi
  -h, --help      Show this help

Finds amuxd automatically from $AMUXD_BIN, PATH, the dev sidecar, or a local
.app bundle. Set AMUXD_BIN when auto-detection picks the wrong binary.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y) yes_mode=1; shift ;;
    -n) dry_run=1; shift ;;
    --no-migrate) no_migrate=1; shift ;;
    --short-name)
      cli_short_name="${2:-}"
      [[ -n "$cli_short_name" ]] || { echo "error: --short-name requires a value" >&2; exit 2; }
      shift 2
      ;;
    --home)
      cli_home="${2:-}"
      [[ -n "$cli_home" ]] || { echo "error: --home requires a path" >&2; exit 2; }
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

expand_path() {
  local p="$1"
  if [[ "$p" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$p" == "~/"* ]]; then
    printf '%s\n' "${HOME}/${p#~/}"
  else
    printf '%s\n' "$p"
  fi
}

is_official_brand() {
  [[ "$1" == "$OFFICIAL_BRAND_SHORT_NAME" ]]
}

amuxd_home_for_brand() {
  local short_name="$1"
  if is_official_brand "$short_name"; then
    printf '%s\n' "$OFFICIAL_AMUXD_DIR"
  else
    printf '%s/.amuxd-%s\n' "$HOME" "$short_name"
  fi
}

BRAND_SHORT_NAMES=()
BRAND_DISPLAY_NAMES=()
BRAND_SCHEMES=()

add_brand_profile() {
  local short_name="$1" display_name="$2" scheme="$3"
  local i seen=0
  for i in "${!BRAND_SHORT_NAMES[@]}"; do
    if [[ "${BRAND_SHORT_NAMES[$i]}" == "$short_name" ]]; then
      seen=1
      break
    fi
  done
  if [[ "$seen" -eq 0 ]]; then
    BRAND_SHORT_NAMES+=("$short_name")
    BRAND_DISPLAY_NAMES+=("$display_name")
    BRAND_SCHEMES+=("$scheme")
  fi
}

load_brand_profiles() {
  local line short_name display_name scheme
  while IFS=$'\t' read -r _ short_name display_name; do
    [[ -n "$short_name" ]] || continue
    scheme="$short_name"
    if [[ "$short_name" == "teamclaw" || "$short_name" == "teamclu" ]]; then
      scheme="teamclu"
    fi
    add_brand_profile "$short_name" "${display_name:-$short_name}" "$scheme"
  done < <(node "${SCRIPT_DIR}/lib/resolve-brand-profiles.mjs" 2>/dev/null || true)

  add_brand_profile "teamclu" "TeamClu" "teamclu"
  add_brand_profile "teamclaw" "TeamClaw" "teamclu"
  add_brand_profile "copilot361" "Copilot 361" "copilot361"
}

target_triple() {
  local arch os
  arch="$(uname -m)"
  case "$(uname -s)" in
    Darwin) printf '%s-apple-darwin\n' "$arch" ;;
    Linux) printf '%s-unknown-linux-gnu\n' "$arch" ;;
    MINGW*|MSYS*|CYGWIN*) printf '%s-pc-windows-msvc\n' "$arch" ;;
    *) printf '%s-unknown-%s\n' "$arch" "$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
  esac
}

find_amuxd_candidates() {
  local triple candidate app macos
  triple="$(target_triple)"

  candidate="${REPO_ROOT}/apps/desktop/binaries/amuxd-${triple}"
  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
  fi

  candidate="${REPO_ROOT}/.cargo-target/debug/amuxd"
  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
  fi
  candidate="${REPO_ROOT}/.cargo-target/release/amuxd"
  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
  fi

  if command -v amuxd >/dev/null 2>&1; then
    command -v amuxd
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    for app in "${HOME}/Applications"/*.app /Applications/*.app; do
      [[ -d "$app" ]] || continue
      macos="${app}/Contents/MacOS"
      for candidate in "${macos}/amuxd-${triple}" "${macos}/amuxd"; do
        if [[ -x "$candidate" ]]; then
          printf '%s\n' "$candidate"
        fi
      done
    done
  fi
}

amuxd_reports_managed_runtime() {
  local bin="$1"
  local json
  json="$(AMUXD_HOME="${OFFICIAL_AMUXD_DIR}" "$bin" doctor 2>/dev/null || true)"
  [[ -n "$json" ]] || return 1
  python3 - "$json" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
raise SystemExit(0 if isinstance(doc.get("node"), dict) else 1)
PY
}

find_amuxd_bin() {
  if [[ -n "${AMUXD_BIN:-}" ]]; then
    if [[ ! -x "${AMUXD_BIN}" ]]; then
      echo "error: AMUXD_BIN is set but not executable: ${AMUXD_BIN}" >&2
      return 1
    fi
    if ! amuxd_reports_managed_runtime "${AMUXD_BIN}"; then
      echo "warning: ${AMUXD_BIN} does not report managed Node/pi rows (app may be outdated)." >&2
      echo "warning: cache migration still works; install-pi needs a newer amuxd (dev sidecar or app update)." >&2
    fi
    printf '%s\n' "${AMUXD_BIN}"
    return 0
  fi

  local candidate chosen=""
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if amuxd_reports_managed_runtime "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    if [[ -z "$chosen" ]]; then
      chosen="$candidate"
    fi
  done < <(find_amuxd_candidates | awk '!seen[$0]++')

  if [[ -n "$chosen" ]]; then
    echo "warning: ${chosen} does not report managed Node/pi rows (app may be outdated)." >&2
    echo "warning: cache migration still works; install-pi needs a newer amuxd (dev sidecar or app update)." >&2
    printf '%s\n' "$chosen"
    return 0
  fi

  echo "error: could not find amuxd. Build the dev sidecar (pnpm tauri:dev) or set AMUXD_BIN." >&2
  return 1
}

doctor_json() {
  local home="$1"
  AMUXD_HOME="$home" "$AMUXD_BIN" doctor 2>/dev/null
}

runtime_satisfied_fs() {
  local home="$1" node_bin
  node_bin="$(find "${home}/cache/node" -path '*/bin/node' -type f 2>/dev/null | head -1 || true)"
  [[ -n "$node_bin" && -x "$node_bin" ]] || return 1
  [[ -d "${home}/cache/pi/node_modules/@earendil-works/pi-coding-agent" ]] || return 1
  [[ -d "${home}/cache/pi/node_modules/@modelcontextprotocol/sdk" ]] || return 1
}

runtime_satisfied() {
  local home="$1" json
  json="$(doctor_json "$home" || true)"
  if [[ -n "$json" ]]; then
    if python3 - "$json" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
if not isinstance(doc.get("node"), dict):
    raise SystemExit(2)
ok = doc.get("node", {}).get("satisfied") and doc.get("pi", {}).get("satisfied")
raise SystemExit(0 if ok else 1)
PY
    then
      return 0
    fi
    local rc=$?
    if [[ "$rc" -eq 2 ]]; then
      runtime_satisfied_fs "$home"
      return $?
    fi
    return 1
  fi
  runtime_satisfied_fs "$home"
}

runtime_status_line() {
  local home="$1" json
  json="$(doctor_json "$home" || true)"
  if [[ -n "$json" ]] && python3 - "$json" <<'PY'
import json, sys
raise SystemExit(0 if isinstance(json.loads(sys.argv[1]).get("node"), dict) else 1)
PY
  then
    python3 - "$home" "$json" <<'PY'
import json, sys
home, doc = sys.argv[1], json.loads(sys.argv[2])
node = doc.get("node", {})
pi = doc.get("pi", {})
state = "ready" if node.get("satisfied") and pi.get("satisfied") else "needs repair"
print(
    f"{home}: {state} "
    f"(node={'ok' if node.get('satisfied') else 'missing'}, "
    f"pi={'ok' if pi.get('satisfied') else 'missing'})"
)
PY
    return
  fi
  if runtime_satisfied_fs "$home"; then
    printf '%s: ready (filesystem check)\n' "$home"
  else
    printf '%s: needs repair (filesystem check)\n' "$home"
  fi
}

collect_target_homes() {
  TARGET_HOMES=()
  local i home seen u

  if [[ -n "$cli_home" ]]; then
    home="$(expand_path "$cli_home")"
    TARGET_HOMES+=("$home")
    return
  fi

  if [[ -n "$cli_short_name" ]]; then
    TARGET_HOMES+=("$(amuxd_home_for_brand "$cli_short_name")")
    return
  fi

  for i in "${!BRAND_SHORT_NAMES[@]}"; do
    home="$(amuxd_home_for_brand "${BRAND_SHORT_NAMES[$i]}")"
    if [[ -d "$home" || -f "$home/daemon.toml" ]]; then
      seen=0
      for u in "${TARGET_HOMES[@]:-}"; do
        [[ "$u" == "$home" ]] && seen=1 && break
      done
      if [[ "$seen" -eq 0 ]]; then
        TARGET_HOMES+=("$home")
      fi
    fi
  done

  while IFS= read -r home; do
    [[ -n "$home" ]] || continue
    seen=0
    for u in "${TARGET_HOMES[@]:-}"; do
      [[ "$u" == "$home" ]] && seen=1 && break
    done
    if [[ "$seen" -eq 0 ]]; then
      TARGET_HOMES+=("$home")
    fi
  done < <(compgen -G "${HOME}/.amuxd-*" 2>/dev/null || true)

  if [[ -d "$OFFICIAL_AMUXD_DIR" || -f "$OFFICIAL_AMUXD_DIR/daemon.toml" ]]; then
    seen=0
    for u in "${TARGET_HOMES[@]:-}"; do
      [[ "$u" == "$OFFICIAL_AMUXD_DIR" ]] && seen=1 && break
    done
    if [[ "$seen" -eq 0 ]]; then
      TARGET_HOMES+=("$OFFICIAL_AMUXD_DIR")
    fi
  fi
}

find_donor_home() {
  local target="$1" home
  for home in "${ALL_HOMES[@]:-}"; do
    [[ "$home" == "$target" ]] && continue
    runtime_satisfied "$home" || continue
    printf '%s\n' "$home"
    return 0
  done
  return 1
}

migrate_runtime_cache() {
  local donor="$1" recipient="$2"
  local donor_node recipient_node

  donor_node="${donor}/cache/node"
  recipient_node="${recipient}/cache/node"
  if [[ -d "$donor_node" && ! -d "${recipient_node}/$(basename "$(ls -1 "$donor_node" 2>/dev/null | head -1)")" ]]; then
    echo "  copy ${donor_node} → ${recipient}/cache/"
    if [[ "$dry_run" -eq 0 ]]; then
      mkdir -p "${recipient}/cache"
      cp -R "$donor_node" "${recipient}/cache/"
    fi
  fi

  if [[ -d "${donor}/cache/pi/node_modules" ]]; then
    echo "  copy ${donor}/cache/pi/npm artifacts → ${recipient}/cache/pi/"
    if [[ "$dry_run" -eq 0 ]]; then
      mkdir -p "${recipient}/cache/pi"
      for artifact in package.json package-lock.json node_modules; do
        if [[ -e "${donor}/cache/pi/${artifact}" ]]; then
          if [[ -d "${donor}/cache/pi/${artifact}" ]]; then
            rm -rf "${recipient}/cache/pi/${artifact}"
            cp -R "${donor}/cache/pi/${artifact}" "${recipient}/cache/pi/"
          else
            cp "${donor}/cache/pi/${artifact}" "${recipient}/cache/pi/"
          fi
        fi
      done
    fi
  fi
}

run_install_pi() {
  local home="$1"
  if ! amuxd_reports_managed_runtime "$AMUXD_BIN"; then
    echo "  error: ${AMUXD_BIN} is too old for managed install-pi." >&2
    echo "  update the desktop app, or run from a dev checkout:" >&2
    echo "    AMUXD_BIN=${REPO_ROOT}/apps/desktop/binaries/amuxd-$(target_triple) $0 -y --home ${home}" >&2
    return 1
  fi
  echo "  run AMUXD_HOME=${home} ${AMUXD_BIN} install-pi"
  if [[ "$dry_run" -eq 0 ]]; then
    AMUXD_HOME="$home" "$AMUXD_BIN" install-pi
  fi
}

repair_home() {
  local home="$1"
  echo "==> ${home}"

  if runtime_satisfied "$home"; then
    runtime_status_line "$home"
    echo "  already satisfied — skip"
    return 0
  fi

  runtime_status_line "$home"

  if [[ "$no_migrate" -eq 0 ]]; then
    local donor
    if donor="$(find_donor_home "$home")"; then
      echo "  migrate cache from ${donor}"
      migrate_runtime_cache "$donor" "$home"
      if runtime_satisfied "$home"; then
        echo "  repaired via cache migration"
        return 0
      fi
      echo "  cache migration was not enough — continuing with install-pi"
    fi
  fi

  run_install_pi "$home"

  if [[ "$dry_run" -eq 0 ]]; then
    if runtime_satisfied "$home"; then
      echo "  repaired via install-pi"
      return 0
    fi
    echo "  error: runtime still not satisfied after install-pi" >&2
    echo "  see ${home}/logs/amuxd.managed.log" >&2
    return 1
  fi

  echo "  would run install-pi (dry-run)"
  return 0
}

TARGET_HOMES=()
ALL_HOMES=()
failures=0

load_brand_profiles
AMUXD_BIN="$(find_amuxd_bin)"
echo "Using amuxd: ${AMUXD_BIN}"

collect_target_homes
if ((${#TARGET_HOMES[@]} == 0)); then
  echo "No amuxd homes found. Launch the desktop app once, or pass --home <path>." >&2
  exit 1
fi

ALL_HOMES=("${TARGET_HOMES[@]}")
# Donor search should include every home on disk, not only broken targets.
while IFS= read -r home; do
  [[ -n "$home" ]] || continue
  local_seen=0
  for u in "${ALL_HOMES[@]}"; do
    [[ "$u" == "$home" ]] && local_seen=1 && break
  done
  if [[ "$local_seen" -eq 0 ]]; then
    ALL_HOMES+=("$home")
  fi
done < <(compgen -G "${HOME}/.amuxd*" 2>/dev/null || true)

echo "Homes to inspect:"
for home in "${TARGET_HOMES[@]}"; do
  runtime_status_line "$home"
done

if [[ "$yes_mode" -eq 0 && "$dry_run" -eq 0 ]]; then
  echo
  read -r -p "Repair these homes? [y/N] " answer
  case "${answer:-}" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

for home in "${TARGET_HOMES[@]}"; do
  if ! repair_home "$home"; then
    failures=$((failures + 1))
  fi
done

echo
if [[ "$failures" -gt 0 ]]; then
  echo "Finished with ${failures} failure(s)." >&2
  exit 1
fi

if [[ "$dry_run" -eq 1 ]]; then
  echo "Dry-run complete."
else
  echo "Done. Restart the desktop app if it is still showing the onboarding error."
fi
