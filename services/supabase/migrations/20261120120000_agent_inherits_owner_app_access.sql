-- An agent can reach the apps its owner can reach.
--
-- Since per-account Gitea auth (#1888) an agent pushes, pulls and calls the
-- Cloud API as itself, and holds no access to an app unless someone grants it.
-- In practice that meant every person granting each of their own bots on each
-- of their apps, one row at a time — and an agent that worked on an app the
-- day before stopping dead the moment the app moved to per-account auth.
--
-- The rule: an ACTIVE agent (amux.agents.status = 'active') inherits the level
-- its owner (amux.agents.owner_member_id) has on an app in the same team —
-- `admin` when the owner created the app, otherwise the owner's grant. Taking
-- the owner's access away takes the agent's with it; nothing is copied.
--
-- What an inherited level does NOT allow is decided in the Cloud API, which
-- refuses an inherited caller the two things a bot should never do on its
-- owner's behalf: change who has access, and delete the app. RLS cannot carry
-- that distinction (it has no notion of level), so it only learns "this agent
-- may see the app".
--
-- Explicit grants to agents stay, for an agent whose owner has no access.

-- ── The rule, in one place ─────────────────────────────────────────────────
--
-- Every agent that inherits access to an app, with whom it inherits from and
-- at what level. The per-agent check below, the Gitea collaborator sync and the
-- access tab all read this, so the rule cannot drift between them.
--
-- Service role only: it lists other people's agents.

create or replace function amux.app_inherited_agents(p_app_id uuid)
returns table (agent_id uuid, owner_actor_id uuid, permission_level text)
language sql
stable
security definer
set search_path to 'amux', 'public'
as $$
  with owners as (
    select a.created_by_actor_id as owner_actor_id, 'admin'::text as permission_level
      from amux.apps a
     where a.id = p_app_id and a.created_by_actor_id is not null
    union all
    select ama.member_id, ama.permission_level
      from amux.app_member_access ama
     where ama.app_id = p_app_id
  ),
  -- A creator who also holds a grant inherits as the creator.
  best as (
    select distinct on (o.owner_actor_id) o.owner_actor_id, o.permission_level
      from owners o
     order by o.owner_actor_id,
              case o.permission_level when 'admin' then 0 when 'write' then 1 else 2 end
  )
  select g.id, b.owner_actor_id, b.permission_level
    from best b
    join amux.actors owner on owner.id = b.owner_actor_id and owner.actor_type = 'member'
    join amux.agents g on g.owner_member_id = b.owner_actor_id and g.status = 'active'
    join amux.actors ag on ag.id = g.id and ag.actor_type = 'agent'
    join amux.apps a on a.id = p_app_id
   where owner.team_id = a.team_id
     and ag.team_id = a.team_id;
$$;

comment on function amux.app_inherited_agents(uuid) is
  'Every active agent that inherits access to the app from its owner (a member who created it or holds a grant), with the owner and the inherited level. Single source of the inheritance rule.';

revoke all on function amux.app_inherited_agents(uuid) from public;
grant execute on function amux.app_inherited_agents(uuid) to service_role;

-- ── The inherited level of one agent ───────────────────────────────────────

create or replace function amux.agent_inherited_app_level(p_app_id uuid, p_actor_id uuid)
returns text
language sql
stable
security definer
set search_path to 'amux', 'public'
as $$
  select i.permission_level
    from amux.app_inherited_agents(p_app_id) i
   where i.agent_id = p_actor_id;
$$;

comment on function amux.agent_inherited_app_level(uuid, uuid) is
  'The level an active agent inherits on an app from its owner (admin for the creator, else the owner''s grant), or null. The Cloud API refuses an inherited caller access management and app deletion.';

revoke all on function amux.agent_inherited_app_level(uuid, uuid) from public;
grant execute on function amux.agent_inherited_app_level(uuid, uuid) to authenticated, service_role;

-- ── Visibility: a grant, or an owner with access ───────────────────────────
--
-- Both helpers keep their names and signatures, so every policy that calls
-- them (apps_select_if_visible, and the cron / env-var / grant-row policies
-- from 20261117000000) picks the rule up unchanged.

create or replace function amux.actor_has_app_access(p_app_id uuid, p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'amux', 'public'
as $$
  select exists (
           select 1
             from amux.app_member_access ama
            where ama.app_id = p_app_id
              and ama.member_id = p_actor_id
         )
      or amux.agent_inherited_app_level(p_app_id, p_actor_id) is not null;
$$;

comment on function amux.actor_has_app_access(uuid, uuid) is
  'True when the actor holds a grant on the app, or is an active agent whose owner can reach it (amux.agent_inherited_app_level).';

create or replace function amux.caller_has_app_grant(p_app_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'amux', 'public'
as $$
  select exists (
    select 1
      from amux.apps a
     where a.id = p_app_id
       and amux.actor_has_app_access(a.id, amux.current_actor_id_for_team(a.team_id))
  );
$$;

comment on function amux.caller_has_app_grant(uuid) is
  'True when the caller''s actor in the app''s team (a member or an agent) holds a grant on the app, or is an active agent whose owner can reach it. RLS cannot express a level; the Cloud API narrows to read/write/admin and refuses an inherited caller access management and deletion.';
