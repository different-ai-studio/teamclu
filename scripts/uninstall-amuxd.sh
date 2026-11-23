#!/usr/bin/env bash
# Uninstall the locally-installed amuxd daemon and/or its managed pi runtime so
# the first-run setup + daemon-onboarding flow can be tested again from a clean
# state.
#
# Everything amuxd installs lives UNDER ~/.amuxd (per-user, NOT system-global):
#   ~/.amuxd/bin/amuxd          - the daemon binary (copied by the setup wizard)
#   ~/.amuxd/cache/node/        - the amuxd-managed Node (node_install)
#   ~/.amuxd/cache/pi/          - the amuxd-managed pi package (pi_install)
#   ~/.amuxd/daemon.toml, teams/<id>/... - identity + team state
#   ~/.amuxd/run/               - pid / sock / http port + token
# The background SERVICE definition lives OUTSIDE ~/.amuxd:
#   macOS:  ~/Library/LaunchAgents/cc.ucar.amuxd.plist  (+ launchctl registration)
#   Linux:  ~/.config/systemd/user/amuxd.service        (+ systemctl --user)
#
# Usage:
#   scripts/uninstall-amuxd.sh                 # full: stop service + remove ~/.amuxd (amuxd + pi + config)
#   scripts/uninstall-amuxd.sh --runtime-only  # only remove the managed Node + pi (keep amuxd + onboarding)
#   scripts/uninstall-amuxd.sh --keep-config   # remove binaries + service + runtime files, KEEP team identity (daemon.toml)
#
# Safe + idempotent: only touches amuxd-owned paths; missing items are skipped.

set -euo pipefail

AMUXD_DIR="$HOME/.amuxd"
LAUNCHD_LABEL="cc.ucar.amuxd"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
SYSTEMD_UNIT="$HOME/.config/systemd/user/amuxd.service"

mode="full"
case "${1:-}" in
  --runtime-only)  mode="runtime" ;;
  --keep-config)   mode="keep-config" ;;
  "")              mode="full" ;;
  *) echo "unknown option: $1" >&2; echo "usage: $0 [--runtime-only|--keep-config]" >&2; exit 2 ;;
esac

remove_runtime() {
  rm -rf "$AMUXD_DIR/cache/node" "$AMUXD_DIR/cache/pi"
  echo "  removed managed runtime (~/.amuxd/cache/node + ~/.amuxd/cache/pi)"
}

stop_service() {
  # Prefer the daemon's own deregister command when the binary is still present.
  if [ -x "$AMUXD_DIR/bin/amuxd" ]; then
    "$AMUXD_DIR/bin/amuxd" uninstall-service >/dev/null 2>&1 || true
  fi
  case "$(uname -s)" in
    Darwin)
      local uid; uid="$(id -u)"
      launchctl bootout "gui/${uid}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
      rm -f "$LAUNCHD_PLIST"
      echo "  stopped + removed launchd service ($LAUNCHD_LABEL)"
      ;;
    Linux)
      systemctl --user disable --now amuxd.service >/dev/null 2>&1 || true
      rm -f "$SYSTEMD_UNIT"
      echo "  stopped + removed systemd --user unit (amuxd.service)"
      ;;
    *)
      echo "  (note: stop the amuxd service manually on this OS, e.g. delete the scheduled task)"
      ;;
  esac
}

case "$mode" in
  runtime)
    echo "Uninstalling managed Node + pi only..."
    remove_runtime
    echo "Done. amuxd + onboarding state left intact."
    ;;
  keep-config)
    echo "Uninstalling amuxd binaries + service + pi runtime (keeping team identity)..."
    stop_service
    remove_runtime
    rm -f "$AMUXD_DIR/bin/amuxd" "$AMUXD_DIR/bin/amuxd.exe"
    rm -f "$AMUXD_DIR/amuxd.http.port" "$AMUXD_DIR/amuxd.http.token" \
          "$AMUXD_DIR/amuxd.pid" "$AMUXD_DIR/amuxd.sock"
    # v2 layout keeps the runtime files under run/.
    rm -rf "$AMUXD_DIR/run"
    echo "  removed amuxd binary + runtime files (kept daemon.toml + team state)"
    echo "Done."
    ;;
  full)
    echo "Full uninstall: stopping service and removing ~/.amuxd ..."
    stop_service
    rm -rf "$AMUXD_DIR"
    echo "  removed $AMUXD_DIR (amuxd binary, pi runtime, all config + runtime state)"
    echo "Done. Next app launch starts from a clean daemon state."
    ;;
esac
