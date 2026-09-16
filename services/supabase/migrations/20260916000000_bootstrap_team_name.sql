-- Let the first-run screen name the org and its default team.
--
-- Before this, login onboarding derived both names server-side from the
-- account (nickname → OAuth full name → email local part → Adjective Animal),
-- so a company signing up got a workspace called after whoever clicked first.
-- The desktop first-run screen now asks for a name — a company name, or the
-- name of a personal small team — and passes it down.
--
-- It also retires the shared-tenant bootstrap branch: a caller who is not an
-- employee of that org now gets their own org instead of a private team inside
-- someone else's company.
--
-- The name is applied to BOTH public.orgs.name and amux.teams.name, keeping
-- the "team name equals org name" invariant from
-- docs/plans/2026-08-17-login-org-team-redesign.md. Absent / blank falls back
-- to exactly the old derivation, so an older client is unaffected.
--
-- Every new parameter is added LAST and DEFAULTs to null: PostgREST binds RPC
-- arguments by name, so a client that does not send p_team_name keeps binding
-- to the same function throughout a rolling deploy. The previous arity is
-- DROPped in each case — a defaulted parameter creates an overload rather than
-- replacing the function, and leaving both would make every existing call
-- ambiguous (42725).

-- ── ensure_personal_org: accept a name ──────────────────────────────────────
-- Signature change, so the old zero-arg function must go or a no-argument call
-- becomes ambiguous. The replacement is still callable with no arguments.

DROP FUNCTION IF EXISTS amux.ensure_personal_org();

CREATE OR REPLACE FUNCTION amux.ensure_personal_org(p_name text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
declare
  v_user uuid := auth.uid();
  v_org  uuid;
  v_name text;
begin
  if v_user is null then
    raise exception 'ensure_personal_org requires an authenticated user' using errcode = '42501';
  end if;

  select org_id into v_org from public.users where id = v_user limit 1;
  if v_org is not null then
    return v_org;
  end if;

  -- Caller-supplied name wins; the old derivation is the fallback. Never empty:
  -- bootstrap_current_org_team raises 23514 on a blank org name.
  v_name := coalesce(
    nullif(btrim(p_name), ''),
    nullif(btrim(amux.resolve_caller_display_name()), ''),
    'Personal'
  );

  insert into public.orgs (name) values (v_name) returning id into v_org;
  begin
    insert into public.users (id, org_id, mobile) values (v_user, v_org, '');
  exception when unique_violation then
    -- lost a concurrent race: drop our org, reuse the winner's
    delete from public.orgs where id = v_org;
    select org_id into v_org from public.users where id = v_user limit 1;
  end;

  return v_org;
end;
$function$;

REVOKE ALL ON FUNCTION amux.ensure_personal_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.ensure_personal_org(text) TO authenticated, service_role;

-- ── ensure_org_public_team: name the team it creates ────────────────────────
-- Body otherwise verbatim from 20260817030000_org_default_public_team.sql.

DROP FUNCTION IF EXISTS amux.ensure_org_public_team(uuid, text);

CREATE OR REPLACE FUNCTION amux.ensure_org_public_team(
  p_org_id uuid,
  p_display_name text DEFAULT NULL,
  p_team_name text DEFAULT NULL
)
RETURNS TABLE(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
declare
  v_user_id  uuid := auth.uid();
  v_org_name text;
  v_team     amux.teams%rowtype;
  v_member_id uuid;
  v_nickname text;
  v_display_name text;
  v_workspace_id uuid;
  v_workspace_name text;
begin
  if v_user_id is null then
    raise exception 'ensure_org_public_team requires an authenticated user' using errcode = '42501';
  end if;
  if p_org_id is null then
    raise exception 'ensure_org_public_team requires an organization' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));

  select t.* into v_team
    from amux.teams t
    join amux.actors a on a.team_id = t.id
   where t.oid = p_org_id and a.user_id = v_user_id
   order by t.created_at asc, t.id asc
   limit 1;

  if not found then
    select t.* into v_team
      from amux.teams t
     where t.oid = p_org_id and t.visibility = 'public'
     order by t.created_at asc, t.id asc
     limit 1;
  end if;

  if not found then
    select name into v_org_name from public.orgs where id = p_org_id;
    -- The caller's name wins over the org's own, so a first-run screen names
    -- the team even when the org was minted earlier under a derived name.
    v_org_name := coalesce(nullif(btrim(p_team_name), ''), nullif(btrim(v_org_name), ''));
    if v_org_name is null then
      raise exception 'organization has no name' using errcode = '23514';
    end if;
    return query
      select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
        from amux.create_team_row(
          p_name => v_org_name,
          p_display_name => p_display_name,
          p_oid => p_org_id,
          p_visibility => 'public'
        ) c;
    return;
  end if;

  select a.id into v_member_id
    from amux.actors a
   where a.user_id = v_user_id and a.team_id = v_team.id
   limit 1;

  if v_member_id is null then
    select nickname into v_nickname from public.users where id = v_user_id limit 1;
    v_member_id := gen_random_uuid();
    v_display_name := coalesce(
      nullif(btrim(v_nickname), ''),
      nullif(btrim(p_display_name), ''),
      amux.resolve_caller_display_name(v_member_id)
    );
    insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
      values (v_member_id, v_team.id, 'member', v_user_id, v_display_name, now());
    insert into amux.members (id, status) values (v_member_id, 'active');
    insert into amux.team_members (team_id, member_id, role) values (v_team.id, v_member_id, 'member');
  end if;

  select w.id, w.name into v_workspace_id, v_workspace_name
    from amux.workspaces w
   where w.team_id = v_team.id
   order by w.created_at asc, w.id asc
   limit 1;

  return query select v_team.id, v_team.name, v_team.slug, v_member_id,
    case when exists (
      select 1 from amux.team_members tm
       where tm.team_id = v_team.id and tm.member_id = v_member_id and tm.role = 'owner'
    ) then 'owner' else 'member' end,
    v_workspace_id, v_workspace_name;
end;
$function$;

GRANT EXECUTE ON FUNCTION amux.ensure_org_public_team(uuid, text, text) TO authenticated, service_role;

-- ── move_caller_to_own_org ──────────────────────────────────────────────────
-- Mint an org for a caller who already has one. ensure_personal_org cannot do
-- this: it early-returns as soon as public.users.org_id is set, which is
-- exactly the state a shared-tenant identity is in.

CREATE OR REPLACE FUNCTION amux.move_caller_to_own_org(p_name text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
declare
  v_user uuid := auth.uid();
  v_org  uuid;
  v_name text;
begin
  if v_user is null then
    raise exception 'move_caller_to_own_org requires an authenticated user' using errcode = '42501';
  end if;

  v_name := coalesce(
    nullif(btrim(p_name), ''),
    nullif(btrim(amux.resolve_caller_display_name()), ''),
    'Personal'
  );

  insert into public.orgs (name) values (v_name) returning id into v_org;

  update public.users set org_id = v_org, updated_at = now() where id = v_user;
  if not found then
    insert into public.users (id, org_id, mobile) values (v_user, v_org, '');
  end if;

  return v_org;
end;
$function$;

REVOKE ALL ON FUNCTION amux.move_caller_to_own_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amux.move_caller_to_own_org(text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS amux.bootstrap_login_team(boolean, uuid, text);

CREATE OR REPLACE FUNCTION amux.bootstrap_login_team(
  p_allow_new_org boolean DEFAULT true,
  p_shared_org uuid DEFAULT NULL,
  p_display_name text DEFAULT NULL,
  p_team_name text DEFAULT NULL
)
RETURNS TABLE(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id  uuid;
begin
  if v_user_id is null then
    raise exception 'bootstrap_login_team requires an authenticated user' using errcode = '42501';
  end if;

  v_org_id := amux.current_org_id();

  if v_org_id is null then
    if not coalesce(p_allow_new_org, true) then
      raise exception 'self-registration is disabled on this deployment' using errcode = '42501';
    end if;
    v_org_id := amux.ensure_personal_org(p_team_name);
  end if;

  if v_org_id is null then
    raise exception 'current organization is required for team bootstrap' using errcode = '23514';
  end if;

  -- 共享租户（DEFAULT_ORG_ID）是身份命名空间，不是这个人的公司：每一个 org-less
  -- 或手机号注册都被盖上它。真正属于它的只有它的员工 —— belayo 上
  -- DEFAULT_ORG_ID 指的是 Betly 倍拓 这家真公司，self-host 上是 56 个互不相关
  -- 团队的杂物间。
  --
  -- 所以这里只分一次：是这个 org 的员工就照常走（加入它的 public 默认团队），
  -- 不是就给自己建一个 org，和任何其他没有 org 的人走同一条路。以前这条分支是
  -- 「在共享 org 里建个私有团队」，那正是让陌生人堆进同一个租户的原因。
  --
  -- 员工判定共用 amux.caller_employee_orgs()（admin_type >= 2，含同手机号身份），
  -- 与 list_teams_for_picker / join_public_team 同一个定义，不能各写一套。
  if p_shared_org is not null and v_org_id = p_shared_org
     and not exists (
       select 1 from amux.caller_employee_orgs() eo where eo = p_shared_org
     ) then
    -- Minting an org IS self-registration, same gate as the no-org branch.
    if not coalesce(p_allow_new_org, true) then
      raise exception 'self-registration is disabled on this deployment' using errcode = '42501';
    end if;
    v_org_id := amux.move_caller_to_own_org(p_team_name);
  end if;

  return query
    select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
      from amux.ensure_org_public_team(v_org_id, p_display_name, p_team_name) c;
end;
$function$;

GRANT EXECUTE ON FUNCTION amux.bootstrap_login_team(boolean, uuid, text, text) TO authenticated, service_role;
