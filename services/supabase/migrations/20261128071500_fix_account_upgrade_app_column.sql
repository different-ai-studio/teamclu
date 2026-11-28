-- team_id is also a RETURNS TABLE output variable. Qualify the App columns
-- so the UPDATE resolves them under the default PL/pgSQL conflict policy.
create or replace function amux.upgrade_account_to_org(
  p_team_id uuid,
  p_org_name text,
  p_contact text default null::text,
  p_default_org_id uuid default null::uuid
)
returns table(org_id uuid, team_id uuid, team_name text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth'
as $function$
declare
  v_user_id   uuid := auth.uid();
  v_member_id uuid;
  v_org_id    uuid := gen_random_uuid();
  v_team_oid  uuid;
  v_mobile    text;
  v_name      text := btrim(p_org_name);
begin
  if v_user_id is null then
    raise exception 'upgrade requires an authenticated user' using errcode = '42501';
  end if;
  if v_name is null or v_name = '' then
    raise exception 'org name is required' using errcode = '23514';
  end if;

  -- Caller must be the OWNER of the team being upgraded.
  select tm.member_id into v_member_id
  from amux.team_members tm
  join amux.actors a on a.id = tm.member_id
  where tm.team_id = p_team_id and a.user_id = v_user_id and tm.role = 'owner'
  limit 1;
  if v_member_id is null then
    raise exception 'only the team owner can upgrade' using errcode = '42501';
  end if;

  -- The team must currently live in the default org (idempotency / re-upgrade guard).
  select oid into v_team_oid from amux.teams where id = p_team_id;
  if p_default_org_id is not null and v_team_oid is distinct from p_default_org_id then
    raise exception 'team already belongs to its own org' using errcode = '23514';
  end if;

  select mobile into v_mobile from public.users where id = v_user_id limit 1;

  -- 1. New org.
  insert into public.orgs (id, name, contact, phone)
  values (v_org_id, v_name, nullif(btrim(p_contact), ''), v_mobile);

  -- 2. Point the user's profile at the new org.
  update public.users set org_id = v_org_id where id = v_user_id;

  -- 3. Stamp the JWT org claim source so daemon / team-share resolve the new org.
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org_id::text)
  where id = v_user_id;

  -- 4. Reparent + rename the team.
  update amux.teams set oid = v_org_id, name = v_name where id = p_team_id;

  -- 5. Carry this team's apps to the new org — but ONLY the ones with no
  --    schema anywhere.
  --
  --    `amux.apps.org_id` carries two facts at once, and they move differently.
  --    As the TENANT it must follow the team, or the app's login wall and
  --    account picker point at the org the team just left. As the DATABASE
  --    (`orgDatabaseName()` builds `tc_org_<hex>` from it) it must NOT follow:
  --    the app's schema stays in the database it was created in, and
  --    repointing it means the next deploy provisions a fresh EMPTY schema in
  --    `tc_org_<new>` and takes the app live with no data while the real data
  --    sits untouched in `tc_org_<old>`.
  --
  --    The guard trigger below makes this case unreachable — a team owning an
  --    app with a database cannot be upgraded at all. This predicate is the
  --    same rule said a second time, so that dropping the trigger degrades to
  --    "the tenant stops following" rather than to silent data loss.
  update amux.apps as app
  set org_id = v_org_id
  where app.team_id = p_team_id
    and not amux.app_type_needs_database(app.type);

  return query select v_org_id, p_team_id, v_name;
end;
$function$;
