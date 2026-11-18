#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Match scripts/daemon-cargo.js (pnpm daemon:run) — never use stale target/debug/amuxd.
CARGO_TARGET_DIR="${ROOT_DIR}/.cargo-target"
export CARGO_TARGET_DIR
CONFIG_DIR="${HOME}/Library/Application Support/amux"
LOG_DIR="${CONFIG_DIR}/logs"
LOG_FILE="${LOG_DIR}/amuxd.log"

usage() {
  cat <<'EOF'
Usage: scripts/amuxdctl.sh <command> [options]

Commands:
  start       Start amuxd in the background (default)
  start --foreground
              Start amuxd in the foreground
  stop        Stop the running daemon
  restart     Restart the daemon
  status      Show daemon status
  logs        Tail the daemon log file

Options:
  --release   Use .cargo-target/release/amuxd (build if needed)
  --config P  Pass --config <path> to amuxd start

Examples:
  scripts/amuxdctl.sh start
  scripts/amuxdctl.sh restart
  RUST_LOG=amuxd=debug,agent_trace=info scripts/amuxdctl.sh restart
  scripts/amuxdctl.sh logs
  scripts/amuxdctl.sh start --foreground
  scripts/amuxdctl.sh start --release --config "$HOME/Library/Application Support/amux/daemon.toml"

Binary: .cargo-target/{debug,release}/amuxd (same as pnpm daemon:run; rebuilt on start/restart).
Logs:   ~/Library/Application Support/amux/logs/amuxd.log
EOF
}

ACTION="${1:-}"
if [[ -z "${ACTION}" || "${ACTION}" == "-h" || "${ACTION}" == "--help" ]]; then
  usage
  exit 0
fi
shift || true

USE_RELEASE=0
FOREGROUND=0
CONFIG_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      USE_RELEASE=1
      shift
      ;;
    --foreground)
      FOREGROUND=1
      shift
      ;;
    --config)
      CONFIG_PATH="${2:-}"
      if [[ -z "${CONFIG_PATH}" ]]; then
        echo "error: --config requires a path" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

cd "${ROOT_DIR}"

amuxd_bin() {
  printf '%s/%s/amuxd\n' "${CARGO_TARGET_DIR}" "$1"
}

cargo_build_amuxd() {
  local profile="$1"
  echo "==> building amuxd (${profile}) → $(amuxd_bin "${profile}")"
  cargo build -p amuxd $( [[ "${profile}" == "release" ]] && printf '%s' --release )
}

run_amuxd() {
  local profile="$1"
  shift
  local bin
  bin="$(amuxd_bin "${profile}")"
  if [[ ! -x "${bin}" ]]; then
    cargo_build_amuxd "${profile}"
  fi
  "${bin}" "$@"
}

start_daemon() {
  mkdir -p "${LOG_DIR}"
  local profile="$1"
  cargo_build_amuxd "${profile}"
  local start_args=(start)
  if [[ -n "${CONFIG_PATH}" ]]; then
    start_args+=(--config "${CONFIG_PATH}")
  fi

  if [[ "${FOREGROUND}" -eq 1 ]]; then
    echo "==> starting amuxd in foreground"
    run_amuxd "${profile}" "${start_args[@]}"
    return
  fi

  echo "==> starting amuxd in background"
  {
    run_amuxd "${profile}" "${start_args[@]}" --daemonize
  } >>"${LOG_FILE}" 2>&1

  echo "==> log file: ${LOG_FILE}"
  run_amuxd "${profile}" status || true
}

stop_daemon() {
  local profile="$1"
  echo "==> stopping amuxd"
  run_amuxd "${profile}" stop
}

status_daemon() {
  local profile="$1"
  run_amuxd "${profile}" status
}

restart_daemon() {
  local profile="$1"
  set +e
  run_amuxd "${profile}" stop >/dev/null 2>&1
  set -e
  start_daemon "${profile}"
}

tail_logs() {
  mkdir -p "${LOG_DIR}"
  touch "${LOG_FILE}"
  echo "==> tailing ${LOG_FILE}"
  tail -n 200 -f "${LOG_FILE}"
}

PROFILE="debug"
if [[ "${USE_RELEASE}" -eq 1 ]]; then
  PROFILE="release"
fi

case "${ACTION}" in
  start)
    start_daemon "${PROFILE}"
    ;;
  stop)
    stop_daemon "${PROFILE}"
    ;;
  restart)
    restart_daemon "${PROFILE}"
    ;;
  status)
    status_daemon "${PROFILE}"
    ;;
  logs)
    tail_logs
    ;;
  *)
    echo "error: unknown command: ${ACTION}" >&2
    usage
    exit 1
    ;;
esac
