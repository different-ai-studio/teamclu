/**
 * The three team_skills tables, as raw SQL for pglite.
 *
 * They live only in services/supabase/migrations, not in the drizzle migrations
 * that makeTestDb() replays, so `makeTestDb` applies this after
 * replaying them. This is a hand-kept mirror of
 * src/db/schema/team-skills.ts — one copy, applied by the harness,
 * because a per-suite copy is one more thing to forget when a column moves.
 * Drop it once a drizzle migration covers these tables.
 */
export const TEAM_SKILLS_BOOTSTRAP = `
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
