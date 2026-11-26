#!/usr/bin/env bash
# Wipe all TeamClu / amuxd local config and cache so the next launch starts
# from a clean slate (first-run setup, daemon onboarding, login, etc.).
#
# Safe + idempotent: only touches TeamClu-owned paths; missing items are skipped.
#
# Usage:
#   scripts/reset-local-state.sh                 # interactive confirm
#   scripts/reset-local-state.sh -y              # skip confirm
#   scripts/reset-local-state.sh -n              # dry-run (list only)
#   scripts/reset-local-state.sh -y --short-name copilot361 --app-id com.copilot361.app
#   scripts/reset-local-state.sh -y --keep-workspace      # skip <workspace>/.<brand>
#   scripts/reset-local-state.sh -y --include-opencode   # also remove global OpenCode dirs
#   scripts/reset-local-state.sh -y --purge-workspaces   # delete workspace dirs whole
#
# Does NOT delete:
#   - Cloud account / team data (Supabase / Cloud API)
#   - Workspace content outside `.<brand>/` and the team-drive symlink
#   - The workspace directory itself — unless --purge-workspaces, which removes
#     the whole directory when it carries a workspace marker (teamclu.json /
#     teamclaw.json, a `.<brand>` dir, a team-drive link, or `knowledge/`).
#     `opencode.json` is not one: the app stopped writing it, and a directory
#     holding one may be the user's own OpenCode project.
#
# Covers the amuxd home-layout v2 (`docs/architecture/amuxd-home-layout-v2.md`):
#   - white-label daemon homes `~/.amuxd-<brand>` next to the official `~/.amuxd`
#   - `<workspace>/teamclu-team` symlink name is fixed across brands (into
#     `~/.amuxd*/teams/<id>/shared/`) — removed only when they are symlinks
#     (a real directory is left in place)
# plus the older product generations that may still be on disk
# (teamclaw / betly / amux / seamux).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OFFICIAL_BRAND_SHORT_NAME="teamclu"
OFFICIAL_AMUXD_DIR="${HOME}/.amuxd"
LAUNCHD_LABEL="cc.ucar.amuxd"
LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
SYSTEMD_UNIT="${HOME}/.config/systemd/user/amuxd.service"

# Legacy hardcoded keys in the frontend (session-store, etc.) survive white-label builds.
LEGACY_STORAGE_PREFIX="teamclu"

# Workspace team-drive symlink names (canonical + pre-rebrand leftovers).
# The link name is brand-independent — see TEAM_SHARED_DIR_NAME in
# crates/teamclu-runtime-env/src/storage_namespace.rs.
TEAM_SHARED_LINK_NAMES=(
  "teamclu-team"
  "teamclaw-team"
  "teamclaw"
)

yes_mode=0
dry_run=0
include_workspace=1
include_opencode=0
purge_workspaces=0
explicit_workspace=0
brand_only=0
cli_app_id=""
cli_short_name=""
WORKSPACE_PATHS=()
BRAND_APP_IDS=()
BRAND_SHORT_NAMES=()
BRAND_DISPLAY_NAMES=()
STORAGE_KEY_PREFIXES=()

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

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  -y, --yes                 Skip confirmation prompt
  -n, --dry-run             Print paths that would be removed; do not delete
  --include-workspace       Also remove workspace .<brand> dirs (default: on)
  --keep-workspace          Do not remove <workspace>/.<brand>
  --purge-workspaces        Remove the whole workspace directory (content included),
                            only when it carries a workspace marker; unmarked
                            directories fall back to dot-dir cleanup
  --workspace PATH          Extra workspace whose .<brand>/ dir to remove (repeatable)
  --app-id ID               Limit reset to one brand (e.g. com.copilot361.app)
  --short-name NAME         Limit reset to one brand (e.g. copilot361)
  --include-opencode        Also remove global OpenCode data (default: off — the
                            product no longer ships opencode; these dirs belong
                            to the user's own OpenCode install)
  --keep-opencode           Do not remove global OpenCode data (default)
  -h, --help                Show this help

Removes (user-level):
  - ~/.amuxd, ~/.amuxd-<brand>   amuxd daemon home (v2 layout: daemon.toml,
                                 device-id, run/, logs/, cache/, teams/)
                                 scoped --short-name/--app-id only touches that
                                 brand's amuxd home
  - ~/.teamclu, ~/.copilot361   per-brand desktop cache, secrets, local-cache.db
  - Tauri app data/cache/logs    per bundle id (e.g. com.copilot361.app)
  - WebKit / WebView2 profile     localStorage (auth session), IndexedDB, cookies
                                 plus an explicit purge of onboarding keys
                                 (<prefix>-setup-ok, <prefix>-onboarding-*,
                                 session) so AuthGate cannot skip first-run
                                 when a profile dir is locked by a running app
  - ~/.config/<shortName>        global skills, cron-global (Linux/macOS XDG path)
  - <workspace>/.<shortName>     per-workspace config (auto-discovered from webview)
  - <workspace>/teamclu-team     fixed team-drive symlink into ~/.amuxd*/teams/
                                 (plus legacy teamclaw-team / teamclaw; symlinks only)
  - Legacy ~/.config/amux, ~/Library/Application Support/{amux,teamclu,copilot361}
  - Legacy product generations   teamclaw / betly / amux / seamux profiles,
                                 ~/.teamclaw-seed (old P2P sync state)
  - ~/.opencode (+ ~/.local/share/opencode, ~/.config/opencode, ~/.cache/opencode)
    global OpenCode runtime and data (only with --include-opencode)

Quit the desktop app before running. The script unloads the amuxd launchd/systemd
job before killing the process so KeepAlive cannot recreate ~/.amuxd.

By default the script resets every detected brand profile (TeamClu, Copilot 361,
and any profile found in build.config.json or on disk).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) yes_mode=1 ;;
    -n|--dry-run) dry_run=1 ;;
    --include-workspace) include_workspace=1 ;;
    --keep-workspace) include_workspace=0 ;;
    --purge-workspaces) purge_workspaces=1; include_workspace=1 ;;
    --include-opencode) include_opencode=1 ;;
    --keep-opencode) include_opencode=0 ;;
    --workspace)
      shift
      [[ $# -gt 0 ]] || { echo "error: --workspace requires a path" >&2; exit 2; }
      WORKSPACE_PATHS+=("$(expand_path "$1")")
      include_workspace=1
      explicit_workspace=1
      ;;
    --app-id)
      shift
      [[ $# -gt 0 ]] || { echo "error: --app-id requires a value" >&2; exit 2; }
      cli_app_id="$1"
      brand_only=1
      ;;
    --short-name)
      shift
      [[ $# -gt 0 ]] || { echo "error: --short-name requires a value" >&2; exit 2; }
      cli_short_name="$1"
      brand_only=1
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

brand_profile_key() {
  # \x1f (unit separator), not \0: bash command substitution drops null bytes
  # and prints a warning for each one.
  printf '%s\x1f%s' "$1" "$2"
}

add_brand_profile() {
  local app_id="$1"
  local short_name="$2"
  local display_name="${3:-$short_name}"
  local key existing i

  [[ -n "$app_id" && -n "$short_name" ]] || return 0
  key="$(brand_profile_key "$app_id" "$short_name")"

  for i in "${!BRAND_APP_IDS[@]}"; do
    existing="$(brand_profile_key "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")"
    if [[ "$existing" == "$key" ]]; then
      return 0
    fi
  done

  BRAND_APP_IDS+=("$app_id")
  BRAND_SHORT_NAMES+=("$short_name")
  BRAND_DISPLAY_NAMES+=("$display_name")
}

add_storage_key_prefix() {
  local prefix="$1"
  local p

  [[ -n "$prefix" ]] || return 0
  for p in "${STORAGE_KEY_PREFIXES[@]:-}"; do
    [[ "$p" == "$prefix" ]] && return 0
  done
  STORAGE_KEY_PREFIXES+=("$prefix")
}

is_official_brand() {
  [[ "$1" == "$OFFICIAL_BRAND_SHORT_NAME" ]]
}

# Official → ~/.amuxd; white-label → ~/.amuxd-<brand>.
amuxd_home_for_brand() {
  local short_name="$1"
  if is_official_brand "$short_name"; then
    printf '%s\n' "$OFFICIAL_AMUXD_DIR"
  else
    printf '%s/.amuxd-%s\n' "$HOME" "$short_name"
  fi
}

collect_amuxd_homes() {
  AMUXD_HOMES=()
  TARGETED_AMUXD_PIDS=()
  local i home seen u

  for i in "${!BRAND_SHORT_NAMES[@]}"; do
    home="$(amuxd_home_for_brand "${BRAND_SHORT_NAMES[$i]}")"
    seen=0
    if ((${#AMUXD_HOMES[@]} > 0)); then
      for u in "${AMUXD_HOMES[@]}"; do
        if [[ "$u" == "$home" ]]; then
          seen=1
          break
        fi
      done
    fi
    if [[ "$seen" -eq 0 ]]; then
      AMUXD_HOMES+=("$home")
    fi
  done

  if [[ "$brand_only" -eq 0 ]]; then
    # Sweep every white-label daemon home ONLY on a full reset.
    while IFS= read -r home; do
      [[ -n "$home" ]] || continue
      seen=0
      if ((${#AMUXD_HOMES[@]} > 0)); then
        for u in "${AMUXD_HOMES[@]}"; do
          if [[ "$u" == "$home" ]]; then
            seen=1
            break
          fi
        done
      fi
      if [[ "$seen" -eq 0 ]]; then
        AMUXD_HOMES+=("$home")
      fi
    done < <(compgen -G "${HOME}/.amuxd-*" 2>/dev/null || true)
  fi
}

maybe_remove_team_shared_link() {
  local link="$1"
  if [[ -L "$link" ]]; then
    TARGETS+=("$link")
  elif [[ -d "$link" ]]; then
    echo "  note: ${link} is a real directory, not a symlink — leaving it" >&2
  fi
}

load_brand_profiles_from_build_config() {
  local line app_id short_name display_name

  while IFS=$'\t' read -r app_id short_name display_name; do
    [[ -n "$app_id" && -n "$short_name" ]] || continue
    add_brand_profile "$app_id" "$short_name" "$display_name"
  done < <(node "${SCRIPT_DIR}/lib/resolve-brand-profiles.mjs" 2>/dev/null || true)
}

infer_app_id_for_short_name() {
  local short_name="$1"
  case "$(uname -s)" in
    Darwin)
      if [[ -d "${HOME}/Library/WebKit/com.${short_name}.app" ]]; then
        printf 'com.%s.app\n' "$short_name"
        return 0
      fi
      if [[ -d "${HOME}/Library/Application Support/com.${short_name}.app" ]]; then
        printf 'com.%s.app\n' "$short_name"
        return 0
      fi
      ;;
  esac
  if [[ "$short_name" == "teamclu" ]]; then
    printf '%s\n' "com.teamclu.app"
  else
    printf '%s\n' "com.${short_name}.app"
  fi
}

# Older generations of the product that may still have state on disk:
# amux/seamux (original), teamclaw (pre-rename), betly (white-label).
# Bundle ids are the ones those builds actually shipped with.
add_legacy_generation_profiles() {
  add_brand_profile "com.teamclaw.app" "teamclaw" "TeamClaw"
  add_brand_profile "tech.teamclaw.mac" "teamclaw" "TeamClaw"
  add_brand_profile "cc.ucar.betly" "betly" "Betly"
  add_brand_profile "cn.mx5.betly-macos" "betly" "Betly"
  add_brand_profile "com.amux.app" "amux" "Amux"
  add_brand_profile "com.amux.mac" "amux" "Amux"
  add_brand_profile "com.seamux.app" "seamux" "Seamux"
}

detect_brand_profiles_from_disk() {
  local app_id short_name home_dir

  case "$(uname -s)" in
    Darwin)
      for app_id in com.teamclu.app com.copilot361.app; do
        short_name="${app_id#com.}"
        short_name="${short_name%.app}"
        if [[ -d "${HOME}/Library/WebKit/${app_id}" || -d "${HOME}/Library/Application Support/${app_id}" || -d "${HOME}/.${short_name}" ]]; then
          add_brand_profile "$app_id" "$short_name"
        fi
      done
      if [[ -d "${HOME}/Library/WebKit/teamclu" ]]; then
        add_brand_profile "com.teamclu.app" "teamclu" "TeamClu"
      fi
      ;;
  esac

  for home_dir in "${HOME}"/.[a-z0-9]*; do
    [[ -d "$home_dir" ]] || continue
    short_name="${home_dir##*/}"
    short_name="${short_name#.}"
    [[ "$short_name" == "amuxd" || "$short_name" == "config" || "$short_name" == "local" ]] && continue
    if [[ -f "${home_dir}/local-cache.db" || -d "${home_dir}/secrets" ]]; then
      app_id="$(infer_app_id_for_short_name "$short_name")"
      add_brand_profile "$app_id" "$short_name"
    fi
  done
}

resolve_brand_profiles() {
  BRAND_APP_IDS=()
  BRAND_SHORT_NAMES=()
  BRAND_DISPLAY_NAMES=()

  if [[ "$brand_only" -eq 1 ]]; then
    local short_name="${cli_short_name:-teamclu}"
    local app_id="${cli_app_id:-$(infer_app_id_for_short_name "$short_name")}"
    if [[ -n "$cli_app_id" && -z "$cli_short_name" ]]; then
      short_name="${cli_app_id#com.}"
      short_name="${short_name%.app}"
    fi
    add_brand_profile "$app_id" "$short_name"
  else
    load_brand_profiles_from_build_config
    add_legacy_generation_profiles
    detect_brand_profiles_from_disk
  fi

  if ((${#BRAND_APP_IDS[@]} == 0)); then
    add_brand_profile "com.teamclu.app" "teamclu" "TeamClu"
  fi

  STORAGE_KEY_PREFIXES=()
  add_storage_key_prefix "$LEGACY_STORAGE_PREFIX"
  local i
  for i in "${!BRAND_SHORT_NAMES[@]}"; do
    add_storage_key_prefix "${BRAND_SHORT_NAMES[$i]}"
  done
}

remove_path() {
  local target="$1"
  # -L too: a dangling symlink (e.g. <ws>/teamclu-team after ~/.amuxd is gone)
  # fails -e but still needs removing.
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    return 0
  fi
  if [[ "$dry_run" -eq 1 ]]; then
    echo "  [dry-run] would remove: $target"
    return 0
  fi
  if rm -rf "$target" 2>/dev/null; then
    if [[ -e "$target" || -L "$target" ]]; then
      echo "  warning: still present after remove: $target (quit the app and re-run)" >&2
      return 1
    fi
    echo "  removed: $target"
    return 0
  fi
  echo "  warning: failed to remove: $target (quit the app and re-run)" >&2
  return 1
}

# Keys that make AuthGate skip first-run onboarding (see AuthGate.tsx +
# stores/setup.ts + stores/onboarding.ts). Deleting the WebKit profile is the
# primary wipe; this surgical DELETE is the fallback when the profile dir is
# locked by a still-running desktop process.
purge_onboarding_keys_from_db() {
  local db="$1"
  local prefix="$2"
  [[ -f "$db" && -n "$prefix" ]] || return 0
  if [[ "$dry_run" -eq 1 ]]; then
    echo "  [dry-run] would purge onboarding keys (${prefix}-*) from: $db"
    return 0
  fi
  # Exact keys + prefix patterns. Keep the SQL boring: WebKit's ItemTable is
  # just (key, value); no schema drift across macOS versions we care about.
  sqlite3 "$db" <<SQL 2>/dev/null || true
DELETE FROM ItemTable WHERE
  key IN (
    '${prefix}-setup-ok',
    '${prefix}-onboarding-done',
    '${prefix}-onboarding-role',
    '${prefix}-onboarding-language-ack',
    '${prefix}-onboarding-setup-ack',
    '${prefix}-welcome-seen',
    '${prefix}-deps-setup-status',
    '${prefix}-daemon-onboarding-identity',
    '${prefix}-debug-force-setup',
    '${prefix}-local-daemon-actor-id'
  )
  OR key LIKE '${prefix}-onboarding-%'
  OR key LIKE '${prefix}.session%'
  OR key LIKE '${prefix}.sessionList%'
  OR key IN (
    'teamclaw-setup-ok',
    'teamclaw-onboarding-done',
    'teamclaw-onboarding-role',
    'teamclaw-onboarding-language-ack',
    'teamclaw-onboarding-setup-ack',
    'teamclaw-welcome-seen'
  )
  OR key LIKE 'teamclaw-onboarding-%'
  OR key LIKE 'teamclaw.session%';
SQL
}

# WebKit profiles sometimes land as mode 555 (or inherit no-write bits). SQLite
# needs a writable parent to drop its journal, and rm -rf needs write to unlink.
ensure_webkit_roots_writable() {
  local i root
  for i in "${!BRAND_APP_IDS[@]}"; do
    while IFS= read -r root; do
      [[ -n "$root" && -d "$root" ]] || continue
      if [[ "$dry_run" -eq 1 ]]; then
        echo "  [dry-run] would chmod -R u+w: $root"
        continue
      fi
      chmod -R u+w "$root" 2>/dev/null || true
    done < <(webkit_localstorage_roots_for_brand "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")
  done
}

purge_onboarding_localstorage() {
  local i root db prefix
  local purged=0

  echo "Purging onboarding keys from webview localStorage..."
  ensure_webkit_roots_writable
  for i in "${!BRAND_APP_IDS[@]}"; do
    prefix="${BRAND_SHORT_NAMES[$i]}"
    # Official builds unify storage under "teamclu"; also always sweep the
    # legacy prefix so upgrade leftovers cannot skip the wizard.
    while IFS= read -r root; do
      [[ -n "$root" && -d "$root" ]] || continue
      while IFS= read -r db; do
        [[ -f "$db" ]] || continue
        purge_onboarding_keys_from_db "$db" "$prefix"
        purge_onboarding_keys_from_db "$db" "$LEGACY_STORAGE_PREFIX"
        purged=1
        echo "  purged keys in: $db"
      done < <(find "$root" -name 'localstorage.sqlite3' 2>/dev/null)
    done < <(webkit_localstorage_roots_for_brand "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")
  done

  if [[ "$purged" -eq 0 ]]; then
    echo "  (no localstorage.sqlite3 found)"
  fi
}

count_remaining_onboarding_keys() {
  local i root db prefix count total=0
  for i in "${!BRAND_APP_IDS[@]}"; do
    prefix="${BRAND_SHORT_NAMES[$i]}"
    while IFS= read -r root; do
      [[ -n "$root" && -d "$root" ]] || continue
      while IFS= read -r db; do
        [[ -f "$db" ]] || continue
        count="$(sqlite3 "$db" "SELECT COUNT(*) FROM ItemTable WHERE key='${prefix}-setup-ok' OR key='${LEGACY_STORAGE_PREFIX}-setup-ok' OR key LIKE '${prefix}-onboarding-%' OR key LIKE '${LEGACY_STORAGE_PREFIX}-onboarding-%';" 2>/dev/null || echo 0)"
        total=$((total + count))
      done < <(find "$root" -name 'localstorage.sqlite3' 2>/dev/null)
    done < <(webkit_localstorage_roots_for_brand "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")
  done
  printf '%s\n' "$total"
}

verify_onboarding_state_cleared() {
  local remaining
  remaining="$(count_remaining_onboarding_keys)"
  if [[ "$remaining" -gt 0 ]]; then
    echo "  warning: ${remaining} onboarding/setup-ok key(s) still in webview localStorage" >&2
    echo "  AuthGate will skip first-run until those are gone. Quit TeamClu and re-run:" >&2
    echo "    pnpm reset:local -y" >&2
    return 1
  fi
  echo "  onboarding localStorage keys cleared"
  return 0
}

unload_amuxd_background_service() {
  case "$(uname -s)" in
    Darwin)
      local uid
      uid="$(id -u)"
      # Unload before killing the process: launchd KeepAlive respawns amuxd and
      # recreates ~/.amuxd if we pkill first.
      launchctl bootout "gui/${uid}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
      rm -f "$LAUNCHD_PLIST"
      ;;
    Linux)
      systemctl --user disable --now amuxd.service >/dev/null 2>&1 || true
      rm -f "$SYSTEMD_UNIT"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      ;;
    MINGW*|MSYS*|CYGWIN*)
      schtasks /Delete /F /TN amuxd >/dev/null 2>&1 || true
      ;;
  esac
}

wait_for_amuxd_exit() {
  local i
  for i in $(seq 1 25); do
    pgrep -x amuxd >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  pkill -9 -x amuxd >/dev/null 2>&1 || true
  sleep 0.5
}

amuxd_service_loaded() {
  case "$(uname -s)" in
    Darwin)
      local uid
      uid="$(id -u)"
      launchctl print "gui/${uid}/${LAUNCHD_LABEL}" >/dev/null 2>&1
      ;;
    Linux)
      systemctl --user is-active amuxd.service >/dev/null 2>&1
      ;;
    MINGW*|MSYS*|CYGWIN*)
      schtasks /Query /TN amuxd >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

verify_amuxd_fully_stopped() {
  local issues=0
  local home pid

  if [[ "$brand_only" -eq 0 ]]; then
    if pgrep -x amuxd >/dev/null 2>&1; then
      echo "  warning: amuxd process still running after stop/uninstall" >&2
      issues=1
    fi
  else
    for pid in "${TARGETED_AMUXD_PIDS[@]:-}"; do
      [[ -n "$pid" ]] || continue
      if amuxd_pid_is_alive "$pid"; then
        echo "  warning: targeted amuxd pid ${pid} is still running" >&2
        issues=1
      fi
    done
  fi

  # Service registration is shared across brands; only assert it is gone on a
  # full reset so a scoped white-label wipe does not fail when TeamClu's
  # LaunchAgent is still present.
  if [[ "$brand_only" -eq 0 ]]; then
    if [[ -f "$LAUNCHD_PLIST" || -f "$SYSTEMD_UNIT" ]]; then
      echo "  warning: amuxd service registration file still present" >&2
      issues=1
    fi

    if amuxd_service_loaded; then
      echo "  warning: amuxd background service still loaded in the session manager" >&2
      issues=1
    fi
  fi

  for home in "${AMUXD_HOMES[@]:-}"; do
    if [[ -e "$home" ]]; then
      echo "  warning: ${home} still exists (service may have respawned the daemon)" >&2
      issues=1
    fi
  done

  return "$issues"
}

amuxd_pid_is_alive() {
  local pid="$1" comm name
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
  name="${comm##*/}"
  [[ "$name" == "amuxd" || "$name" == amuxd-* || "$name" == "amuxd.exe" ]]
}

stop_amuxd_pid() {
  local pid="$1" i
  amuxd_pid_is_alive "$pid" || return 0
  kill "$pid" >/dev/null 2>&1 || true
  for i in $(seq 1 25); do
    amuxd_pid_is_alive "$pid" || return 0
    sleep 0.2
  done
  kill -9 "$pid" >/dev/null 2>&1 || true
  sleep 0.2
}

stop_amuxd_in_home() {
  local home="$1"
  local pid_file="${home}/run/amuxd.pid"
  local pid=""
  if [[ -f "$pid_file" ]]; then
    pid="$(tr -d '[:space:]' < "$pid_file")"
    if amuxd_pid_is_alive "$pid"; then
      TARGETED_AMUXD_PIDS+=("$pid")
    else
      pid=""
    fi
  fi
  if [[ -x "${home}/bin/amuxd" ]]; then
    AMUXD_HOME="$home" "${home}/bin/amuxd" stop >/dev/null 2>&1 || true
    AMUXD_HOME="$home" "${home}/bin/amuxd" uninstall-service >/dev/null 2>&1 || true
  fi
  if [[ -n "$pid" ]]; then
    stop_amuxd_pid "$pid"
  fi
}

stop_amuxd_service() {
  local home

  if [[ "$dry_run" -eq 1 ]]; then
    echo "  [dry-run] would stop and fully uninstall amuxd background service"
    return 0
  fi

  # 1. Drop launchd/systemd/schtasks registration first so KeepAlive cannot respawn.
  #    Scoped white-label resets skip this: the unit is shared and may belong to
  #    another brand still in use on the machine.
  if [[ "$brand_only" -eq 0 ]]; then
    unload_amuxd_background_service
  fi

  # 2. Graceful stop + redundant uninstall hook for each targeted daemon home.
  #    Desktop-managed installs often have no ~/.amuxd*/bin copy; that is fine.
  for home in "${AMUXD_HOMES[@]:-}"; do
    stop_amuxd_in_home "$home"
  done

  # 3. Kill leftover instances. Full reset always does; brand-scoped runs only
  #    when the targeted home still has a live binary/home (desktop-managed
  #    white-label may share the process name with official).
  if [[ "$brand_only" -eq 0 ]]; then
    pkill -x amuxd >/dev/null 2>&1 || true
    wait_for_amuxd_exit
    unload_amuxd_background_service
  fi
}

warn_running_app() {
  local found=0
  case "$(uname -s)" in
    Darwin)
      if pgrep -xq "TeamClu" 2>/dev/null; then found=1; fi
      if pgrep -xq "teamclu" 2>/dev/null; then found=1; fi
      if pgrep -f "Copilot 361" >/dev/null 2>&1; then found=1; fi
      ;;
    Linux)
      if pgrep -xf ".*[Tt]eam[Cc]lu.*" >/dev/null 2>&1; then found=1; fi
      if pgrep -xf ".*[Cc]opilot.*361.*" >/dev/null 2>&1; then found=1; fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if tasklist 2>/dev/null | grep -qiE "TeamClu|Copilot 361"; then found=1; fi
      ;;
  esac
  if [[ "$found" -eq 1 ]]; then
    echo "warning: a TeamClu / Copilot desktop app appears to be running — quit it first to avoid stale locks." >&2
  fi
}

tauri_paths_for_brand() {
  local app_id="$1"
  case "$(uname -s)" in
    Darwin)
      echo "${HOME}/Library/Application Support/${app_id}"
      echo "${HOME}/Library/Caches/${app_id}"
      echo "${HOME}/Library/Logs/${app_id}"
      ;;
    Linux)
      echo "${HOME}/.local/share/${app_id}"
      echo "${HOME}/.cache/${app_id}"
      echo "${HOME}/.local/state/${app_id}"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if [[ -n "${APPDATA:-}" ]]; then
        echo "${APPDATA}/${app_id}"
      fi
      if [[ -n "${LOCALAPPDATA:-}" ]]; then
        echo "${LOCALAPPDATA}/${app_id}"
        echo "${LOCALAPPDATA}/${app_id}/cache"
      fi
      ;;
  esac
}

# Webview profile data (localStorage auth session, IndexedDB, cookies). On macOS
# this lives under ~/Library/WebKit/<app>, NOT under Application Support.
desktop_webview_paths_for_brand() {
  local app_id="$1"
  local short_name="$2"
  case "$(uname -s)" in
    Darwin)
      echo "${HOME}/Library/WebKit/${short_name}"
      echo "${HOME}/Library/WebKit/${app_id}"
      echo "${HOME}/Library/WebKit/${short_name}-e2e"
      echo "${HOME}/Library/Caches/${short_name}"
      echo "${HOME}/Library/Caches/${app_id}"
      echo "${HOME}/Library/Caches/${short_name}-e2e"
      echo "${HOME}/Library/Preferences/${short_name}.plist"
      echo "${HOME}/Library/Preferences/${app_id}.plist"
      echo "${HOME}/Library/HTTPStorages/${short_name}"
      echo "${HOME}/Library/HTTPStorages/${short_name}.binarycookies"
      echo "${HOME}/Library/HTTPStorages/${app_id}"
      echo "${HOME}/Library/HTTPStorages/${app_id}.binarycookies"
      echo "${HOME}/Library/Saved Application State/${app_id}.savedState"
      ;;
    Linux)
      echo "${HOME}/.local/share/${short_name}"
      echo "${HOME}/.cache/${short_name}"
      echo "${HOME}/.local/state/${short_name}"
      echo "${HOME}/.config/${short_name}/WebKit"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if [[ -n "${LOCALAPPDATA:-}" ]]; then
        echo "${LOCALAPPDATA}/${short_name}"
        echo "${LOCALAPPDATA}/${short_name}/EBWebView"
        echo "${LOCALAPPDATA}/${app_id}/EBWebView"
      fi
      if [[ -n "${APPDATA:-}" ]]; then
        echo "${APPDATA}/${short_name}"
      fi
      ;;
  esac
}

xdg_paths_for_brand() {
  local short_name="$1"
  echo "${HOME}/.config/${short_name}"
}

legacy_config_paths_for_brand() {
  local short_name="$1"
  case "$(uname -s)" in
    Darwin)
      echo "${HOME}/Library/Application Support/amux"
      echo "${HOME}/Library/Application Support/${short_name}"
      ;;
    Linux)
      echo "${HOME}/.config/amux"
      echo "${HOME}/.config/${short_name}"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if [[ -n "${APPDATA:-}" ]]; then
        echo "${APPDATA}/amux"
        echo "${APPDATA}/${short_name}"
      fi
      ;;
  esac
}

home_dir_for_brand() {
  local short_name="$1"
  printf '%s/.%s\n' "$HOME" "$short_name"
}

opencode_paths() {
  # Official installer target (amuxd doctor / setup_install probe this path).
  echo "${HOME}/.opencode"
  echo "${HOME}/.local/share/opencode"
  echo "${HOME}/.config/opencode"
  echo "${HOME}/.cache/opencode"
  echo "${HOME}/.local/state/plugin-update-check.json"
}

resolve_workspace_dot_dir() {
  local ws="$1"
  local short_name="$2"
  ws="$(expand_path "$ws")"
  printf '%s/.%s\n' "$ws" "$short_name"
}

is_valid_workspace_path() {
  local ws="$1"
  [[ -n "$ws" && "$ws" == /* && "$ws" != "/" ]]
}

# Guard for --purge-workspaces: only delete a directory whole when it carries
# something the app itself wrote there. A brand-named directory without any
# marker is presumed to be the user's own and only gets dot-dir cleanup.
looks_like_workspace() {
  local ws="$1"
  local short_name link_name
  [[ -d "$ws" ]] || return 1
  [[ -f "$ws/teamclaw.json" || -f "$ws/teamclu.json" ]] && return 0
  [[ -d "$ws/knowledge" ]] && return 0
  for link_name in "${TEAM_SHARED_LINK_NAMES[@]}"; do
    [[ -e "$ws/$link_name" || -L "$ws/$link_name" ]] && return 0
  done
  for short_name in "${BRAND_SHORT_NAMES[@]}"; do
    [[ -d "$ws/.$short_name" || -f "$ws/${short_name}.json" ]] && return 0
  done
  return 1
}

webkit_localstorage_roots_for_brand() {
  local app_id="$1"
  local short_name="$2"
  case "$(uname -s)" in
    Darwin)
      echo "${HOME}/Library/WebKit/${app_id}"
      echo "${HOME}/Library/WebKit/${short_name}"
      ;;
    Linux)
      echo "${HOME}/.local/share/${short_name}"
      echo "${HOME}/.local/share/${app_id}"
      ;;
    *)
      ;;
  esac
}

discover_workspace_paths_from_db() {
  local db="$1"
  local prefix ws val key

  for prefix in "${STORAGE_KEY_PREFIXES[@]}"; do
    val="$(sqlite3 "$db" "SELECT value FROM ItemTable WHERE key='${prefix}-workspace-path' LIMIT 1;" 2>/dev/null || true)"
    if is_valid_workspace_path "$val"; then
      WORKSPACE_PATHS+=("$val")
    fi

    while IFS= read -r key; do
      [[ -n "$key" ]] || continue
      case "$key" in
        "${prefix}-selected-model::"*)
          ws="${key#"${prefix}-selected-model::"}"
          ws="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$ws" 2>/dev/null || printf '%s' "$ws")"
          is_valid_workspace_path "$ws" && WORKSPACE_PATHS+=("$ws")
          ;;
        "${prefix}-pre-team-model::"*)
          ws="${key#"${prefix}-pre-team-model::"}"
          ws="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$ws" 2>/dev/null || printf '%s' "$ws")"
          is_valid_workspace_path "$ws" && WORKSPACE_PATHS+=("$ws")
          ;;
      esac
    done < <(sqlite3 "$db" "SELECT key FROM ItemTable WHERE key LIKE '${prefix}-selected-model::%' OR key LIKE '${prefix}-pre-team-model::%';" 2>/dev/null || true)
  done
}

# Read persisted workspace paths from webview localStorage before we delete it.
discover_workspace_paths() {
  local i root db

  for i in "${!BRAND_APP_IDS[@]}"; do
    while IFS= read -r root; do
      [[ -n "$root" && -d "$root" ]] || continue
      while IFS= read -r db; do
        [[ -f "$db" ]] || continue
        discover_workspace_paths_from_db "$db"
      done < <(find "$root" -name 'localstorage.sqlite3' 2>/dev/null)
    done < <(webkit_localstorage_roots_for_brand "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")
  done
}

collect_workspace_dot_dir_targets() {
  local -a ws_paths=()
  local ws dot short_name display_name i

  if [[ "$explicit_workspace" -eq 0 ]]; then
    for i in "${!BRAND_DISPLAY_NAMES[@]}"; do
      display_name="${BRAND_DISPLAY_NAMES[$i]}"
      ws_paths+=("${HOME}/${display_name}")
      # Default workspaces created by dev / local-build flavors of the app.
      ws_paths+=("${HOME}/${display_name} Dev")
      ws_paths+=("${HOME}/${display_name} Local")
    done
    ws_paths+=("${HOME}/TeamClu")
    ws_paths+=("${HOME}/Copilot 361")
    discover_workspace_paths
  fi
  if ((${#WORKSPACE_PATHS[@]} > 0)); then
    ws_paths+=("${WORKSPACE_PATHS[@]}")
  fi

  local -a unique_ws=()
  local seen=0 u
  if ((${#ws_paths[@]} == 0)); then
    return 0
  fi
  for ws in "${ws_paths[@]}"; do
    [[ -n "$ws" ]] || continue
    is_valid_workspace_path "$ws" || continue
    seen=0
    if ((${#unique_ws[@]} > 0)); then
      for u in "${unique_ws[@]}"; do
        if [[ "$u" == "$ws" ]]; then
          seen=1
          break
        fi
      done
    fi
    if [[ "$seen" -eq 0 ]]; then
      unique_ws+=("$ws")
    fi
  done

  local link_name
  for ws in "${unique_ws[@]}"; do
    if [[ "$purge_workspaces" -eq 1 ]]; then
      if looks_like_workspace "$ws"; then
        TARGETS+=("$ws")
        continue
      fi
      if [[ -d "$ws" ]]; then
        echo "  note: ${ws} has no workspace marker — keeping the directory, cleaning dot-dirs only" >&2
      fi
    fi
    for short_name in "${BRAND_SHORT_NAMES[@]}"; do
      dot="$(resolve_workspace_dot_dir "$ws" "$short_name")"
      TARGETS+=("$dot")
      # Older reset script versions incorrectly looked for <shortName>-team.
      # Clean those misnamed symlinks when present.
      if ! is_official_brand "$short_name"; then
        maybe_remove_team_shared_link "${ws}/${short_name}-team"
      fi
    done
    # Team-drive entry point is a fixed name across brands (teamclu-team), plus
    # pre-rebrand leftovers. Removing the daemon home leaves these dangling, so
    # take the link too — but never a real directory of synced files.
    for link_name in "${TEAM_SHARED_LINK_NAMES[@]}"; do
      maybe_remove_team_shared_link "${ws}/${link_name}"
    done
    # Older white-label builds still wrote workspace metadata under teamclu keys
    # but may have kept the legacy .teamclu workspace dir name.
    dot="$(resolve_workspace_dot_dir "$ws" "$LEGACY_STORAGE_PREFIX")"
    TARGETS+=("$dot")
  done
}

collect_targets() {
  TARGETS=()
  local i p home

  collect_amuxd_homes
  for home in "${AMUXD_HOMES[@]:-}"; do
    TARGETS+=("$home")
  done

  if [[ "$brand_only" -eq 0 ]]; then
    TARGETS+=("${HOME}/.teamclaw-seed")
  fi

  for i in "${!BRAND_APP_IDS[@]}"; do
    TARGETS+=("$(home_dir_for_brand "${BRAND_SHORT_NAMES[$i]}")")
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(tauri_paths_for_brand "${BRAND_APP_IDS[$i]}")
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(desktop_webview_paths_for_brand "${BRAND_APP_IDS[$i]}" "${BRAND_SHORT_NAMES[$i]}")
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(xdg_paths_for_brand "${BRAND_SHORT_NAMES[$i]}")
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(legacy_config_paths_for_brand "${BRAND_SHORT_NAMES[$i]}")
    # macOS leaves orphaned cookie temp files next to the binarycookies store.
    if [[ "$(uname -s)" == "Darwin" ]]; then
      while IFS= read -r p; do
        [[ -n "$p" ]] && TARGETS+=("$p")
      done < <(compgen -G "${HOME}/Library/HTTPStorages/${BRAND_SHORT_NAMES[$i]}.binarycookies_tmp_*" 2>/dev/null || true)
    fi
  done

  if [[ "$include_opencode" -eq 1 ]]; then
    while IFS= read -r p; do
      [[ -n "$p" ]] && TARGETS+=("$p")
    done < <(opencode_paths)
  fi

  if [[ "$include_workspace" -eq 1 ]]; then
    collect_workspace_dot_dir_targets
  fi
}

dedupe_targets() {
  local -a unique=()
  local target u seen
  ((${#TARGETS[@]} > 0)) || return 0
  for target in "${TARGETS[@]}"; do
    seen=0
    if ((${#unique[@]} > 0)); then
      for u in "${unique[@]}"; do
        if [[ "$u" == "$target" ]]; then
          seen=1
          break
        fi
      done
    fi
    if [[ "$seen" -eq 0 ]]; then
      unique+=("$target")
    fi
  done
  TARGETS=("${unique[@]}")
}

confirm() {
  if [[ "$yes_mode" -eq 1 || "$dry_run" -eq 1 ]]; then
    return 0
  fi
  echo
  echo "This will permanently delete local TeamClu / amuxd state listed above"
  echo "(including webview login session, setup flags, and cached preferences)."
  echo "You will need to sign in and complete setup again."
  printf "Proceed? [y/N]: "
  local answer
  read -r answer
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
}

main() {
  warn_running_app
  resolve_brand_profiles

  echo "TeamClu local reset"
  echo "===================="
  echo "Brand profiles:"
  local i
  for i in "${!BRAND_APP_IDS[@]}"; do
    echo "  - ${BRAND_DISPLAY_NAMES[$i]} (${BRAND_APP_IDS[$i]}, .${BRAND_SHORT_NAMES[$i]})"
  done

  collect_targets
  dedupe_targets

  local existing=0
  local target
  echo
  echo "Targets:"
  for target in "${TARGETS[@]}"; do
    if [[ -e "$target" || -L "$target" ]]; then
      echo "  - $target"
      existing=1
    else
      echo "  - $target (absent)"
    fi
  done

  if [[ "$existing" -eq 0 && "$dry_run" -eq 0 ]]; then
    echo
    echo "Nothing to clear — already clean."
    exit 0
  fi

  confirm

  echo
  echo "Stopping amuxd service..."
  stop_amuxd_service

  # Surgical key delete BEFORE rm -rf: if the desktop app still holds the
  # WebKit profile open, directory removal can fail while sqlite UPDATE still
  # works — and leaving teamclu-setup-ok=1 makes AuthGate skip onboarding.
  echo
  purge_onboarding_localstorage

  echo
  echo "Removing local state..."
  for target in "${TARGETS[@]}"; do
    remove_path "$target" || true
  done

  if [[ "$dry_run" -eq 0 ]]; then
    echo
    echo "Verifying amuxd is fully uninstalled..."
    if ! verify_amuxd_fully_stopped; then
      local home
      echo "  retrying amuxd cleanup..."
      stop_amuxd_service
      for home in "${AMUXD_HOMES[@]:-}"; do
        remove_path "$home" || true
      done
      if ! verify_amuxd_fully_stopped; then
        echo
        echo "amuxd could not be fully removed. Quit TeamClu, run:" >&2
        echo "  launchctl bootout gui/\$(id -u)/${LAUNCHD_LABEL}" >&2
        echo "  pkill -x amuxd" >&2
        echo "then re-run: pnpm reset:local -y" >&2
        exit 1
      fi
    fi

    echo
    echo "Verifying first-run onboarding state is clear..."
    # One more key purge after rm, then assert setup-ok is gone.
    purge_onboarding_localstorage >/dev/null
    if ! verify_onboarding_state_cleared; then
      exit 1
    fi
  fi

  echo
  if [[ "$dry_run" -eq 1 ]]; then
    echo "Dry-run complete. Re-run with -y to apply."
  else
    echo "Done. Launch the desktop app (without --skip-setup) to start from a clean local state."
  fi
}

main
