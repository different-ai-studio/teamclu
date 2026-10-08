-- Member invites: only staff may invite, and joining creates an identity.
--
-- docs/plans/2026-10-08-staff-only-identity-model.md (T6).
--
-- 1. Staff-only invites. When amux.staff_only() is on, a member invite admits
--    only if its inviter is staff (admin_type >= 2) of the team's org —
--    checked in create_team_invite for a legible refusal and again at claim,
--    which is the boundary (an invite minted before the switch, or by someone
--    who has since lost staff status, does not admit).
--
-- 2. No more moving. claim_team_invite used to rewrite the caller's
--    public.users.org_id to the team's org ("strict single-org") and delete the
--    teams of the org they left; admin_type rode along, so a tenant creator (3)
--    who accepted an invite would become super admin of the inviting company
--    in saas-mono. Now the caller joins as their identity IN the team's org:
--      * a live staff identity of theirs already there → reused;
--      * no public.users row at all (a fresh account) → that account becomes
--        the identity, admin_type 2;
--      * otherwise → a new auth account (`<id>@teamclu.mobile` for a phone
--        user, `<id>@teamclu.email` for an email user) and row, admin_type 2.
--    Email users' identities are tied together in public.email_users_links;
--    phone users' through the shared mobile. All writes are INSERTs — partner
--    deployments let only service_role UPDATE admin_type.
--
-- The agent branch is untouched. Bodies carried forward from
-- 20260811110000_remove_member_reinvite.sql (create_team_invite) and
-- 20261008010000_agent_account_staff_grade.sql (claim_team_invite_legacy).

create or replace function amux.is_org_staff_actor(p_actor_id uuid, p_org_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  -- Is the person behind this actor staff of p_org_id — on the actor's own
  -- identity or any other identity of theirs (same phone, linked email)?
  select exists (
    select 1
      from amux.actors a
      cross join lateral amux.person_identities(a.user_id) as p(id)
      join public.users u on u.id = p.id
     where a.id = p_actor_id
       and u.org_id = p_org_id
       and u.admin_type >= 2
       and u.deleted_at is null
  );
$function$;

revoke all on function amux.is_org_staff_actor(uuid, uuid) from public;
grant execute on function amux.is_org_staff_actor(uuid, uuid) to authenticated, service_role;

create or replace function amux.ensure_member_identity(p_caller uuid, p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_id           uuid;
  v_has_row      boolean;
  v_mobile       text;
  v_nickname     text;
  v_auth_email   text;
  v_person_email text;
begin
  -- Already staff there (a partner employee record, or an identity an earlier
  -- invite minted): join as that.
  select u.id into v_id
    from amux.person_identities(p_caller) as p(id)
    join public.users u on u.id = p.id
   where u.org_id = p_org_id and u.deleted_at is null and u.admin_type >= 2
     and exists (select 1 from auth.users au where au.id = u.id)
   order by (u.id = p_caller) desc, u.admin_type desc, u.created_at asc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  select nullif(btrim(u.mobile), ''), u.nickname into v_mobile, v_nickname
    from public.users u where u.id = p_caller;
  v_has_row := found;
  select lower(btrim(au.email)) into v_auth_email from auth.users au where au.id = p_caller;
  -- A phone sign-up before it made a tenant: `<phone>@teamclu.mobile`, no row.
  if v_mobile is null and split_part(v_auth_email, '@', 2) = 'teamclu.mobile'
     and split_part(v_auth_email, '@', 1) ~ '^1[3-9][0-9]{9}$' then
    v_mobile := split_part(v_auth_email, '@', 1);
  end if;
  -- The email that names this person, for an email user.
  select l.email into v_person_email from public.email_users_links l where l.user_id = p_caller;
  if v_person_email is null and v_mobile is null and coalesce(v_auth_email, '') <> ''
     and split_part(v_auth_email, '@', 2) not in ('teamclu.email', 'teamclu.mobile') then
    v_person_email := v_auth_email;
  end if;

  if not v_has_row then
    -- First identity: the account they signed in with.
    v_id := p_caller;
    insert into public.users (id, auth_user_id, org_id, mobile, admin_type)
    values (v_id, v_id, p_org_id, coalesce(v_mobile, ''), 2);
  else
    v_id := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change, raw_app_meta_data, aud, role, created_at, updated_at, instance_id)
    values (v_id,
      v_id::text || case when v_mobile is not null then '@teamclu.mobile' else '@teamclu.email' end,
      now(), '', '', '', '', '', jsonb_build_object('org_id', p_org_id),
      'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
    insert into public.users (id, auth_user_id, org_id, mobile, admin_type, nickname)
    values (v_id, v_id, p_org_id, coalesce(v_mobile, ''), 2, v_nickname);
  end if;

  if v_person_email is not null then
    -- Both ends: the caller's own identity (if it has a row) and the new one.
    insert into public.email_users_links (email, user_id, org_id)
    select v_person_email, u.id, u.org_id from public.users u where u.id = p_caller
    on conflict (user_id) do nothing;
    insert into public.email_users_links (email, user_id, org_id)
    values (v_person_email, v_id, p_org_id)
    on conflict (user_id) do nothing;
  end if;

  return v_id;
end;
$function$;

comment on function amux.ensure_member_identity(uuid, uuid) is
  'The caller''s identity in p_org_id, minted at admin_type 2 when they have none: reuses a live staff identity of theirs there, else turns a row-less account into the identity, else creates a new auth account (<id>@teamclu.mobile / <id>@teamclu.email) and row. Links email users'' identities in public.email_users_links. INSERT-only.';

revoke all on function amux.ensure_member_identity(uuid, uuid) from public;
grant execute on function amux.ensure_member_identity(uuid, uuid) to service_role;

CREATE OR REPLACE FUNCTION amux.create_team_invite(p_team_id uuid, p_kind text, p_display_name text, p_team_role text DEFAULT NULL::text, p_agent_kind text DEFAULT NULL::text, p_ttl_seconds integer DEFAULT 604800, p_target_actor_id uuid DEFAULT NULL::uuid, p_invite_email text DEFAULT NULL::text, p_invite_phone text DEFAULT NULL::text)
 RETURNS TABLE(token text, expires_at timestamp with time zone, deeplink text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth', 'app'
AS $function$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_token  text := translate(
                     encode(extensions.gen_random_bytes(24), 'base64'),
                     '+/=', '-_0'
                   );
  v_expires timestamptz := now() + make_interval(secs => greatest(60, p_ttl_seconds));
  v_kind    text;
  v_role    text;
  v_target  amux.actors%rowtype;
  v_target_anon boolean;
  v_email   text;
  v_phone   text;
begin
  if v_caller is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  v_kind := lower(coalesce(p_kind, ''));
  if v_kind not in ('member','agent') then
    raise exception 'p_kind must be member or agent' using errcode = '22023';
  end if;

  v_email := nullif(lower(btrim(coalesce(p_invite_email, ''))), '');
  v_phone := nullif(btrim(coalesce(p_invite_phone, '')), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invite_email is not a valid email address' using errcode = '22023';
  end if;
  if v_phone is not null and amux.normalize_invite_phone(v_phone) is null then
    raise exception 'invite_phone contains no digits' using errcode = '22023';
  end if;

  if v_kind = 'member' then
    if p_team_role is null or btrim(p_team_role) = '' then
      raise exception 'member invites require p_team_role' using errcode = '22023';
    end if;
    v_role := lower(p_team_role);
    if v_role not in ('owner','admin','member') then
      raise exception 'team_role must be owner/admin/member' using errcode = '22023';
    end if;

    -- Staff-only deployments: only staff of the team's org may bring people
    -- in — the invitee becomes staff-grade (admin_type 2). Checked again at
    -- claim, which is the boundary; this is the legible refusal.
    if amux.staff_only()
       and not amux.is_org_staff_actor(v_caller, (select t.oid from amux.teams t where t.id = p_team_id)) then
      raise exception 'only staff of this organization can invite members'
        using errcode = '42501';
    end if;

    -- Member re-invite is gone; p_target_actor_id survives for agents only.
    if p_target_actor_id is not null then
      raise exception 'member invites cannot target an existing actor'
        using errcode = '22023';
    end if;

    -- Supersede an existing live invite to the same contact instead of letting
    -- the partial unique index reject the call: an inviter re-sending an invite
    -- means "this one is now current", and the old token stops working.
    if v_email is not null then
      update amux.team_invites
         set status = 'expired', updated_at = now()
       where team_id = p_team_id
         and status = 'pending'
         and lower(btrim(invite_email)) = v_email;
    end if;
    if v_phone is not null then
      update amux.team_invites
         set status = 'expired', updated_at = now()
       where team_id = p_team_id
         and status = 'pending'
         and amux.normalize_invite_phone(invite_phone) = amux.normalize_invite_phone(v_phone);
    end if;
  else
    if v_email is not null or v_phone is not null then
      raise exception 'agent invites cannot carry invite_email/invite_phone'
        using errcode = '22023';
    end if;
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent invites require p_agent_kind' using errcode = '22023';
    end if;
    if p_target_actor_id is not null then
      select * into v_target from amux.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'agent' then
        raise exception 'target actor must be an agent' using errcode = '22023';
      end if;
      if not exists (
        select 1 from amux.agents
        where id = p_target_actor_id
          and owner_member_id = v_caller
      ) then
        raise exception 'only the agent owner can re-invite this agent'
          using errcode = '42501';
      end if;
    end if;
  end if;

  insert into amux.team_invites (
    team_id, kind, display_name, team_role, agent_kind,
    invited_by_actor_id, token, expires_at, target_actor_id,
    invite_email, invite_phone, status
  )
  values (
    p_team_id, v_kind, btrim(p_display_name), v_role, p_agent_kind,
    v_caller, v_token, v_expires, p_target_actor_id,
    v_email, v_phone, 'pending'
  );

  return query
  select v_token,
         v_expires,
         format('amux://invite?token=%s', v_token);
end;
$function$;

CREATE OR REPLACE FUNCTION amux.claim_team_invite_legacy(p_token text)
 RETURNS TABLE(actor_id uuid, team_id uuid, actor_type text, display_name text, refresh_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'amux', 'public', 'auth', 'extensions'
AS $function$
declare
  v_invite      amux.team_invites%rowtype;
  v_user_id     uuid;
  v_actor       uuid;
  v_email       text;
  v_session     uuid;
  v_rt          text := null;
  v_old_user    uuid;
  v_target_anon boolean;
  v_team_org    uuid;   -- invite team's org (S3-FC.3)
  v_caller      uuid;   -- member path: the signed-in account claiming
  v_admin_type  smallint := 1;  -- a NEW agent account's admin_type (see header)
begin
  select * into v_invite from amux.team_invites where token = p_token for update;
  if not found then raise exception 'invite not found' using errcode = '23503'; end if;
  if v_invite.consumed_at is not null then raise exception 'invite already consumed' using errcode = '23514'; end if;
  if v_invite.status = 'declined' then raise exception 'invite was declined' using errcode = '23514'; end if;
  if v_invite.status = 'expired' then raise exception 'invite superseded' using errcode = '23514'; end if;
  if v_invite.expires_at < now() then raise exception 'invite expired' using errcode = '23514'; end if;

  -- Resolved once for both branches: members get public.users.org_id switched,
  -- agents get the claim baked into raw_app_meta_data.
  select oid into v_team_org from amux.teams where id = v_invite.team_id;

  if v_invite.kind = 'member' then
    if v_invite.target_actor_id is not null then
      -- Unconsumed tokens minted before the removal still carry a target. They
      -- are refused rather than degraded into a self-join: the token was issued
      -- to hand back somebody else's credentials, not to add the caller.
      raise exception 'member re-invite is no longer supported' using errcode = '22023';
    end if;
    v_caller := auth.uid();
    if v_caller is null then raise exception 'member claim requires authentication' using errcode = '42501'; end if;

    -- The boundary for "only staff may invite": an invite minted by anyone else
    -- (or before staff-only was switched on) does not admit.
    if amux.staff_only() and not amux.is_org_staff_actor(v_invite.invited_by_actor_id, v_team_org) then
      raise exception 'invite was not issued by staff of this organization' using errcode = '42501';
    end if;

    if exists (
      select 1 from amux.actors act
       where act.team_id = v_invite.team_id
         and act.user_id in (select p.id from amux.person_identities(v_caller) as p(id))
         and (not amux.staff_only() or amux.is_teamclu_identity(act.user_id))
    ) then
      raise exception 'already a member of this team' using errcode = '23505';
    end if;

    -- One identity per org: join as this person's identity in the team's org,
    -- minting one (admin_type 2) if they have none. Nobody moves any more — the
    -- old body rewrote the caller's org_id to the team's and garbage-collected
    -- the teams of the org they left.
    v_user_id := case when v_team_org is null then v_caller
                      else amux.ensure_member_identity(v_caller, v_team_org) end;

    insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values (v_invite.team_id, 'member', v_user_id, v_invite.invited_by_actor_id, v_invite.display_name, now())
    returning id into v_actor;
    insert into amux.members (id, status) values (v_actor, 'active');
    insert into amux.team_members (team_id, member_id, role) values (v_invite.team_id, v_actor, v_invite.team_role);

    -- A session for the identity that joined, when it is not the caller's own;
    -- clients activate the team right after, which mints one too.
    if v_user_id <> v_caller then
      v_rt := auth._mint_session(v_user_id);
    end if;
  else
    -- Which account do these credentials belong to? A rebind reuses the one the
    -- agent actor already has; everything else mints one. Resolved BEFORE any
    -- write, which is the whole change — the old body created an account first
    -- and discovered the answer afterwards.
    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from amux.actors where id = v_invite.target_actor_id;
      if v_old_user is not null and exists (select 1 from auth.users u where u.id = v_old_user) then
        v_user_id := v_old_user;
      end if;
    end if;

    v_session := gen_random_uuid();
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

    if v_user_id is null then
      v_user_id := gen_random_uuid();
      v_email   := format('daemon.%s@amuxd.run', v_user_id);
      -- Stamp the team's org into app_metadata so daemon access tokens pass
      -- teams_org_guard (current_org_id() reads the JWT claim first; daemon
      -- users have no public.users fallback row).
      insert into auth.users (id, email, email_confirmed_at, encrypted_password, confirmation_token, recovery_token,
        email_change_token_new, email_change, raw_app_meta_data, aud, role, created_at, updated_at, instance_id)
      values (v_user_id, v_email, now(), '', '', '', '', '',
        case when v_team_org is not null then jsonb_build_object('org_id', v_team_org) else '{}'::jsonb end,
        'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
    else
      -- Reuse. Refresh the org claim (a rebind can land the agent under a team
      -- in another org), then revoke what the previous device still holds —
      -- deleting the account used to do that as a side effect.
      update auth.users
         set raw_app_meta_data = case
               when v_team_org is null then coalesce(raw_app_meta_data, '{}'::jsonb)
               else coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('org_id', v_team_org)
             end,
             updated_at = now()
       where id = v_user_id;
      delete from auth.refresh_tokens where user_id = v_user_id::text;
      delete from auth.sessions where user_id = v_user_id;
    end if;

    insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (v_session, v_user_id, 'aal1', now(), now());
    insert into auth.refresh_tokens (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
      values (v_rt, v_user_id::text, v_session, false, '00000000-0000-0000-0000-000000000000', now(), now());

    -- Also give the daemon account a public.users fallback row with the team's
    -- org, so org resolvers that query public.users by id directly (without the
    -- JWT app_metadata.org_id claim) can resolve org_id instead of erroring.
    -- On reuse this is the row whose other columns — admin_type above all — are
    -- what the rotation used to throw away.
    if v_team_org is not null then
      -- Staff-grade only when whoever invited the agent is staff of the team's
      -- org themselves (own row or a same-phone row; admin_type >= 2, live),
      -- the rule amux.caller_employee_orgs() applies to the caller.
      select case when exists (
               select 1
                 from amux.actors inv
                 join public.users iu on iu.id = inv.user_id
                 join public.users eu
                   on (eu.id = iu.id
                       or (nullif(btrim(iu.mobile), '') is not null and eu.mobile = iu.mobile))
                where inv.id = v_invite.invited_by_actor_id
                  and eu.org_id = v_team_org
                  and eu.admin_type >= 2
                  and eu.deleted_at is null
             ) then 2 else 1 end
        into v_admin_type;
      -- admin_type is written on INSERT only. A reused account keeps the one it
      -- has: partner deployments guard UPDATEs of the column
      -- (prevent_admin_type_change, service_role only), and an operator's grant
      -- must survive rotation — the point of 20260819000000.
      insert into public.users (id, org_id, mobile, admin_type) values (v_user_id, v_team_org, '', v_admin_type)
      on conflict (id) do update set org_id = excluded.org_id, updated_at = now();
    end if;

    if v_invite.target_actor_id is not null then
      update amux.actors set user_id = v_user_id, invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null, updated_at = now() where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;
      -- A device-scoped agent keeps whatever visibility it has. Every credential
      -- rotation (team switch, expired refresh token) lands here, and forcing
      -- 'team' turned each one into a silent publish of the machine. Agents with
      -- no device_id keep the historical behaviour.
      update amux.agents
         set owner_member_id = v_invite.invited_by_actor_id,
             visibility = case when device_id is not null then visibility else 'team' end,
             updated_at = now()
       where id = v_actor;
      -- Only an account we could NOT reuse is collected: the actor pointed at a
      -- user id that is no longer in auth.users, so the row this claim replaced
      -- it with leaves nothing behind. When v_old_user IS the account in use,
      -- this is a no-op — that is the fix.
      if v_old_user is not null and v_old_user <> v_user_id then
        delete from auth.users where id = v_old_user;
      end if;
    else
      insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values (v_invite.team_id, 'agent', v_user_id, v_invite.invited_by_actor_id, v_invite.display_name, null)
      returning id into v_actor;
      insert into amux.agents (id, owner_member_id, visibility, status) values (v_actor, v_invite.invited_by_actor_id, 'team', 'active');
    end if;

    insert into amux.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
    values (v_actor, v_invite.invited_by_actor_id, 'admin', v_invite.invited_by_actor_id)
    on conflict (agent_id, member_id) do update
      set permission_level = 'admin', granted_by_member_id = excluded.granted_by_member_id, updated_at = now();
  end if;

  update amux.team_invites set consumed_at = now(), consumed_by_actor_id = v_actor,
         status = 'accepted', updated_at = now() where id = v_invite.id;

  return query select v_actor, v_invite.team_id, v_invite.kind::text, v_invite.display_name, v_rt;
end;
$function$;

comment on function amux.claim_team_invite_legacy(text) is
  'Consumes an invite token. Member claims join as the caller''s identity in the team''s org (amux.ensure_member_identity: reused, or minted at admin_type 2) — nobody is moved between orgs; under amux.staff_only() the inviter must be staff of that org. Agent claims that name a target_actor_id rotate the credential in place; a NEW agent account is admin_type 2 when the inviter is staff of the team''s org, else 1.';
