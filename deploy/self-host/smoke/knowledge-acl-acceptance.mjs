/**
 * Production acceptance for knowledge path ACL.
 *
 * Design §9 requires the server boundary be proven before anything else: an
 * unprivileged member must not be able to obtain restricted content, whether
 * they ask by path (manifest) or by content hash (download).
 *
 * Everything created here is disposable and namespaced `acl-accept-*`,
 * following the existing `e2e-*` convention. It never touches a real team, and
 * it removes what it made.
 *
 * Not part of run-e2e.sh: it seeds directly into the sync tables and creates
 * GoTrue accounts, which is more than a post-deploy smoke should do on every
 * push. Run it by hand when this feature changes.
 *
 * On the box, from deploy/self-host/:
 *
 *   FC_IP=$(docker inspect teamclaw-self-host-fc-1 \
 *     --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
 *   KONG_IP=$(docker inspect supabase-kong \
 *     --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
 *   ACC_FC_URL=http://$FC_IP:9000 \
 *   ACC_KONG_URL=http://$KONG_IP:8000 \
 *   ACC_SERVICE_ROLE_KEY=$(grep -E '^SERVICE_ROLE_KEY=' .env | head -1 | cut -d= -f2-) \
 *     node smoke/knowledge-acl-acceptance.mjs
 *
 * First run against production, 2026-09-01: 22/22 passed.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const FC = process.env.ACC_FC_URL;
const KONG = process.env.ACC_KONG_URL;
const SERVICE_ROLE_KEY = process.env.ACC_SERVICE_ROLE_KEY;
if (!FC || !KONG || !SERVICE_ROLE_KEY) throw new Error("ACC_FC_URL / ACC_KONG_URL / ACC_SERVICE_ROLE_KEY required");

const STAMP = Date.now();
let failures = 0;
const cleanup = [];

function check(label, cond, detail = "") {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}

/**
 * `asServiceRole` is needed for anything touching team_workspace_config:
 * guard_team_workspace_sync_fields() rejects writes to oss_change_seq from any
 * role but service_role, which is the same guard pgTAP 020 asserts.
 */
function sql(statement, { asServiceRole = false } = {}) {
  // `set local role` needs a transaction; psql -c wraps a multi-statement
  // string in one, so this is enough.
  //
  // `-q` matters: without it psql prints command tags (`SET`, `UPDATE 1`)
  // alongside the RETURNING value, and reading the last line back as a number
  // yields NaN.
  if (asServiceRole) statement = `set local role service_role; ${statement}`;
  const out = execFileSync(
    "docker",
    ["compose", "exec", "-T", "db", "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-c", statement],
    { cwd: "/opt/teamclaw/deploy/self-host", encoding: "utf8" },
  );
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

async function go(path, { method = "GET", body, serviceRole = false, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (serviceRole) { headers.apikey = SERVICE_ROLE_KEY; headers.authorization = `Bearer ${SERVICE_ROLE_KEY}`; }
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${KONG}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function fc(path, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${FC}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Confirmed GoTrue user + a real signed-in access token. */
async function makeUser(tag) {
  const email = `acl-accept-${tag}-${STAMP}@selfhost.test`;
  const password = `AclAccept-${STAMP}-${tag}`;
  const created = await go("/auth/v1/admin/users", {
    method: "POST", serviceRole: true,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.status !== 200) throw new Error(`create ${tag}: ${JSON.stringify(created.body)}`);
  const signin = await go("/auth/v1/token?grant_type=password", {
    method: "POST", serviceRole: true,
    body: JSON.stringify({ email, password }),
  });
  if (signin.status !== 200) throw new Error(`signin ${tag}: ${JSON.stringify(signin.body)}`);
  cleanup.push(async () => { await go(`/auth/v1/admin/users/${created.body.id}`, { method: "DELETE", serviceRole: true }); });
  return { userId: created.body.id, token: signin.body.access_token, email };
}

/** Seed a synced file straight into the tables the read path serves from. */
function seedFile(teamId, actorId, path, content) {
  const hash = createHash("sha256").update(content).digest("hex");
  const size = Buffer.byteLength(content);
  const ossKey = `teams/${teamId}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
  sql(`insert into amux.amuxc_blobs (team_id, content_hash, oss_key, size, verified)
       values ('${teamId}','${hash}','${ossKey}',${size},true)
       on conflict do nothing;`);
  const seq = Number(sql(`update amux.team_workspace_config set oss_change_seq = oss_change_seq + 1
                          where team_id='${teamId}' returning oss_change_seq;`, { asServiceRole: true }));
  const fileId = randomUUID();
  sql(`insert into amux.amuxc_files (id, team_id, path, current_version, content_hash, size, deleted, change_seq, updated_by)
       values ('${fileId}','${teamId}','${path}',1,'${hash}',${size},false,${seq},'${actorId}');`);
  sql(`insert into amux.amuxc_file_versions (file_id, version, parent_version, content_hash, size, deleted, created_by)
       values ('${fileId}',1,0,'${hash}',${size},false,'${actorId}');`);
  return { hash, path };
}

const manifestPaths = async (token, teamId, afterSeq = 0) => {
  const res = await fc("/v1/sync/manifest", { method: "POST", token, body: { teamId, afterSeq } });
  if (res.status !== 200) throw new Error(`manifest ${res.status}: ${JSON.stringify(res.body)}`);
  return { paths: res.body.items.map((i) => i.path).sort(), snapshotSeq: res.body.snapshotSeq };
};

// ───────────────────────────────────────────────────────────────────────────
const main = async () => {
  console.log(`\n=== knowledge path ACL — production acceptance (${new Date().toISOString()}) ===\n`);

  const owner = await makeUser("owner");
  const member = await makeUser("member");

  // Team, created through the real API so it is provisioned like any other.
  const teamName = `acl-accept-${STAMP}`;
  const created = await fc("/v1/teams", { method: "POST", token: owner.token, body: { name: teamName } });
  if (created.status >= 300) throw new Error(`create team: ${JSON.stringify(created.body)}`);
  const teamId = created.body.id;
  cleanup.push(async () => {
    // Unwind in FK order. `amuxc_file_versions.created_by` references actors
    // ON DELETE RESTRICT, so deleting the team first fails; and the org is
    // pinned by a public.users row that outlives the GoTrue account.
    sql(`delete from amux.amuxc_file_versions v using amux.amuxc_files f
         where v.file_id = f.id and f.team_id = '${teamId}';`);
    sql(`delete from amux.amuxc_files where team_id = '${teamId}';`);
    sql(`delete from amux.amuxc_blobs where team_id = '${teamId}';`);
    sql(`delete from amux.amuxc_access_log where team_id = '${teamId}';`);
    sql(`delete from amux.teams where id = '${teamId}';`);
    sql(`delete from public.users where org_id in (select id from public.orgs where name like 'acl-accept-owner-%');`);
    sql(`delete from public.orgs where name like 'acl-accept-owner-%';`);
  });
  console.log(`team ${teamId}  (${teamName})\n`);

  const ownerActor = sql(`select id from amux.actors where team_id='${teamId}' and user_id='${owner.userId}';`);
  if (!ownerActor) throw new Error("owner actor missing");

  // Second member. The invite flow answers upgrade_required for a team in the
  // default org, which is a different feature's contract — not what is under
  // test here — so the actor is seeded directly, in this disposable team only.
  const memberActor = randomUUID();
  sql(`insert into amux.actors (id, team_id, actor_type, display_name, user_id)
       values ('${memberActor}','${teamId}','member','ACL Accept Member','${member.userId}');`);
  sql(`insert into amux.members (id, status) values ('${memberActor}','active');`);
  sql(`insert into amux.team_members (team_id, member_id, role) values ('${teamId}','${memberActor}','member');`);
  sql(`insert into amux.team_workspace_config (team_id, sync_mode, oss_change_seq)
       values ('${teamId}','oss',0) on conflict (team_id) do nothing;`, { asServiceRole: true });

  const secret = seedFile(teamId, ownerActor, "knowledge/hr/salary.md", "restricted payroll\n");
  const open = seedFile(teamId, ownerActor, "knowledge/open/notes.md", "everyone may read\n");

  // ── 1. Baseline: no rules, both members see everything ───────────────────
  console.log("1. baseline — no rules configured");
  const baseOwner = await manifestPaths(owner.token, teamId);
  const baseMember = await manifestPaths(member.token, teamId);
  check("owner sees both files", baseOwner.paths.length === 2, JSON.stringify(baseOwner.paths));
  check("member sees both files", baseMember.paths.length === 2, JSON.stringify(baseMember.paths));
  const memberCursor = baseMember.snapshotSeq;

  const dlBefore = await fc("/v1/sync/download", { method: "POST", token: member.token, body: { teamId, contentHash: secret.hash } });
  check("member can download the file before it is restricted", dlBefore.status === 200, `status ${dlBefore.status}`);

  // ── 2. Restrict knowledge/hr/ to the owner ───────────────────────────────
  console.log("\n2. restrict knowledge/hr/ to the owner only");
  const preview = await fc(`/v1/teams/${teamId}/knowledge-acl/preview`, {
    method: "POST", token: owner.token, body: { pathPrefix: "knowledge/hr/", actorIds: [ownerActor] },
  });
  check("preview reports 1 affected file", preview.body?.affectedFiles === 1, JSON.stringify(preview.body));
  check("preview reports 1 affected member", preview.body?.affectedMembers === 1, JSON.stringify(preview.body));

  const noConfirm = await fc(`/v1/teams/${teamId}/knowledge-acl`, {
    method: "POST", token: owner.token, body: { pathPrefix: "knowledge/hr/", actorIds: [ownerActor] },
  });
  check("creating over existing files without confirmation is refused (409)", noConfirm.status === 409, `status ${noConfirm.status}`);

  const rule = await fc(`/v1/teams/${teamId}/knowledge-acl`, {
    method: "POST", token: owner.token,
    body: { pathPrefix: "knowledge/hr/", actorIds: [ownerActor], confirmRevokeExisting: true },
  });
  check("rule created with confirmation", rule.status === 201, JSON.stringify(rule.body));
  const aclId = rule.body?.id;

  const memberIsNotAdmin = await fc(`/v1/teams/${teamId}/knowledge-acl`, { token: member.token });
  check("an ordinary member cannot read the rule list", memberIsNotAdmin.status === 403, `status ${memberIsNotAdmin.status}`);

  // ── 3. THE BOUNDARY ──────────────────────────────────────────────────────
  console.log("\n3. the boundary — denied member must not obtain restricted content");
  const afterOwner = await manifestPaths(owner.token, teamId);
  const afterMember = await manifestPaths(member.token, teamId);
  check("owner still sees both files", afterOwner.paths.length === 2, JSON.stringify(afterOwner.paths));
  check("member's manifest no longer lists the restricted path",
        !afterMember.paths.includes("knowledge/hr/salary.md"), JSON.stringify(afterMember.paths));
  check("member still receives the open path", afterMember.paths.includes("knowledge/open/notes.md"), JSON.stringify(afterMember.paths));

  // The hash is already known to the member from step 1 — this is the door
  // that filtering the manifest alone would leave open.
  const dlDenied = await fc("/v1/sync/download", { method: "POST", token: member.token, body: { teamId, contentHash: secret.hash } });
  check("member CANNOT download by a content hash they already know",
        dlDenied.status === 403 && dlDenied.body?.code === "PathForbidden", `status ${dlDenied.status} ${JSON.stringify(dlDenied.body)}`);

  const dlOpen = await fc("/v1/sync/download", { method: "POST", token: member.token, body: { teamId, contentHash: open.hash } });
  check("member can still download the unrestricted file", dlOpen.status === 200, `status ${dlOpen.status}`);

  const verDenied = await fc(`/v1/sync/versions?path=${encodeURIComponent("knowledge/hr/salary.md")}&teamId=${teamId}`, { token: member.token });
  check("member cannot read version history of the restricted path", verDenied.status === 403, `status ${verDenied.status}`);

  const upDenied = await fc("/v1/sync/upload/prepare", {
    method: "POST", token: member.token,
    body: { teamId, path: "knowledge/hr/sneak.md", parentVersion: 0, contentHash: "a".repeat(64), size: 5 },
  });
  check("member cannot write into the restricted prefix",
        upDenied.status === 403 && upDenied.body?.code === "PathForbidden", `status ${upDenied.status} ${JSON.stringify(upDenied.body)}`);

  // ── 4. Granting later re-surfaces content that predates the grant ────────
  console.log("\n4. granting later must deliver files that predate the grant");
  const granted = await fc(`/v1/teams/${teamId}/knowledge-acl/${aclId}`, {
    method: "PATCH", token: owner.token, body: { addActorIds: [memberActor] },
  });
  check("grant accepted", granted.status === 200, JSON.stringify(granted.body));

  // Asking from the cursor the member had already advanced to. Without the
  // change_seq bump this is empty forever.
  const resurfaced = await fc("/v1/sync/manifest", { method: "POST", token: member.token, body: { teamId, afterSeq: memberCursor } });
  const resurfacedPaths = (resurfaced.body?.items ?? []).map((i) => i.path);
  check("the restricted file re-appears past the member's old cursor",
        resurfacedPaths.includes("knowledge/hr/salary.md"), JSON.stringify(resurfacedPaths));

  const dlAfterGrant = await fc("/v1/sync/download", { method: "POST", token: member.token, body: { teamId, contentHash: secret.hash } });
  check("member can download it once granted", dlAfterGrant.status === 200, `status ${dlAfterGrant.status}`);

  // ── 5. Audit ─────────────────────────────────────────────────────────────
  console.log("\n5. audit — what the feature can actually deliver");
  const denials = Number(sql(`select count(*) from amux.amuxc_access_log where team_id='${teamId}' and allowed=false;`));
  const allowed = Number(sql(`select count(*) from amux.amuxc_access_log where team_id='${teamId}' and allowed=true;`));
  check("denied attempts were recorded", denials > 0, `denied rows = ${denials}`);
  check("permitted access to restricted content was recorded", allowed > 0, `allowed rows = ${allowed}`);

  // ── 6. Removing the rule reopens the prefix ──────────────────────────────
  console.log("\n6. removing the rule reopens the prefix");
  const removed = await fc(`/v1/teams/${teamId}/knowledge-acl/${aclId}`, { method: "DELETE", token: owner.token });
  check("rule deleted", removed.status === 204, `status ${removed.status}`);
  const reopened = await manifestPaths(member.token, teamId);
  check("member sees everything again", reopened.paths.length === 2, JSON.stringify(reopened.paths));
};

main()
  .catch((e) => { failures++; console.error(`\nABORTED: ${e.message}`); })
  .finally(async () => {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.error(`cleanup: ${e.message}`); } }
    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} — test data removed ===\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
