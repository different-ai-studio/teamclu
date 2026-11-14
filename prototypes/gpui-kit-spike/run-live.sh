#!/usr/bin/env bash
# Throwaway: pull TeamClu Desktop localStorage session + launch spike live.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${TMPDIR:-/tmp}/teamclu-spike-auth.env"

python3 - <<'PY' "$ENV_FILE"
import json, os, sqlite3, sys, glob
out = sys.argv[1]
base = os.path.expanduser("~/Library/WebKit/com.teamclu.app/WebsiteData/Default")
dbs = glob.glob(base + "/**/LocalStorage/localstorage.sqlite3", recursive=True)
if not dbs:
    raise SystemExit("no TeamClu WebKit localStorage — is Desktop installed/logged in?")

def read_session(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    row = con.execute(
        "select value from ItemTable where key=?", ("teamclu.session.v1",)
    ).fetchone()
    if not row:
        return None, None, None
    val = row[0]
    text = val.decode("utf-16-le").replace("\x00", "") if isinstance(val, bytes) else str(val)
    session = json.loads(text)
    def get(key):
        r = con.execute("select value from ItemTable where key=?", (key,)).fetchone()
        if not r:
            return None
        v = r[0]
        return v.decode("utf-16-le").replace("\x00", "") if isinstance(v, bytes) else str(v)
    api = (get("teamclu.cloudApiUrl.override") or "https://teamclaw-api.ucar.cc").strip().rstrip("/")
    team = None
    solo = []
    ct = get("teamclu:current-team")
    if ct:
        try:
            j = json.loads(ct)
            if isinstance(j, dict):
                team = (j.get("team") or {}).get("id") or j.get("id")
                member = (j.get("currentMember") or {}).get("id")
                if member:
                    solo.append(member)
        except Exception:
            pass
    local_agent = get("teamclu-local-daemon-actor-id")
    if local_agent:
        solo.append(local_agent.strip().strip('"'))
    if not team:
        # fallback: daemon.toml active_team
        dt = os.path.expanduser("~/.amuxd/daemon.toml")
        if os.path.isfile(dt):
            for line in open(dt):
                if line.strip().startswith("active_team"):
                    team = line.split("=", 1)[1].strip().strip('"')
                    break
    return session.get("access_token"), team, api, solo

token = team = api = None
solo = []
for db in sorted(dbs, key=os.path.getmtime, reverse=True):
    token, team, api, solo = read_session(db)
    if token and team:
        break
if not token or not team:
    raise SystemExit("logged-in session not found in Desktop localStorage")

with open(out, "w") as f:
    f.write(f"TEAMCLU_ACCESS_TOKEN={token}\n")
    f.write(f"TEAMCLU_TEAM_ID={team}\n")
    f.write(f"TEAMCLU_CLOUD_API_URL={api}\n")
    f.write(f"TEAMCLU_SOLO_ACTOR_IDS={','.join(solo)}\n")
os.chmod(out, 0o600)
print(f"api={api}")
print(f"team={team[:8]}…")
print(f"solo_ids={len(solo)}")
print(f"env={out}")
PY

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/openbeta/workspace/teamclaw/.cargo-target-gpui-spike}"
cd "$ROOT"
exec cargo run
