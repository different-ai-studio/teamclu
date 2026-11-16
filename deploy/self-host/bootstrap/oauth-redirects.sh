#!/usr/bin/env bash
# Emit GoTrue's merged allow-list. Keep the query wildcard on one exact path.
set -euo pipefail
redirects="${1:-}"
domain="${2:-}"
# Literal membership. `grep -q` under pipefail exits at the first hit and
# SIGPIPEs `tr`, so the pipeline looks like a miss and the same callback is
# appended again.
append() {
  case ",${redirects}," in
    *,"$1",*) ;;
    *) redirects="${redirects:+$redirects,}$1" ;;
  esac
}
append 'http://127.0.0.1:*/callback'
append 'teamclu://auth-callback'
if [ -n "$domain" ]; then
  if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]; then
    echo 'Invalid LOGIN_DOMAIN: expected a hostname without URL or glob characters' >&2
    exit 1
  fi
  append "https://$domain/oauth/callback"
  # GoTrue glob ? means any character; [?] matches the literal query delimiter.
  append "https://$domain/oauth/callback[?]login_state=*"
fi
printf '%s' "$redirects"
