#!/usr/bin/env bash
# Run only against a dedicated Hangzhou production acceptance App repository.
# Tokens are read from the environment and never embedded in a Git URL or log.
set -euo pipefail
set +x

: "${TEAMCLU_GIT_TEST_REPO_URL:?dedicated HTTPS App repo URL required}"
: "${TEAMCLU_GIT_ADMIN_TOKEN:?admin git token required}"
: "${TEAMCLU_GIT_WRITE_TOKEN:?write git token required}"
: "${TEAMCLU_GIT_READ_TOKEN:?read git token required}"
: "${TEAMCLU_GIT_OUTSIDER_TOKEN:?outside-org git token required}"

validate_repo_url() { node -e '
  const u = new URL(process.argv[1]);
  if (u.protocol !== "https:" || u.host !== "gitea.teamclu.cn" || u.username || u.password ||
      !/^\/o[0-9a-f]{32}\/tc-app-[0-9a-f-]+\.git$/.test(u.pathname)) {
    process.exitCode = 1;
  }
' "$1"; }
validate_repo_url "$TEAMCLU_GIT_TEST_REPO_URL" || { echo "Refusing non-dedicated Git URL" >&2; exit 2; }
if [[ -n "${TEAMCLU_GIT_PERSONAL_REPO_URL:-}" ]]; then
  validate_repo_url "$TEAMCLU_GIT_PERSONAL_REPO_URL" || { echo "Refusing non-dedicated personal Git URL" >&2; exit 2; }
fi

host_json="$(curl --fail --silent --show-error https://api.teamclu.cn/v1/git/host)"
node -e '
  const h = JSON.parse(process.argv[1]);
  if (h.gitHost !== "gitea.teamclu.cn" || h.gitScheme !== "https") process.exitCode = 1;
' "$host_json" || { echo "Cloud API Git host is not the production HTTPS host" >&2; exit 1; }
echo "PASS /v1/git/host: gitea.teamclu.cn (https)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
askpass="$work/askpass"
cat > "$askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *sername*) printf '%s\n' teamclu ;;
  *assword*) printf '%s\n' "$TEAMCLU_GIT_ACTIVE_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 700 "$askpass"

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
git_as() {
  local token="$1"
  shift
  TEAMCLU_GIT_ACTIVE_TOKEN="$token" GIT_ASKPASS="$askpass" git "$@"
}
expect_rejected() {
  local label="$1"
  shift
  if "$@" >"$work/probe.log" 2>&1; then
    echo "FAIL $label: operation unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -Eiq '401|403|404|authentication failed|access denied|repository not found|could not read username|unable to read askpass' "$work/probe.log"; then
    echo "FAIL $label: failure was not a recognized authorization rejection" >&2
    exit 1
  fi
  echo "PASS $label: rejected"
}

expect_rejected "anonymous clone" env GIT_ASKPASS=/bin/false git ls-remote "$TEAMCLU_GIT_TEST_REPO_URL"
expect_rejected "forged identity without token" env GIT_ASKPASS=/bin/false GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="X-WEBAUTH-USER: u00000000000000000000000000000000" \
  git ls-remote "$TEAMCLU_GIT_TEST_REPO_URL"
expect_rejected "outside-org clone" git_as "$TEAMCLU_GIT_OUTSIDER_TOKEN" ls-remote "$TEAMCLU_GIT_TEST_REPO_URL"

git_as "$TEAMCLU_GIT_ADMIN_TOKEN" clone --quiet "$TEAMCLU_GIT_TEST_REPO_URL" "$work/repo"
echo "PASS admin clone"
git_as "$TEAMCLU_GIT_WRITE_TOKEN" -C "$work/repo" fetch --quiet origin
echo "PASS write fetch"
git_as "$TEAMCLU_GIT_READ_TOKEN" -C "$work/repo" fetch --quiet origin
echo "PASS read fetch"
expect_rejected "outside-org fetch" git_as "$TEAMCLU_GIT_OUTSIDER_TOKEN" -C "$work/repo" fetch --quiet origin

branch_prefix="acceptance-$(date -u +%Y%m%dT%H%M%SZ)-$$"
for role in admin write read outsider; do
  case "$role" in
    admin) token="$TEAMCLU_GIT_ADMIN_TOKEN" ;;
    write) token="$TEAMCLU_GIT_WRITE_TOKEN" ;;
    read) token="$TEAMCLU_GIT_READ_TOKEN" ;;
    outsider) token="$TEAMCLU_GIT_OUTSIDER_TOKEN" ;;
  esac
  branch="$branch_prefix-$role"
  git -C "$work/repo" switch --quiet -c "$branch"
  GIT_AUTHOR_NAME="TeamClu acceptance" GIT_AUTHOR_EMAIL="acceptance@teamclu.invalid" \
  GIT_COMMITTER_NAME="TeamClu acceptance" GIT_COMMITTER_EMAIL="acceptance@teamclu.invalid" \
    git -C "$work/repo" commit --quiet --allow-empty -m "Acceptance $role $branch"
  sha="$(git -C "$work/repo" rev-parse HEAD)"
  if [[ "$role" == admin || "$role" == write ]]; then
    git_as "$token" -C "$work/repo" push --quiet "$TEAMCLU_GIT_TEST_REPO_URL" "HEAD:refs/heads/$branch"
    echo "PASS $role push: $branch $sha (verify Gitea pusher audit identity)"
  else
    expect_rejected "$role push" git_as "$token" -C "$work/repo" push --quiet "$TEAMCLU_GIT_TEST_REPO_URL" "HEAD:refs/heads/$branch"
    if [[ "$role" == read ]]; then
      expect_rejected "read token with forged admin identity push" env \
        TEAMCLU_GIT_ACTIVE_TOKEN="$TEAMCLU_GIT_READ_TOKEN" GIT_ASKPASS="$askpass" GIT_CONFIG_COUNT=1 \
        GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="X-WEBAUTH-USER: u00000000000000000000000000000000" \
        git -C "$work/repo" push --quiet "$TEAMCLU_GIT_TEST_REPO_URL" "HEAD:refs/heads/$branch"
    fi
  fi
done

if [[ -n "${TEAMCLU_GIT_PERSONAL_REPO_URL:-}" ]]; then
  expect_rejected "ungranted personal App read" git_as "$TEAMCLU_GIT_READ_TOKEN" ls-remote "$TEAMCLU_GIT_PERSONAL_REPO_URL"
fi

echo "Automatic Git checks passed. Verify the two successful push actors in Gitea audit and run the old-App SSH publish check."
