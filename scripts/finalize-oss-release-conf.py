#!/usr/bin/env python3
"""Pin the app version to the release tag and point the updater at OSS.

Runs in the OSS release pipeline (.github/workflows/release-oss.yml) on both the
macOS and Windows build jobs, after the frontend is built and before
tauri-action compiles the Rust app.

Reads TAG, CDN_BASE and OSS_PREFIX from the environment; the latter two are
exported by .github/actions/brand-setup from the brand's brand.json.
"""

import json
import os
import re
import sys


def main() -> int:
    tag = os.environ["TAG"]
    manifest_url = f'{os.environ["CDN_BASE"].rstrip("/")}/{os.environ["OSS_PREFIX"]}/latest.json'

    # Authoritatively derive the app version from the tag so the built installer
    # filename + baked app version match latest.json (published from the same
    # tag). Without this the source version drifts from the tag and the release
    # page advertises e.g. 0.2.20-beta.3 while the DMG is TeamClu_0.2.19_*,
    # which also breaks the updater version comparison.
    version = tag[1:] if tag.startswith("v") else tag
    if not re.match(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$", version):
        print(f"::error::Tag {tag!r} does not yield a valid semver version ({version!r})")
        return 1
    print("Syncing app version ->", version)

    # encoding= on every handle and ensure_ascii=False on every dump (#1403).
    # The Windows runner's Python defaults open() to cp1252, which read the
    # brand's "TeamClu 群策" as "TeamClu ç¾¤ç­–" without raising and wrote it
    # back out, so every Windows build since #1027 shipped a mojibake window
    # title and APP_DISPLAY_NAME. macOS defaults to UTF-8 and never showed it.
    conf_path = "apps/desktop/tauri.conf.json"
    with open(conf_path, encoding="utf-8") as f:
        conf = json.load(f)
    conf["version"] = version
    conf["build"]["beforeBuildCommand"] = "echo frontend already built"
    conf.setdefault("plugins", {}).setdefault("updater", {})["endpoints"] = [manifest_url]
    with open(conf_path, "w", encoding="utf-8") as f:
        json.dump(conf, f, indent=2, ensure_ascii=False)

    # Keep the Rust crates (desktop binary + bundled amuxd sidecar) in lockstep.
    for cargo in ("apps/desktop/Cargo.toml", "apps/daemon/Cargo.toml"):
        with open(cargo, encoding="utf-8") as f:
            txt = f.read()
        txt = re.sub(r'(?m)^version = "[^"]*"', f'version = "{version}"', txt, count=1)
        with open(cargo, "w", encoding="utf-8") as f:
            f.write(txt)

    # package.json drives any in-app version read from the JS side.
    with open("package.json", encoding="utf-8") as f:
        pkg = json.load(f)
    pkg["version"] = version
    with open("package.json", "w", encoding="utf-8") as f:
        json.dump(pkg, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # The custom Rust updater (apps/desktop/src/commands/updater.rs) reads its
    # endpoints from build.config.json -> app.updater.endpoints via build.rs
    # (baked into UPDATER_ENDPOINTS at compile time), NOT from tauri.conf.json's
    # plugins.updater. Without this the build has no custom endpoints and falls
    # back to GitHub API mode, failing with "Updater token not configured
    # (GitHub mode requires UPDATER_GITHUB_TOKEN)".
    #
    # This also deliberately REPLACES (not appends to) whatever endpoints the
    # brand's build.config.json declared: a brand config may carry a GitHub
    # fallback endpoint, but nothing in this channel is published to GitHub.
    with open("build.config.json", encoding="utf-8") as f:
        bc = json.load(f)
    bc.setdefault("app", {}).setdefault("updater", {})["endpoints"] = [manifest_url]
    with open("build.config.json", "w", encoding="utf-8") as f:
        json.dump(bc, f, indent=2, ensure_ascii=False)

    print("Updater endpoint ->", manifest_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
