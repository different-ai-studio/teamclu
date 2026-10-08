-- An agent account's public.users row carries its login email.
--
-- claim_team_invite_legacy wrote the agent's email (daemon.<id>@amuxd.run) to
-- auth.users only; the public.users row got (id, org_id, mobile, admin_type)
-- and email stayed at the column default ''. saas-mono reads its staff from
-- public.users, so every digital employee showed there with no email.
--
-- Now a NEW agent row is inserted with the account's email, and a reused
-- account (credential rotation) fills email in when its row still has ''. A
-- non-empty email is never overwritten.
--
-- Not changed: existing rows that are never rotated. Backfilling those is a
-- data change on the partner's table and is a manual step —
-- services/supabase/manual/agent_account_public_email_backfill.sql.
--
-- Body otherwise carried forward verbatim from
-- 20261008020000_member_invite_new_identity.sql.

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
       where id = v_user_id
      returning email into v_email;
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
      -- email mirrors the account's login email (daemon.<id>@amuxd.run) so
      -- saas-mono, which lists staff from public.users, does not see a blank.
      -- On reuse it is filled only while still blank, never overwritten.
      insert into public.users (id, org_id, mobile, admin_type, email)
      values (v_user_id, v_team_org, '', v_admin_type, coalesce(v_email, ''))
      on conflict (id) do update
        set org_id = excluded.org_id,
            email = case when public.users.email = '' then excluded.email else public.users.email end,
            updated_at = now();
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
  'Consumes an invite token. Member claims join as the caller''s identity in the team''s org (amux.ensure_member_identity: reused, or minted at admin_type 2) — nobody is moved between orgs; under amux.staff_only() the inviter must be staff of that org. Agent claims that name a target_actor_id rotate the credential in place; a NEW agent account is admin_type 2 when the inviter is staff of the team''s org, else 1. An agent''s public.users row carries its login email (filled in on rotation while still blank, never overwritten).';
