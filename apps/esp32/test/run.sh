#!/usr/bin/env bash
# Host tests for the hardware-independent modules. No toolchain, no device.
set -euo pipefail
cd "$(dirname "$0")"
CXX=${CXX:-c++}
tmp=$(mktemp -d)
rc=0

build_and_run() {
  local name=$1; shift
  "$CXX" -std=c++17 -Wall -Wextra -O1 -o "$tmp/$name" "$@" || { echo "BUILD FAILED: $name"; return 1; }
  "$tmp/$name" || return 1
}

build_and_run face_state_test test_face_state.cpp ../main/face/face_state.cpp || rc=1
echo
build_and_run sleep_policy_test test_sleep_policy.cpp ../main/power/sleep_policy.cpp || rc=1
echo
build_and_run ctl_parse_test test_ctl_parse.cpp ../main/net/ctl_parse.cpp || rc=1

exit $rc
