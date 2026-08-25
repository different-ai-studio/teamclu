/**
 * pg-repo-team-skills-authz — who may write to the team skills registry.
 *
 * The rule under test: **every team member may edit and publish.** The registry
 * is team property; `owner_actor_id` records who is responsible for a skill, it
 * does not decide who may change it. Installing stays gated separately — that
 * one writes to somebody's machine, not to shared content.
 *
 * Bootstrap note: the three team_skills tables live only in
 * services/supabase/migrations, not in the drizzle migrations that
 * makeTestDb() replays, so this file creates them. It mirrors
 * src/db/schema/team-skills.ts; drop the bootstrap once a drizzle migration
 * covers them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { actors, agents, members, teamMembers } from "../src/db/schema/index.js";

const BOOTSTRAP = `
create table if not exists team_skills (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  slug text not null,
  owner_actor_id uuid references actors(id) on delete set null,
  summary text not null,
  category text not null,
  when_to_use text not null,
  when_not_to_use text not null,
  requires jsonb,
  status text not null default 'published',
  superseded_by text,
  latest_version integer not null default 0,
  created_by uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Marketplace subscription columns (design 4.3). This bootstrap is a hand
  -- kept copy of services/supabase/migrations/*, and the marketplace migration
  -- added these without updating it, so every test in this file died on
  -- 'column origin of relation team_skills does not exist' - taking the whole
  -- team-skill write path out of coverage.
  origin text not null default 'local',
  upstream_slug text,
  upstream_subscribed boolean not null default false,
  upstream_detached_at timestamptz
);
create unique index if not exists uniq_team_skills_team_slug on team_skills (team_id, slug);
create index if not exists idx_team_skills_upstream_slug_marketplace
  on team_skills (upstream_slug) where origin = 'marketplace';

create table if not exists team_skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references team_skills(id) on delete cascade,
  version integer not null,
  content_hash text not null,
  size bigint not null default 0,
  changelog text not null,
  summary text not null,
  when_to_use text not null,
  when_not_to_use text not null,
  requires jsonb,
  created_by uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Where this version's package lives. Rows scoped to the marketplace resolve
  -- through object_path and are deliberately absent from amuxc_blobs (4.1).
  upstream_version integer,
  blob_scope text not null default 'team',
  object_path text
);
create unique index if not exists uniq_team_skill_version on team_skill_versions (skill_id, version);

create table if not exists team_skill_installs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  skill_id uuid not null references team_skills(id) on delete cascade,
  installed_version integer not null,
  scope text not null default 'global',
  workspace_id uuid,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The upsert in installTeamSkill names exactly this index as its conflict
-- target, so without it every install here dies inside pglite rather than in
-- the gate under test. coalesce is in the key because NULLs never collide in
-- a unique index — mirrors 20260806000000_team_skills_registry.sql.
create unique index if not exists uniq_team_skill_install
  on team_skill_installs (
    actor_id,
    skill_id,
    scope,
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
`;

async function seedMember(db: any, teamId: string, userId: string, role = "member") {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: `M-${userId}`, userId })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role });
  return actor;
}

async function seedAgentActor(db: any, teamId: string, ownerMemberId: string, visibility: string) {
  const [agentActor] = await db
    .insert(actors)
    .values({ teamId, actorType: "agent", displayName: "TestBot" })
    .returning();
  await db.insert(agents).values({
    id: agentActor.id,
    agentKind: "claude",
    status: "active",
    visibility,
    ownerMemberId,
  });
  return agentActor;
}

/** A team whose owner published `deploy-check`, plus an unrelated plain member. */
async function scenario() {
  const { db, pg } = await makeTestDb();
  await pg.exec(BOOTSTRAP);

  const ownerUserId = `owner-${Math.random()}`;
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUserId });
  const team = await ownerRepo.createTeam({ name: "Skills Team" });
  const ownerActor = await db.query.actors.findFirst({ where: eq(actors.teamId, team.id) });

  await ownerRepo.createTeamSkill(team.id, {
    slug: "deploy-check",
    summary: "Pre-deploy checklist",
    category: "devops",
    whenToUse: "before a release",
    whenNotToUse: "hotfixes",
    changelog: "first cut",
    contentHash: "a".repeat(64),
    size: 12,
  });

  const memberUserId = `member-${Math.random()}`;
  const memberActor = await seedMember(db, team.id, memberUserId);
  const memberRepo = createPgBusinessRepository({ db, userId: memberUserId });

  return { db, team, ownerActor, memberActor, memberRepo };
}

/**
 * A member's own machine is an agent, and it is the actor the daemon's inventory
 * answers about. Sharing or publishing a skill from the desktop installs into
 * that machine's skills root, so the install has to be recordable against it —
 * the alternative is a record on the member that the machine's own inventory
 * never reads, which is how a freshly shared skill vanished from the column.
 *
 * Its visibility is `personal`; the pre-existing team-agent gate needs admin and
 * would have refused this outright.
 */
test("a member may install on a personal agent they own", async () => {
  const { db, team, memberActor, memberRepo } = await scenario();
  const agentActor = await seedAgentActor(db, team.id, memberActor.id, "personal");

  const install = await memberRepo.installTeamSkill(team.id, "deploy-check", {
    actorId: agentActor.id,
    version: 1,
  });

  assert.equal(install.actorId, agentActor.id);
});

/** Ownership, not agent-ness: somebody else's machine stays off limits. */
test("a member may not install on an agent they do not own", async () => {
  const { db, team, ownerActor, memberRepo } = await scenario();
  const agentActor = await seedAgentActor(db, team.id, ownerActor.id, "personal");

  await assert.rejects(
    () => memberRepo.installTeamSkill(team.id, "deploy-check", { actorId: agentActor.id, version: 1 }),
    /personal/,
  );
});

/** And the install the owner just recorded is theirs to take back. */
test("an owner may uninstall from their own personal agent", async () => {
  const { db, team, memberActor, memberRepo } = await scenario();
  const agentActor = await seedAgentActor(db, team.id, memberActor.id, "personal");
  await memberRepo.installTeamSkill(team.id, "deploy-check", {
    actorId: agentActor.id,
    version: 1,
  });

  await memberRepo.uninstallTeamSkill(team.id, "deploy-check", { actorId: agentActor.id });

  const rows = await memberRepo.listTeamSkillInstalls(team.id, { actorId: agentActor.id });
  assert.equal(rows.length, 0);
});

test("a plain member can publish a new version of somebody else's skill", async () => {
  const { team, ownerActor, memberActor, memberRepo } = await scenario();

  const version = await memberRepo.createTeamSkillVersion(team.id, "deploy-check", {
    changelog: "fixed the rollback step",
    contentHash: "b".repeat(64),
    size: 20,
  });

  assert.equal(version.version, 2);
  // Authorship is recorded per version; ownership of the skill does not move.
  assert.equal(version.createdBy, memberActor.id);
  const after = await memberRepo.getTeamSkill(team.id, "deploy-check");
  assert.equal(after.latestVersion, 2);
  assert.equal(after.ownerActorId, ownerActor!.id);
});

test("a plain member can revert to an earlier version", async () => {
  const { team, memberRepo } = await scenario();
  await memberRepo.createTeamSkillVersion(team.id, "deploy-check", {
    changelog: "bad publish",
    contentHash: "c".repeat(64),
  });

  const reverted = await memberRepo.revertTeamSkillVersion(team.id, "deploy-check", 1);

  // Reverting rolls forward with old content — versions only ever go up.
  assert.equal(reverted.version, 3);
  assert.equal(reverted.contentHash, "a".repeat(64));
});

test("a plain member can edit metadata and deprecate", async () => {
  const { team, memberRepo } = await scenario();

  const patched = await memberRepo.updateTeamSkill(team.id, "deploy-check", {
    summary: "Checklist before shipping",
    status: "deprecated",
    supersededBy: "ship-check",
  });

  assert.equal(patched.summary, "Checklist before shipping");
  assert.equal(patched.status, "deprecated");
  assert.equal(patched.supersededBy, "ship-check");
});

test("a plain member can delete a skill", async () => {
  const { team, memberRepo } = await scenario();

  await memberRepo.deleteTeamSkill(team.id, "deploy-check");

  await assert.rejects(
    () => memberRepo.getTeamSkill(team.id, "deploy-check"),
    (e: any) => e.statusCode === 404,
  );
});

test("someone outside the team still cannot touch it", async () => {
  const { db, team } = await scenario();
  // Open to members, not to everyone: the membership check is now the only
  // thing standing between a stranger's token and the team's registry.
  const outsider = createPgBusinessRepository({ db, userId: `stranger-${Math.random()}` });

  await assert.rejects(
    () =>
      outsider.createTeamSkillVersion(team.id, "deploy-check", {
        changelog: "nope",
        contentHash: "d".repeat(64),
      }),
    (e: any) => e.statusCode === 403,
  );
  await assert.rejects(
    () => outsider.deleteTeamSkill(team.id, "deploy-check"),
    (e: any) => e.statusCode === 403,
  );
});

/**
 * Reverting a marketplace-adopted skill.
 *
 * Two defects lived here and they compound: the new version carried neither
 * `blob_scope` nor `object_path`, so its download fell into the team-blob
 * branch and 409'd forever (marketplace packages are deliberately absent from
 * amuxc_blobs); and revert was the only team-skill write path without the
 * detach guard, so the next lazy align read `upstream_version = null` as
 * "upstream 0" and re-projected marketplace latest — erasing the revert on the
 * very next list request, silently.
 */
test("revert on a subscribed marketplace skill keeps the blob and detaches", async () => {
  const { db, team, ownerActor, memberRepo } = await scenario();
  const [skillRow] = await db.execute(
    `select id from team_skills where team_id = '${team.id}' and slug = 'deploy-check'`,
  ).then((r: any) => r.rows ?? r);

  // Make it look adopted-and-aligned: subscribed skill at v2, both versions
  // marketplace-scoped, exactly as adopt + align would leave it.
  await db.execute(
    `update team_skills
       set origin = 'marketplace', upstream_slug = 'deploy-check',
           upstream_subscribed = true, latest_version = 2
     where id = '${skillRow.id}'`,
  );
  await db.execute(
    `update team_skill_versions
       set blob_scope = 'marketplace', object_path = 'marketplace/blobs/sha256/aa/aa/${"a".repeat(64)}',
           upstream_version = 1
     where skill_id = '${skillRow.id}' and version = 1`,
  );
  await db.execute(
    `insert into team_skill_versions
       (skill_id, version, content_hash, size, changelog, summary, when_to_use,
        when_not_to_use, created_by, blob_scope, object_path, upstream_version)
     values ('${skillRow.id}', 2, '${"b".repeat(64)}', 20, 'upstream v2', 's', 'w',
             'n', '${ownerActor!.id}',
             'marketplace', 'marketplace/blobs/sha256/bb/bb/${"b".repeat(64)}', 2)`,
  );

  const reverted = await memberRepo.revertTeamSkillVersion(team.id, "deploy-check", 1);

  assert.equal(reverted.version, 3);
  // The package has to remain resolvable, which means the blob's home travels
  // with the content it belongs to.
  assert.equal(reverted.contentHash, "a".repeat(64));
  const [v3] = await db.execute(
    `select blob_scope, object_path, upstream_version from team_skill_versions
      where skill_id = '${skillRow.id}' and version = 3`,
  ).then((r: any) => r.rows ?? r);
  assert.equal(v3.blob_scope, "marketplace");
  assert.equal(v3.object_path, `marketplace/blobs/sha256/aa/aa/${"a".repeat(64)}`);

  // And the subscription is off, so nothing overwrites the revert.
  const after = await memberRepo.getTeamSkill(team.id, "deploy-check");
  assert.equal(after.upstreamSubscribed, false);
});
