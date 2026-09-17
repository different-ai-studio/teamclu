#!/usr/bin/env bash
# Gate: reqwest must resolve rustls-only in the release unified sidecar build.
#
# release-oss builds `-p amuxd -p teamclu-introspect` in ONE cargo invocation
# ("Build all (parallel)" / "Build frontend + sidecars (parallel)"), and cargo
# unifies reqwest's features across that selection. One crate leaving
# reqwest's `default` on merges native-tls into the union — and reqwest then
# picks native-tls, not rustls, as the default Client::new() backend
# (reqwest's TlsBackend::default: default-tls wins whenever it is compiled
# in). That is the beta.63 /v1/auth/refresh breakage: the shipped daemon
# used a TLS backend none of its own manifests declare.
#
# This gate resolves the SAME package selection with --locked and fails if
# reqwest carries default / default-tls / native-tls, or if no rustls backend
# is compiled in. Keep the -p list below in sync with the release
# invocations; scripts/lib/reqwest-default-features.test.js guards the
# manifests repo-wide.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The exact selection release-oss builds in one invocation; --locked because
# the release builds are --locked too, so the gate sees exactly what they see.
tree="$(cargo tree --locked -e features -p amuxd -p teamclu-introspect)"

# 1) A rustls backend must be compiled in. Without this check, a manifest with
#    only e.g. features = ["json"] would pass the forbidden-feature check
#    below while producing a reqwest that cannot do HTTPS at all.
#
#    No `grep -q` anywhere in this script: under `set -o pipefail`, grep -q
#    exits at the first match, printf then dies to SIGPIPE (141), and the
#    pipeline reads as a FAILURE despite the match. Plain grep + /dev/null
#    reads the whole input, so the pipeline status is grep's own.
if ! printf '%s\n' "$tree" | grep -E '(^|[^[:alnum:]_-])reqwest feature "__rustls"' > /dev/null; then
  echo "✗ reqwest has no rustls backend in the unified amuxd + teamclu-introspect graph."
  echo "  Add a rustls-tls-* feature to the manifest that dropped it."
  exit 1
fi

# 2) native-tls must not be merged into the unified reqwest. The char-class
#    prefix keeps e.g. a hypothetical "x-reqwest" package from matching, and
#    the closing quote in each alternative keeps "default" from matching
#    "default-tls" (and neither matches rustls-tls-native-roots).
if hits="$(printf '%s\n' "$tree" | grep -En '(^|[^[:alnum:]_-])reqwest feature "(default|default-tls|native-tls)"')"; then
  echo "✗ reqwest carries a native-tls/default feature in the unified amuxd + teamclu-introspect graph:"
  printf '%s\n' "$hits"
  echo ""
  echo "  Who enabled it:"
  cargo tree --locked -e features -p amuxd -p teamclu-introspect -i reqwest || true
  echo ""
  echo "  Every Cargo.toml that declares reqwest must set default-features = false and"
  echo "  use a rustls-tls-* feature — scripts/lib/reqwest-default-features.test.js"
  echo "  enforces the manifests."
  exit 1
fi

echo "✓ Unified amuxd + teamclu-introspect graph resolves reqwest rustls-only (no default / default-tls / native-tls)."
