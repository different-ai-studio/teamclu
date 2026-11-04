#!/bin/bash
set -euo pipefail

OSS_BASE="https://teamclu.ucar.cc"
REPO="different-ai-studio/teamclu"
TEAMCLU_SCRIPTS_RAW="${TEAMCLU_SCRIPTS_RAW:-https://raw.githubusercontent.com/${REPO}/main/scripts}"

source_install_mac_common() {
  local script_dir="${1:-}"
  local local_lib="${script_dir}/lib/install-mac-common.sh"
  if [[ -n "$script_dir" && -f "$local_lib" ]]; then
    # shellcheck source=lib/install-mac-common.sh
    source "$local_lib"
    return 0
  fi
  local tmp
  tmp="$(mktemp /tmp/teamclu-install-common-XXXXXX.sh)"
  if ! curl -fsSL "${TEAMCLU_SCRIPTS_RAW}/lib/install-mac-common.sh" -o "$tmp"; then
    rm -f "$tmp"
    echo "Error: failed to download install helpers from ${TEAMCLU_SCRIPTS_RAW}" >&2
    return 1
  fi
  # shellcheck source=/dev/null
  source "$tmp"
  rm -f "$tmp"
}

SCRIPT_DIR=""
REPO_ROOT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
source_install_mac_common "$SCRIPT_DIR"

echo "Installing macOS app (国内镜像)..."

VERSION=$(curl -sL "${OSS_BASE}/releases/latest.txt")
if [ -z "$VERSION" ]; then
  echo "Error: Could not fetch latest version from OSS"
  exit 1
fi
VERSION_NUM="${VERSION#v}"
echo "Latest version: ${VERSION}"

ARCH=$(uname -m)
case "$ARCH" in
  arm64)
    ARCH_SUFFIX="aarch64.dmg"
    echo "Detected Apple Silicon (arm64)"
    ;;
  x86_64)
    ARCH_SUFFIX="x64.dmg"
    echo "Detected Intel (x86_64)"
    ;;
  *)
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

if [[ -n "${LOCAL_DMG:-}" ]]; then
  if [[ ! -f "$LOCAL_DMG" ]]; then
    echo "Error: LOCAL_DMG not found: ${LOCAL_DMG}"
    exit 1
  fi
  DMG_FILE="$LOCAL_DMG"
  echo "Using local DMG: ${DMG_FILE}"
else
  DMG_URL="${DMG_URL:-}"
  if [[ -z "$DMG_URL" ]]; then
    DMG_URL=$(install_mac_resolve_oss_dmg_url "$OSS_BASE" "$VERSION" "$VERSION_NUM" "$ARCH_SUFFIX" "$REPO_ROOT" || true)
  fi
  if [[ -z "$DMG_URL" ]]; then
    echo "Error: Could not find a ${ARCH_SUFFIX} DMG for version ${VERSION} on OSS"
    echo "Hint: set APP_NAME (e.g. APP_NAME='Copilot 361') or DMG_URL to the full download URL"
    exit 1
  fi

  echo "Downloading from: ${DMG_URL}"
  DMG_FILE=$(mktemp /tmp/teamclu-install-XXXXXX.dmg)
  # `curl … | bash` hands curl the script as its stdin, so curl cannot see the
  # terminal and draws a 79-column bar. On a narrower terminal every redraw wraps,
  # and the bar piles up line by line. Read the width from the tty instead; with
  # no tty this does nothing and curl keeps its default.
  if cols=$(stty size </dev/tty 2>/dev/null | cut -d' ' -f2) && [ -n "$cols" ]; then export COLUMNS="$cols"; fi
  curl -L --progress-bar -o "$DMG_FILE" "$DMG_URL"
fi

echo "Mounting DMG..."
install_mac_mount_dmg "$DMG_FILE"

echo "Installing ${INSTALL_APP_NAME}..."
install_mac_copy_to_applications "$INSTALL_APP_PATH" "$INSTALL_APP_NAME"
install_mac_finish "$DMG_FILE" "$INSTALL_APP_NAME"
