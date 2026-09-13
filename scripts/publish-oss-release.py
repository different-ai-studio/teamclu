#!/usr/bin/env python3
"""Assemble latest.json + the release page for a brand and publish them to OSS.

Runs in the publish-manifest job of .github/workflows/release-oss.yml. Reads the
per-brand context exported by .github/actions/brand-setup (APP_NAME, APP_SLUG,
OSS_*, CDN_BASE) plus build.config.json / brand-page.json placed on disk by the
same action.

The page is ONE template for every brand: the accent colour is lifted from the
brand's theme.json (--primary), the logo/name from its build config, and any
brand-specific wording from brand.json's `page` block. Brands do not get their
own HTML — that would refork the maintenance we just merged.
"""

import glob
import hashlib
import html
import json
import os
import sys
from datetime import datetime, timezone

import oss2

DEFAULT_ACCENT = "#ff8b7b"
DEFAULT_ACCENT2 = "#ff6b5a"
# Every coral in CSS below is one of these three literals, so re-theming the page
# is three substitutions rather than a templated stylesheet.
DEFAULT_RGBA_PREFIX = "rgba(255,139,123,"


def human(n):
    f = float(n)
    for u in ["B", "KB", "MB", "GB"]:
        if f < 1024 or u == "GB":
            return f"{f:.1f} {u}"
        f /= 1024


def short_sha(h):
    return (h[:16] + "…" + h[-8:]) if len(h) > 26 else h


def hex_to_rgb(value):
    h = value.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def resolve_accent(build_config):
    """Accent colours for the page, taken from the brand's palette.

    Falls back to the stock coral for brands on a built-in palette (`default` /
    `teal`), which ship no theme.json.
    """
    palette = (build_config.get("app") or {}).get("palette")
    if not palette:
        return DEFAULT_ACCENT, DEFAULT_ACCENT2
    theme_path = os.path.join("branding", palette, "theme.json")
    if not os.path.isfile(theme_path):
        return DEFAULT_ACCENT, DEFAULT_ACCENT2
    with open(theme_path) as f:
        tokens = (json.load(f) or {}).get("tokens") or {}
    primary = tokens.get("--primary")
    if not primary or not primary.startswith("#"):
        return DEFAULT_ACCENT, DEFAULT_ACCENT2
    # --coral-soft is a tint of --primary in every brand palette, but it is far
    # too light to read as the second gradient stop on a dark page; a flat
    # gradient off --primary looks intentional where a light stop looks broken.
    return primary, primary


def resolve_logo(build_config):
    """Local path to the logo to publish alongside the page."""
    candidates = []
    logo = (build_config.get("app") or {}).get("logo")
    if logo:
        candidates.append(logo)
    # Brands on the stock icons (no app.logo) fall back to the repo's own logo.
    candidates.append("packages/app/public/logo.png")
    return next((c for c in candidates if os.path.isfile(c)), None)


def build_css(accent, accent2):
    css = (
        ":root{--bg:#000;--bg-tertiary:#111;--bg-card:#141414;--bg-card-hover:#1a1a1a;"
        "--tx:#fff;--tx2:rgba(255,255,255,.7);--tx3:rgba(255,255,255,.5);--tx4:rgba(255,255,255,.35);"
        "--accent:#ff8b7b;--accent2:#ff6b5a;--glow:rgba(255,139,123,.4);"
        "--bd:rgba(255,255,255,.08);--bd2:rgba(255,255,255,.12);"
        "--grad:linear-gradient(135deg,#ff8b7b 0%,#ff6b5a 100%);color-scheme:dark}"
        "*{box-sizing:border-box;margin:0;padding:0}"
        "html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}"
        "body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;"
        "background:var(--bg);color:var(--tx);min-height:100vh;display:flex;justify-content:center;padding:72px 20px 56px;position:relative;overflow-x:hidden}"
        "body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(255,139,123,.15),transparent 70%);pointer-events:none;z-index:0}"
        ".card{width:100%;max-width:560px;text-align:center;position:relative;z-index:1}"
        ".logo{width:84px;height:84px;border-radius:22px;box-shadow:0 0 40px var(--glow),0 8px 30px rgba(0,0,0,.6);object-fit:cover}"
        ".badge{display:inline-flex;align-items:center;gap:6px;margin-top:22px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);border:1px solid rgba(255,139,123,.35);background:rgba(255,139,123,.08);border-radius:999px;padding:4px 13px}"
        ".badge .dot{width:6px;height:6px;border-radius:50%;background:var(--accent2);box-shadow:0 0 8px var(--glow)}"
        "h1{font-size:38px;font-weight:800;margin:16px 0 6px;letter-spacing:-.03em;line-height:1.05}"
        ".meta{color:var(--tx3);font-size:14px;margin-bottom:34px}.meta b{color:var(--tx2);font-weight:600}"
        ".lbl{font-size:13px;color:var(--tx3);margin:0 0 9px;text-align:left;display:flex;align-items:center;gap:8px}"
        ".os{font-weight:700;color:var(--tx)}.os-ico{width:15px;height:15px;opacity:.85;flex:none}"
        ".cmd{display:flex;align-items:center;gap:10px;background:var(--bg-tertiary);border:1px solid var(--bd);color:var(--tx2);border-radius:12px;padding:13px 14px;margin-bottom:20px;font:13px/1.4 ui-monospace,'SF Mono',Menlo,monospace;text-align:left}"
        ".cmd code{flex:1;overflow-x:auto;white-space:nowrap}"
        ".copy{flex:none;cursor:pointer;border:0;background:var(--grad);color:#1a0e0b;border-radius:8px;padding:7px 13px;font-size:12px;font-weight:700;transition:transform .12s,box-shadow .12s}"
        ".copy:hover{transform:translateY(-1px);box-shadow:0 4px 16px var(--glow)}"
        ".sep{display:flex;align-items:center;gap:14px;margin:30px 2px 16px;color:var(--tx4);font-size:12px;letter-spacing:.08em;text-transform:uppercase;border:0}"
        ".sep::before,.sep::after{content:'';flex:1;height:1px;background:var(--bd)}"
        ".dl{background:var(--bg-card);border:1px solid var(--bd);border-radius:16px;margin-bottom:12px;overflow:hidden;transition:border-color .15s,transform .15s,box-shadow .15s}"
        ".dl:hover{border-color:rgba(255,139,123,.4);transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.6)}"
        ".dl-main{display:flex;align-items:center;gap:15px;text-decoration:none;color:inherit;padding:15px 18px 11px;text-align:left}"
        ".dl-ico{flex:none;width:38px;height:38px;border-radius:11px;background:var(--bg-card-hover);border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;color:var(--tx2)}"
        ".dl-ico svg{width:19px;height:19px}"
        ".dlc{flex:1;display:flex;flex-direction:column;min-width:0}"
        ".dl-label{font-weight:600;font-size:15px}.dl-sub{font-size:12.5px;color:var(--tx3);margin-top:2px}"
        ".arr{flex:none;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;color:var(--accent);background:rgba(255,139,123,.1);font-size:16px;transition:background .15s}"
        ".dl:hover .arr{background:var(--grad);color:#1a0e0b}"
        ".sha-row{display:flex;align-items:center;gap:9px;padding:0 18px 13px;text-align:left}"
        ".sha-k{font:10px/1 ui-monospace,Menlo,monospace;color:var(--tx4);letter-spacing:.06em}"
        ".sha{font:11px/1 ui-monospace,Menlo,monospace;color:var(--tx3);flex:1;overflow:hidden;text-overflow:ellipsis}"
        ".sha-copy{flex:none;cursor:pointer;border:1px solid var(--bd2);background:transparent;color:var(--tx2);border-radius:7px;padding:4px 10px;font-size:11px;font-weight:600;transition:border-color .12s,color .12s}"
        ".sha-copy:hover{border-color:var(--accent);color:var(--accent)}"
        "footer{margin-top:30px;font-size:12px;color:var(--tx4);line-height:1.7}"
        "footer code{display:inline-block;margin-top:6px;background:var(--bg-tertiary);border:1px solid var(--bd);color:var(--tx3);padding:6px 10px;border-radius:8px;font:11.5px/1.5 ui-monospace,Menlo,monospace}"
        # segmented desktop / amuxd toggle
        ".seg{display:inline-flex;gap:4px;margin:22px 0 30px;padding:4px;background:var(--bg-tertiary);border:1px solid var(--bd);border-radius:12px}"
        ".seg button{cursor:pointer;border:0;background:transparent;color:var(--tx3);font-size:13.5px;font-weight:600;padding:8px 18px;border-radius:9px;transition:color .15s,background .15s}"
        ".seg button.on{color:#1a0e0b;background:var(--grad);box-shadow:0 2px 12px var(--glow)}"
        ".panel{display:none}.panel.on{display:block}"
        ".intro{color:var(--tx3);font-size:13px;line-height:1.6;margin:-8px 0 24px;text-align:left}"
    )
    r, g, b = hex_to_rgb(accent)
    return (
        css.replace(DEFAULT_ACCENT, accent)
        .replace(DEFAULT_ACCENT2, accent2)
        .replace(DEFAULT_RGBA_PREFIX, f"rgba({r},{g},{b},")
    )


APPLE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.4 12.6c0-2 1.6-3 1.7-3-.9-1.3-2.3-1.5-2.8-1.5-1.2-.1-2.3.7-2.9.7s-1.5-.7-2.5-.7c-1.3 0-2.5.7-3.1 1.9-1.3 2.3-.3 5.7 1 7.5.6.9 1.3 1.9 2.3 1.9.9 0 1.2-.6 2.3-.6s1.4.6 2.4.6 1.6-.9 2.2-1.8c.7-1 1-2 1-2-.1 0-1.9-.7-1.9-2.6zM14.6 5.3c.5-.6.9-1.5.8-2.3-.8 0-1.7.5-2.2 1.1-.5.5-.9 1.4-.8 2.2.9.1 1.7-.4 2.2-1z"/></svg>'
WIN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5.5 10.5 4.4v7.1H3V5.5zm0 13L10.5 19.6v-7H3v6.5zM11.5 4.3 21 3v8.5h-9.5V4.3zm0 8.2H21V21l-9.5-1.3v-7.2z"/></svg>'
LINUX_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-2 0-3.2 1.7-3.2 4 0 1.4.3 2.2.3 3.2 0 1-.9 1.8-1.7 3.2-.8 1.4-1.7 2.9-1.7 4.6 0 .9.3 1.5.8 1.9-.1.5 0 1 .3 1.4.5.6 1.4.7 2.3.7.8 0 1.5-.3 2-.3.5 0 1.2.3 2 .3.9 0 1.8-.1 2.3-.7.3-.4.4-.9.3-1.4.5-.4.8-1 .8-1.9 0-1.7-.9-3.2-1.7-4.6-.8-1.4-1.7-2.2-1.7-3.2 0-1 .3-1.8.3-3.2C15.2 3.7 14 2 12 2zm-1.2 4.1c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zm2.4 0c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9z"/></svg>'


# One template serves every brand, so the page copy has to follow the brand's
# page.lang instead of being hardcoded. Keyed by language family: a brand's tag
# ("zh-CN", "en-US") selects by prefix via strings(). Anything unrecognised —
# including a brand that omits page.lang — falls back to Chinese, which is what
# this page rendered before it was translatable, so existing brands are
# unaffected.
STRINGS = {
    "zh": {
        "released_on": "发布于 {date}",
        "tab_desktop": "{app} 桌面",
        "tab_amuxd": "amuxd 守护进程",
        "install_terminal": "一键安装（终端）",
        "install_ps": "一键安装（PowerShell）",
        "copy": "复制",
        "copied": "已复制",
        "or_manual": "或手动下载",
        "or_manual_bin": "或手动下载二进制",
        "amuxd_intro": (
            "amuxd 是无界面的团队守护进程：把服务器/常开机器接入团队，"
            "托管本地 AI Agent 与团队同步。安装脚本会下载二进制、引导你粘贴 "
            "<code>{scheme}://invite</code> 邀请深链完成接入，并注册为开机自启的后台服务。"
        ),
        "amuxd_footer": (
            "手动安装：放到 <code>~/.amuxd/bin/amuxd</code> 后依次执行 "
            "<code>amuxd init</code> 与 <code>amuxd install-service</code>。"
        ),
    },
    "en": {
        "released_on": "Released {date}",
        "tab_desktop": "{app} Desktop",
        "tab_amuxd": "amuxd daemon",
        "install_terminal": "one-line install (Terminal)",
        "install_ps": "one-line install (PowerShell)",
        "copy": "Copy",
        "copied": "Copied",
        "or_manual": "Or download manually",
        "or_manual_bin": "Or download the binary manually",
        "amuxd_intro": (
            "amuxd is the headless team daemon: it connects a server or always-on "
            "machine to your team, hosting local AI agents and team sync. The "
            "install script downloads the binary, walks you through pasting a "
            "<code>{scheme}://invite</code> deep link to join, and registers it as "
            "a background service that starts on boot."
        ),
        "amuxd_footer": (
            "Manual install: place it at <code>~/.amuxd/bin/amuxd</code>, then run "
            "<code>amuxd init</code> followed by <code>amuxd install-service</code>."
        ),
    },
}


def strings(lang):
    return STRINGS.get((lang or "").split("-")[0].lower(), STRINGS["zh"])


def _ico(d):
    o = d.get("os")
    return LINUX_SVG if o == "linux" else (WIN_SVG if o == "windows" else APPLE_SVG)


def _card(d, s):
    return (
        '        <div class="dl">'
        f'<a class="dl-main" href="{html.escape(d["url"])}">'
        f'<span class="dl-ico">{_ico(d)}</span>'
        f'<span class="dlc"><span class="dl-label">{html.escape(d["label"])}</span>'
        f'<span class="dl-sub">{html.escape(d.get("sub",""))} · {human(d["size"])}</span></span>'
        '<span class="arr">↓</span></a>'
        '<div class="sha-row"><span class="sha-k">SHA256</span>'
        f'<code class="sha">{short_sha(d["sha256"])}</code>'
        f'<button class="sha-copy" data-sha="{d["sha256"]}" '
        f"onclick=\"navigator.clipboard.writeText(this.dataset.sha);this.textContent=&#39;{s['copied']}&#39;;"
        f'setTimeout(()=>this.textContent=&#39;{s["copy"]}&#39;,1200)">{s["copy"]}</button></div></div>'
    )


def main() -> int:
    tag = os.environ["TAG"]
    version = tag[1:] if tag.startswith("v") else tag
    prefix = os.environ["OSS_PREFIX"]
    cdn = os.environ["CDN_BASE"].rstrip("/")
    # APP_NAME is the human-facing label (app.displayName, e.g. "Betly TeamClu");
    # APP_PRODUCT_NAME is what the .app bundle is actually called (app.name).
    # Anything naming a path on disk must use the latter.
    app_name = os.environ["APP_NAME"]
    product_name = os.environ.get("APP_PRODUCT_NAME") or app_name
    app_slug = os.environ["APP_SLUG"]

    with open("build.config.json") as f:
        build_config = json.load(f)
    page_cfg = {}
    if os.path.isfile("brand-page.json"):
        with open("brand-page.json") as f:
            page_cfg = json.load(f) or {}

    scheme = (build_config.get("app") or {}).get("scheme") or "teamclu"

    platforms = {}       # for latest.json (updater)
    downloads = []       # desktop installers (user-facing)
    amuxd_downloads = []  # standalone amuxd daemon binaries
    for frag_file in glob.glob("frags/*.json"):
        with open(frag_file) as f:
            frag = json.load(f)
        # Standalone-amuxd fragments carry an 'amuxd' key instead of the
        # updater/platform shape the desktop fragments use.
        if "amuxd" in frag:
            amuxd_downloads.append(frag["amuxd"])
            continue
        platforms[frag["platform"]] = frag["updater"]
        downloads.extend(frag.get("downloads", []))
    if not platforms:
        print("::error::No updater fragments found — nothing to publish")
        return 1

    # Guard against version drift: the tag-derived version published in
    # latest.json MUST match the version baked into every installer filename
    # (<App>_<version>_<arch>.dmg / *-setup.exe). If the build jobs failed to
    # sync the source version to the tag, fail loudly here instead of shipping a
    # page that advertises one version but serves binaries stamped with another.
    mismatched = [d["filename"] for d in downloads if version not in d.get("filename", "")]
    if mismatched:
        print(
            "::error::Installer filename(s) do not carry the published "
            f"version {version!r}: {mismatched}. Version sync from the tag "
            "is broken — refusing to publish a mismatched release."
        )
        return 1
    print(f"✅ All {len(downloads)} installer(s) carry version {version}")

    # Stable display order: macOS Apple Silicon, macOS Intel, Windows
    okey = {("macos", "aarch64"): 0, ("macos", "x86_64"): 1, ("windows", "x86_64"): 2}
    downloads.sort(key=lambda d: okey.get((d.get("os"), d.get("arch")), 9))

    # amuxd standalone daemon binaries: macOS arm64/x64, Linux arm64/x64, Windows x64
    amkey = {
        ("macos", "aarch64"): 0, ("macos", "x86_64"): 1,
        ("linux", "aarch64"): 2, ("linux", "x86_64"): 3,
        ("windows", "x86_64"): 4,
    }
    amuxd_downloads.sort(key=lambda d: amkey.get((d.get("os"), d.get("arch")), 9))

    pub_date = datetime.now(timezone.utc).isoformat(timespec="seconds")

    manifest = {
        "version": version,
        "notes": f"{app_name} {tag}",
        "pub_date": pub_date,
        "platforms": platforms,
    }
    manifest_str = json.dumps(manifest, indent=2) + "\n"

    # The pointer a standalone amuxd polls: `amuxd update` and its background
    # check (apps/daemon/src/self_update.rs). Platform keys are "<os>-<arch>"
    # spelled the way Rust's std::env::consts spells them, which is already how
    # the fragments name them. Only binaries uploaded under this release's
    # version are listed; with none, the previous pointer is left in place.
    amuxd_platforms = {}
    for d in amuxd_downloads:
        if f"/amuxd/{version}/" not in d.get("url", ""):
            print(f"::warning::amuxd fragment {d.get('filename')} is not from {version}; left out of amuxd/latest.json")
            continue
        amuxd_platforms[f'{d["os"]}-{d["arch"]}'] = {
            "url": d["url"],
            "sha256": d["sha256"],
            "size": d["size"],
        }
    amuxd_manifest_str = None
    if amuxd_platforms:
        amuxd_manifest_str = json.dumps(
            {"version": version, "pub_date": pub_date, "platforms": amuxd_platforms},
            indent=2,
        ) + "\n"

    def find(o, a=None):
        return next((d["url"] for d in downloads if d.get("os") == o and (a is None or d.get("arch") == a)), "")

    mac_arm, mac_x64, win_url = find("macos", "aarch64"), find("macos", "x86_64"), find("windows")

    # --- one-click install scripts (baked with this release's URLs) ---
    install_sh = '''#!/bin/bash
set -euo pipefail
case "$(uname -m)" in
  arm64) DMG_URL="__ARM__";;
  x86_64) DMG_URL="__X64__";;
  *) echo "Unsupported arch: $(uname -m)"; exit 1;;
esac
[ -z "$DMG_URL" ] && { echo "No macOS build for this arch"; exit 1; }
echo "Installing __APP__ ($(uname -m))..."
DMG=$(mktemp /tmp/__SLUG__-install-XXXXXX.dmg)
curl -L --progress-bar -o "$DMG" "$DMG_URL"
MOUNT=$(hdiutil attach "$DMG" -nobrowse 2>&1 | grep -E '/Volumes/' | tail -1 | awk -F'\\t' '{print $NF}')
APP=$(find "$MOUNT" -maxdepth 1 -name "*.app" -type d | head -1)
[ -z "$APP" ] && { echo "No .app in DMG"; hdiutil detach "$MOUNT" -quiet; rm -f "$DMG"; exit 1; }
APP_NAME=$(basename "$APP" .app)
pgrep -x "$APP_NAME" >/dev/null 2>&1 && { osascript -e "tell application \\"${APP_NAME}\\" to quit" 2>/dev/null || true; sleep 2; }
rm -rf "/Applications/${APP_NAME}.app"; cp -R "$APP" /Applications/
xattr -dr com.apple.quarantine "/Applications/${APP_NAME}.app" 2>/dev/null || true
hdiutil detach "$MOUNT" -quiet; rm -f "$DMG"
echo "Done. Opening ${APP_NAME}..."; open "/Applications/${APP_NAME}.app"
'''.replace("__ARM__", mac_arm).replace("__X64__", mac_x64) \
   .replace("__APP__", app_name).replace("__SLUG__", app_slug)

    install_ps1 = '''$ErrorActionPreference = 'Stop'
$url = '__WIN__'
if (-not $url) { Write-Error 'No Windows build available'; exit 1 }
$exe = Join-Path $env:TEMP '__SLUG__-setup.exe'
Write-Host 'Downloading __APP__...'
Invoke-WebRequest -Uri $url -OutFile $exe
Write-Host 'Installing...'
Start-Process -FilePath $exe -ArgumentList '/S' -Wait
Remove-Item $exe -Force -ErrorAction SilentlyContinue
Write-Host '__APP__ installed.'
'''.replace("__WIN__", win_url).replace("__APP__", app_name).replace("__SLUG__", app_slug)

    # --- standalone amuxd install scripts (baked with this release's URLs) ---
    def amuxd_url(o, a):
        return next((d["url"] for d in amuxd_downloads if d.get("os") == o and d.get("arch") == a), "")

    # POSIX (macOS + Linux): download to ~/.amuxd/bin/amuxd (the path
    # `amuxd install-service` expects), symlink onto PATH, then onboard
    # (interactive) and register the OS service. Run via `bash <(curl …)`
    # so `amuxd init`'s stdin stays attached to the terminal.
    install_amuxd_sh = '''#!/bin/bash
set -euo pipefail
OS=$(uname -s); ARCH=$(uname -m)
case "$OS-$ARCH" in
  Darwin-arm64)  URL="__MAC_ARM__";;
  Darwin-x86_64) URL="__MAC_X64__";;
  Linux-aarch64) URL="__LIN_ARM__";;
  Linux-arm64)   URL="__LIN_ARM__";;
  Linux-x86_64)  URL="__LIN_X64__";;
  *) echo "Unsupported platform: $OS-$ARCH"; exit 1;;
esac
[ -z "$URL" ] && { echo "No amuxd build for $OS-$ARCH"; exit 1; }
AMUXD_DIR="$HOME/.amuxd"
BIN_DIR="$AMUXD_DIR/bin"
mkdir -p "$BIN_DIR"
echo "Downloading amuxd ($OS-$ARCH)..."
# Download beside the binary, then rename over it: writing into a running amuxd
# fails on Linux (ETXTBSY), and a failed download must not leave a truncated
# binary where the service expects one.
TMP="$BIN_DIR/amuxd.download.$$"
trap 'rm -f "$TMP"' EXIT
curl -fL --progress-bar -o "$TMP" "$URL"
chmod +x "$TMP"
[ "$OS" = "Darwin" ] && xattr -d com.apple.quarantine "$TMP" 2>/dev/null || true
mv -f "$TMP" "$BIN_DIR/amuxd"
# Put amuxd on PATH (best-effort; falls back to ~/.amuxd/bin note).
for d in /usr/local/bin "$HOME/.local/bin"; do
  if [ -w "$d" ] || mkdir -p "$d" 2>/dev/null && [ -w "$d" ]; then
    ln -sf "$BIN_DIR/amuxd" "$d/amuxd"; LINKED="$d/amuxd"; break
  fi
done
AMUXD="${LINKED:-$BIN_DIR/amuxd}"
echo "Installed amuxd -> $AMUXD"
"$AMUXD" --version || true
# Onboard unless a team has already claimed this daemon, then register the OS
# service (which also restarts a running daemon onto the new binary). The
# credentials live in teams/<id>/state/backend.toml; the v2 layout deletes the
# old root backend.toml, so checking for that onboarded again on every re-run.
claimed() {
  for f in "$AMUXD_DIR"/teams/*/state/backend.toml; do
    [ -f "$f" ] || continue
    case "$f" in "$AMUXD_DIR"/teams/_unclaimed/*) continue;; esac
    return 0
  done
  return 1
}
if ! claimed; then
  echo; echo "Onboarding this daemon (paste your __SCHEME__://invite deeplink)..."
  "$AMUXD" init || { echo "Onboarding skipped — run: amuxd init && amuxd install-service"; exit 0; }
fi
"$AMUXD" install-service
echo "Done. amuxd is running as a background service. Check: amuxd status"
'''.replace("__MAC_ARM__", amuxd_url("macos", "aarch64")) \
   .replace("__MAC_X64__", amuxd_url("macos", "x86_64")) \
   .replace("__LIN_ARM__", amuxd_url("linux", "aarch64")) \
   .replace("__LIN_X64__", amuxd_url("linux", "x86_64")) \
   .replace("__SCHEME__", scheme)

    # Windows: download to %USERPROFILE%\\.amuxd\\bin\\amuxd.exe, onboard, then
    # register the login scheduled task via `amuxd install-service`.
    install_amuxd_ps1 = '''$ErrorActionPreference = 'Stop'
$url = '__WIN_X64__'
if (-not $url) { Write-Error 'No amuxd build available'; exit 1 }
$amuxdHome = Join-Path $env:USERPROFILE '.amuxd'
$binDir = Join-Path $amuxdHome 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$exe = Join-Path $binDir 'amuxd.exe'
$download = "$exe.download"
Write-Host 'Downloading amuxd...'
Invoke-WebRequest -Uri $url -OutFile $download
# A running amuxd.exe cannot be overwritten, only renamed. Stop it (so
# install-service below starts the new one), move it aside, then move the
# download into place.
if (Test-Path $exe) {
  try { & $exe stop | Out-Null } catch {}
  $old = "$exe.old"
  Remove-Item $old -Force -ErrorAction SilentlyContinue
  if (Test-Path $old) { $old = "$exe.old-" + (Get-Date -Format 'yyyyMMddHHmmss') }
  Move-Item $exe $old -Force
}
Move-Item $download $exe -Force
& $exe --version
# The credentials live in teams\\<id>\\state\\backend.toml; the v2 layout deletes
# the old root backend.toml, so checking for that onboarded again on every re-run.
$claimed = Get-ChildItem (Join-Path $amuxdHome 'teams') -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne '_unclaimed' -and (Test-Path (Join-Path $_.FullName 'state\\backend.toml')) }
if (-not $claimed) {
  Write-Host 'Onboarding this daemon (paste your __SCHEME__://invite deeplink)...'
  & $exe init
}
& $exe install-service
Write-Host 'Done. amuxd is running as a background service. Check: amuxd status'
'''.replace("__WIN_X64__", amuxd_url("windows", "x86_64")).replace("__SCHEME__", scheme)

    # --- release page (logo + size + truncated sha + copy + one-liners) ---
    accent, accent2 = resolve_accent(build_config)
    css = build_css(accent, accent2)
    logo_url = f"{cdn}/{prefix}/logo.png"
    mac_cmd = f"curl -fsSL {cdn}/{prefix}/install.sh | bash"
    win_cmd = f"irm {cdn}/{prefix}/install.ps1 | iex"
    am_mac_cmd = f"bash <(curl -fsSL {cdn}/{prefix}/install-amuxd.sh)"
    am_win_cmd = f"irm {cdn}/{prefix}/install-amuxd.ps1 | iex"

    lang = page_cfg.get("lang") or "zh-CN"
    s = strings(lang)

    cards = "\n".join(_card(d, s) for d in downloads)
    amuxd_cards = "\n".join(_card(d, s) for d in amuxd_downloads)

    badge = page_cfg.get("badge") or ""
    # Private OEM distribution: keep these pages out of search results unless a
    # brand explicitly opts in.
    noindex = page_cfg.get("noindex", True)
    footer_note = page_cfg.get("footerNote") or ""

    title = f"{app_name} {tag}" + (f" · {badge}" if badge else "")
    badge_html = (
        f'<div><span class="badge"><span class="dot"></span> {html.escape(badge)}</span></div>'
        if badge else ""
    )
    # productName, not displayName: this names a real path on disk. Quoted
    # because a branded productName can contain spaces ("Copilot 361.app").
    quarantine_cmd = f'sudo xattr -dr com.apple.quarantine "/Applications/{product_name}.app"'
    footer_html = (
        f"<footer>{html.escape(footer_note)}<br>" if footer_note else "<footer>"
    ) + f"<code>{html.escape(quarantine_cmd)}</code></footer>"

    page = (
        f'<!doctype html><html lang="{html.escape(lang)}"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + ('<meta name="robots" content="noindex">' if noindex else "")
        + '<link rel="preconnect" href="https://fonts.googleapis.com">'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">'
        f"<title>{html.escape(title)}</title><style>{css}</style></head><body>"
        '<div class="card">'
        f'<img class="logo" src="{logo_url}" alt="{html.escape(app_name)}">'
        f"{badge_html}"
        f"<h1>{html.escape(app_name)} {html.escape(version)}</h1>"
        f'<div class="meta"><b>{html.escape(version)}</b> · '
        f'{s["released_on"].format(date=pub_date[:10])}</div>'
        # --- desktop / amuxd toggle ---
        '<div class="seg" role="tablist">'
        f'<button class="on" data-p="desktop" onclick="pick(this)">'
        f'{s["tab_desktop"].format(app=html.escape(app_name))}</button>'
        f'<button data-p="amuxd" onclick="pick(this)">{s["tab_amuxd"]}</button></div>'
        # --- panel: desktop app ---
        '<div class="panel on" data-panel="desktop">'
        f'<div class="lbl"><span class="os-ico">{APPLE_SVG}</span><span class="os">macOS</span> {s["install_terminal"]}</div>'
        f'<div class="cmd"><code id="m">{html.escape(mac_cmd)}</code>'
        f'<button class="copy" onclick="navigator.clipboard.writeText(m.textContent);this.textContent=&#39;{s["copied"]}&#39;">{s["copy"]}</button></div>'
        f'<div class="lbl"><span class="os-ico">{WIN_SVG}</span><span class="os">Windows</span> {s["install_ps"]}</div>'
        f'<div class="cmd"><code id="w">{html.escape(win_cmd)}</code>'
        f'<button class="copy" onclick="navigator.clipboard.writeText(w.textContent);this.textContent=&#39;{s["copied"]}&#39;">{s["copy"]}</button></div>'
        f'<div class="sep">{s["or_manual"]}</div>'
        f"{cards}"
        "</div>"
        # --- panel: standalone amuxd ---
        '<div class="panel" data-panel="amuxd">'
        f'<p class="intro">{s["amuxd_intro"].format(scheme=html.escape(scheme))}</p>'
        f'<div class="lbl"><span class="os-ico">{APPLE_SVG}</span><span class="os">macOS / Linux</span> {s["install_terminal"]}</div>'
        f'<div class="cmd"><code id="am">{html.escape(am_mac_cmd)}</code>'
        f'<button class="copy" onclick="navigator.clipboard.writeText(am.textContent);this.textContent=&#39;{s["copied"]}&#39;">{s["copy"]}</button></div>'
        f'<div class="lbl"><span class="os-ico">{WIN_SVG}</span><span class="os">Windows</span> {s["install_ps"]}</div>'
        f'<div class="cmd"><code id="aw">{html.escape(am_win_cmd)}</code>'
        f'<button class="copy" onclick="navigator.clipboard.writeText(aw.textContent);this.textContent=&#39;{s["copied"]}&#39;">{s["copy"]}</button></div>'
        f'<div class="sep">{s["or_manual_bin"]}</div>'
        f"{amuxd_cards}"
        f'<footer>{s["amuxd_footer"]}</footer>'
        "</div>"
        f"{footer_html}"
        "</div>"
        '<script>function pick(b){'
        'document.querySelectorAll(".seg button").forEach(x=>x.classList.toggle("on",x===b));'
        "var p=b.dataset.p;"
        'document.querySelectorAll(".panel").forEach(x=>x.classList.toggle("on",x.dataset.panel===p));}'
        "</script>"
        "</body></html>"
    )

    auth = oss2.Auth(os.environ["OSS_ACCESS_KEY_ID"], os.environ["OSS_ACCESS_KEY_SECRET"])
    endpoint = os.environ["OSS_ENDPOINT"]
    if not endpoint.startswith("http"):
        endpoint = "https://" + endpoint
    bucket = oss2.Bucket(auth, endpoint, os.environ["OSS_BUCKET"])

    short_cache = {"Cache-Control": "max-age=60, must-revalidate"}
    json_ct = {"Content-Type": "application/json; charset=utf-8"}

    # Mutable root pointer the installed app polls — must re-validate.
    bucket.put_object(f"{prefix}/latest.json", manifest_str.encode(), headers={**short_cache, **json_ct})
    bucket.put_object(f"{prefix}/{tag}/latest.json", manifest_str.encode(), headers=json_ct)
    bucket.put_object(f"{prefix}/latest.txt", version.encode(),
                      headers={**short_cache, "Content-Type": "text/plain; charset=utf-8"})
    bucket.put_object(f"{prefix}/index.html", page.encode(),
                      headers={**short_cache, "Content-Type": "text/html; charset=utf-8"})
    bucket.put_object(f"{prefix}/install.sh", install_sh.encode(),
                      headers={**short_cache, "Content-Type": "text/x-shellscript; charset=utf-8"})
    bucket.put_object(f"{prefix}/install.ps1", install_ps1.encode(),
                      headers={**short_cache, "Content-Type": "text/plain; charset=utf-8"})
    bucket.put_object(f"{prefix}/install-amuxd.sh", install_amuxd_sh.encode(),
                      headers={**short_cache, "Content-Type": "text/x-shellscript; charset=utf-8"})
    bucket.put_object(f"{prefix}/install-amuxd.ps1", install_amuxd_ps1.encode(),
                      headers={**short_cache, "Content-Type": "text/plain; charset=utf-8"})
    if amuxd_manifest_str:
        bucket.put_object(f"{prefix}/amuxd/latest.json", amuxd_manifest_str.encode(),
                          headers={**short_cache, **json_ct})

    # Privacy policy — brand-generic template with {{APP_NAME}} substituted.
    # Published at {cdn}/{prefix}/privacy.html so the Chrome Web Store listing can
    # point its "Privacy policy URL" here (e.g. download.copilot361.com/releases/privacy.html).
    privacy_tpl_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "templates", "privacy.html"
    )
    if os.path.isfile(privacy_tpl_path):
        with open(privacy_tpl_path, encoding="utf-8") as f:
            privacy_html = f.read()
        # Contact precedence: PRIVACY_CONTACT env → brand config
        # (app.privacyContact / page.privacyContact) → domain-derived fallback.
        # Contact precedence: PRIVACY_CONTACT env → brand.json's page block
        # (page_cfg.privacyContact) → build config app block → domain fallback.
        contact = (
            os.environ.get("PRIVACY_CONTACT")
            or page_cfg.get("privacyContact")
            or (build_config.get("app") or {}).get("privacyContact")
            or f"support@{app_slug}.com"
        )
        privacy_html = (
            privacy_html.replace("{{APP_NAME}}", html.escape(app_name))
            .replace("{{UPDATED}}", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
            .replace("{{CONTACT}}", html.escape(contact))
        )
        bucket.put_object(
            f"{prefix}/privacy.html",
            privacy_html.encode(),
            headers={**short_cache, "Content-Type": "text/html; charset=utf-8"},
        )
        print(f"✅ {cdn}/{prefix}/privacy.html  (privacy policy)")
    else:
        print("::warning::privacy.html template missing — skipped privacy policy upload")

    logo = resolve_logo(build_config)
    if logo:
        bucket.put_object_from_file(f"{prefix}/logo.png", logo,
                                    headers={"Cache-Control": "max-age=3600", "Content-Type": "image/png"})
    else:
        print("::warning::No logo found — the release page will render a broken image")

    print(f"✅ {cdn}/{prefix}/index.html  ({app_name}, accent {accent})")
    print(f"✅ {cdn}/{prefix}/latest.json  |  latest.txt -> {version}")
    print(f"✅ {cdn}/{prefix}/install.sh  |  install.ps1  |  logo.png")
    print(f"✅ {cdn}/{prefix}/install-amuxd.sh  |  install-amuxd.ps1  ({len(amuxd_downloads)} amuxd binaries)")
    if amuxd_manifest_str:
        print(f"✅ {cdn}/{prefix}/amuxd/latest.json  ({len(amuxd_platforms)} platforms)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
