#!/usr/bin/env python3
"""Upload an Android APK to OSS and point android/latest.json at it.

The release page (scripts/publish-oss-release.py) shows its Android tab only
when `<prefix>/android/latest.json` exists, and reads it client-side. The APK
ships on its own cadence (an EAS build, not the desktop release), so this script
only touches the android/ subtree and never re-renders the page.

Usage:
  OSS_ACCESS_KEY_ID=… OSS_ACCESS_KEY_SECRET=… OSS_ENDPOINT=… OSS_BUCKET=… \\
  OSS_PREFIX=beta CDN_BASE=https://teamclaw.ucar.cc \\
  python3 scripts/publish-android-apk.py path/to/app.apk --version 0.1.0 [--version-code 7]

The APK is stored under android/<version>/ and is never overwritten: re-running
with a version that already exists is refused unless --force is given.
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import oss2


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("apk")
    ap.add_argument("--version", required=True, help="user-facing version, e.g. 0.1.0")
    ap.add_argument("--version-code", type=int, help="Android versionCode (for in-app update checks)")
    ap.add_argument("--notes", default="")
    ap.add_argument("--force", action="store_true", help="overwrite an existing version")
    args = ap.parse_args()

    if not args.apk.endswith(".apk") or not os.path.isfile(args.apk):
        print(f"::error::not an .apk file: {args.apk}")
        return 1

    prefix = os.environ["OSS_PREFIX"].strip("/")
    cdn = os.environ["CDN_BASE"].rstrip("/")
    app_slug = os.environ.get("APP_SLUG", "TeamClu")
    endpoint = os.environ["OSS_ENDPOINT"]
    if not endpoint.startswith("http"):
        endpoint = "https://" + endpoint
    auth = oss2.Auth(os.environ["OSS_ACCESS_KEY_ID"], os.environ["OSS_ACCESS_KEY_SECRET"])
    bucket = oss2.Bucket(auth, endpoint, os.environ["OSS_BUCKET"])

    name = f"{app_slug}_{args.version}.apk"
    key = f"{prefix}/android/{args.version}/{name}"
    if bucket.object_exists(key) and not args.force:
        print(f"::error::{key} already exists; bump the version or pass --force")
        return 1

    size = os.path.getsize(args.apk)
    digest = sha256_of(args.apk)
    bucket.put_object_from_file(
        key,
        args.apk,
        headers={
            "Content-Type": "application/vnd.android.package-archive",
            "Content-Disposition": f'attachment; filename="{name}"',
        },
    )

    manifest = {
        "version": args.version,
        "versionCode": args.version_code,
        "url": f"{cdn}/{key}",
        "size": size,
        "sha256": digest,
        "notes": args.notes,
        "pub_date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    body = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode()
    bucket.put_object(f"{prefix}/android/{args.version}/latest.json", body,
                      headers={"Content-Type": "application/json; charset=utf-8"})
    # Mutable pointer the release page and future in-app update checks read.
    bucket.put_object(f"{prefix}/android/latest.json", body, headers={
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "max-age=60, must-revalidate",
    })

    print(f"✅ {cdn}/{key}  ({size / 1048576:.1f} MB, sha256 {digest[:16]}…)")
    print(f"✅ {cdn}/{prefix}/android/latest.json -> {args.version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
