-- Reusable team join links. Separate from team_invites so a multi-use row
-- cannot satisfy claim_team_invite's consumed_at check.

create table amux.team_join_links (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references amux.teams (id) on delete cascade,
  token text not null,
  created_by_actor_id uuid not null references amux.actors (id),
  expires_at timestamptz,
  revoked_at timestamptz,
  max_uses int,
  use_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_join_links_max_uses_check check (max_uses is null or max_uses >= 1),
  constraint team_join_links_use_count_check check (use_count >= 0)
);

create unique index team_join_links_token_key on amux.team_join_links (token);
create unique index team_join_links_one_active_per_team
  on amux.team_join_links (team_id) where revoked_at is null;

alter table amux.team_join_links enable row level security;

create or replace function amux.team_join_link_status(
  p_revoked timestamptz,
  p_expires timestamptz,
  p_max int,
  p_used int
) returns text
language sql
stable
as $$
  select case
    when p_revoked is not null then 'revoked'
    when p_expires is not null and p_expires <= now() then 'expired'
    when p_max is not null and p_used >= p_max then 'exhausted'
    else 'active'
  end
$$;

create or replace function amux.put_team_join_link(
  p_team_id uuid,
  p_ttl text,
  p_max_uses int,
  p_rotate boolean,
  p_default_org_id uuid
) returns table (
  id uuid,
  token text,
  expires_at timestamptz,
  max_uses int,
  use_count int,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to amux, public, auth, extensions
as $$
#variable_conflict use_column
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_role text := amux.current_team_role(p_team_id);
  v_team amux.teams%rowtype;
  v_link amux.team_join_links%rowtype;
  v_expires timestamptz;
  v_token text;
begin
  if v_caller is null or v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'team owner or admin access required' using errcode = '42501';
  end if;
  if p_max_uses is not null and p_max_uses < 1 then
    raise exception 'max_uses must be null or >= 1' using errcode = '22023';
  end if;
  if p_ttl = '7d' then
    v_expires := now() + interval '7 days';
  elsif p_ttl = '30d' then
    v_expires := now() + interval '30 days';
  elsif p_ttl = 'never' then
    v_expires := null;
  else
    raise exception 'ttl must be 7d, 30d, or never' using errcode = '22023';
  end if;

  select * into v_team from amux.teams where amux.teams.id = p_team_id;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if p_default_org_id is not null and v_team.oid = p_default_org_id then
    raise exception '升级账号后才能邀请成员加入团队' using errcode = '42501';
  end if;

  select * into v_link
    from amux.team_join_links
   where team_id = p_team_id and revoked_at is null
   for update;

  if found and coalesce(p_rotate, false) then
    update amux.team_join_links
       set revoked_at = now(), updated_at = now()
     where id = v_link.id;
  end if;

  -- A null record has no `.id` in PL/pgSQL; branch on FOUND / rotate, not on v_link.id.
  if not found or coalesce(p_rotate, false) then
    v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_0');
    insert into amux.team_join_links (
      team_id, token, created_by_actor_id, expires_at, max_uses
    ) values (
      p_team_id, v_token, v_caller, v_expires, p_max_uses
    ) returning * into v_link;
  else
    update amux.team_join_links
       set expires_at = v_expires,
           max_uses = p_max_uses,
           updated_at = now()
     where id = v_link.id
    returning * into v_link;
  end if;

  return query select
    v_link.id, v_link.token, v_link.expires_at, v_link.max_uses, v_link.use_count,
    amux.team_join_link_status(v_link.revoked_at, v_link.expires_at, v_link.max_uses, v_link.use_count),
    v_link.created_at;
end;
$$;

create or replace function amux.revoke_team_join_link(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path to amux, public, auth
as $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_role text := amux.current_team_role(p_team_id);
  v_id uuid;
begin
  if v_caller is null or v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'team owner or admin access required' using errcode = '42501';
  end if;
  select id into v_id
    from amux.team_join_links
   where team_id = p_team_id and revoked_at is null
   for update;
  if not found then
    raise exception 'link_not_found' using errcode = 'P0002';
  end if;
  update amux.team_join_links
     set revoked_at = now(), updated_at = now()
   where id = v_id;
end;
$$;

create or replace function amux.preview_team_join_link(p_token text)
returns table (
  team_name text,
  inviter_display_name text,
  expires_at timestamptz,
  status text
)
language sql
stable
security definer
set search_path to amux, public
as $$
  select t.name, a.display_name, l.expires_at,
         amux.team_join_link_status(l.revoked_at, l.expires_at, l.max_uses, l.use_count)
    from amux.team_join_links l
    join amux.teams t on t.id = l.team_id
    join amux.actors a on a.id = l.created_by_actor_id
   where l.token = p_token
$$;

create or replace function amux.join_team_by_link(p_token text)
returns table (
  team_id uuid,
  actor_id uuid,
  display_name text,
  already_member boolean
)
language plpgsql
security definer
set search_path to amux, public, auth, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_anon boolean;
  v_link amux.team_join_links%rowtype;
  v_status text;
  v_member uuid;
  v_name text;
  v_nickname text;
begin
  if v_user_id is null then
    raise exception 'join_team_by_link requires an authenticated user' using errcode = '42501';
  end if;
  select coalesce(is_anonymous, false) into v_anon from auth.users where id = v_user_id;
  if coalesce(v_anon, false) then
    raise exception 'anonymous users cannot join a team' using errcode = '42501';
  end if;

  select * into v_link from amux.team_join_links where token = p_token for update;
  if not found then
    raise exception 'link_not_found' using errcode = 'P0002';
  end if;
  v_status := amux.team_join_link_status(v_link.revoked_at, v_link.expires_at, v_link.max_uses, v_link.use_count);
  if v_status = 'revoked' then
    raise exception 'link_revoked' using errcode = 'P0001';
  elsif v_status = 'expired' then
    raise exception 'link_expired' using errcode = 'P0001';
  elsif v_status = 'exhausted' then
    raise exception 'link_exhausted' using errcode = 'P0001';
  end if;

  select a.id, a.display_name into v_member, v_name
    from amux.actors a
   where a.user_id = v_user_id
     and a.team_id = v_link.team_id
     and a.actor_type = 'member'
   limit 1;
  if v_member is not null then
    return query select v_link.team_id, v_member, v_name, true;
    return;
  end if;

  select nickname into v_nickname from public.users where id = v_user_id limit 1;
  v_member := gen_random_uuid();
  v_name := coalesce(nullif(btrim(v_nickname), ''), amux.resolve_caller_display_name(v_member));
  insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member, v_link.team_id, 'member', v_user_id, v_name, now());
  insert into amux.members (id, status) values (v_member, 'active');
  insert into amux.team_members (team_id, member_id, role)
  values (v_link.team_id, v_member, 'member');

  update amux.team_join_links
     set use_count = use_count + 1, updated_at = now()
   where id = v_link.id
     and (max_uses is null or use_count < max_uses);
  if not found then
    raise exception 'link_exhausted' using errcode = 'P0001';
  end if;

  return query select v_link.team_id, v_member, v_name, false;
end;
$$;

revoke all on function amux.team_join_link_status(timestamptz, timestamptz, int, int) from public;
revoke all on function amux.put_team_join_link(uuid, text, int, boolean, uuid) from public;
revoke all on function amux.revoke_team_join_link(uuid) from public;
revoke all on function amux.preview_team_join_link(text) from public;
create or replace function amux.get_team_join_link(p_team_id uuid)
returns table (
  id uuid, token text, expires_at timestamptz, max_uses int,
  use_count int, status text, created_at timestamptz
)
language plpgsql
security definer
set search_path to amux, public, auth
as $$
#variable_conflict use_column
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_role text := amux.current_team_role(p_team_id);
  v_link amux.team_join_links%rowtype;
begin
  if v_caller is null or v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'team owner or admin access required' using errcode = '42501';
  end if;
  select * into v_link
    from amux.team_join_links
   where team_id = p_team_id and revoked_at is null;
  if not found then
    raise exception 'link_not_found' using errcode = 'P0002';
  end if;
  return query select v_link.id, v_link.token, v_link.expires_at, v_link.max_uses,
    v_link.use_count,
    amux.team_join_link_status(v_link.revoked_at, v_link.expires_at, v_link.max_uses, v_link.use_count),
    v_link.created_at;
end;
$$;

revoke all on function amux.join_team_by_link(text) from public;
revoke all on function amux.get_team_join_link(uuid) from public;

grant execute on function amux.put_team_join_link(uuid, text, int, boolean, uuid) to authenticated, service_role;
grant execute on function amux.revoke_team_join_link(uuid) to authenticated, service_role;
grant execute on function amux.preview_team_join_link(text) to anon, authenticated, service_role;
grant execute on function amux.join_team_by_link(text) to authenticated, service_role;
grant execute on function amux.get_team_join_link(uuid) to authenticated, service_role;
