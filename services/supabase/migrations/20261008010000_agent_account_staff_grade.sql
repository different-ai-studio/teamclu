-- A new agent account is staff-grade (admin_type 2) when its inviter is staff.
--
-- saas-mono gates its whole admin API on public.users.admin_type in (2, 3, 4)
-- (apps/api/src/routes/api/admin/index.ts → adminMiddleware). The claim seeds
-- an agent's row as `(id, org_id, mobile)`, so every digital employee lands at
-- the column default 1 (普通用户) and every admin endpoint answers 401. Today an
-- org admin lifts each account by hand in the partner back office — 4 of 116
-- on belayo — and every new device pairing is a new account to lift again.
--
-- The claim now writes admin_type 2 (管理员, not 3 超管) for a NEW agent
-- account — but only when the person who invited it is staff of the team's org
-- (admin_type >= 2 on their own row or a same-phone row, not soft-deleted). Any
-- team member can invite an agent; without that condition a member with no
-- back-office access could mint an account that has it. The shared tenant
-- (DEFAULT_ORG) gets no exception either way: phone sign-ups there are
-- admin_type 1 and their agents stay at 1, but on belayo that org is also the
-- partner's own company with real staff, and an agent THEY invite is lifted
-- like any other — to exactly the back office its inviter already has.
--
-- Not changed:
--   * A reused account (credential rotation via target_actor_id) keeps its
--     admin_type. Partner deployments guard UPDATEs of the column with
--     prevent_admin_type_change (service_role only), and a grant an operator
--     made must survive rotation. Consequence: rebinding an agent onto a team in
--     ANOTHER org moves org_id and carries the admin_type along, as before.
--   * Existing agent accounts. Lifting them is a data change on the partner's
--     table and goes through service_role, outside this migration.
--   * The member branch.
--
-- Body otherwise carried forward verbatim from
-- 20260819000000_claim_invite_keeps_daemon_user.sql.

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
  v_old_org     uuid;   -- claimer's previous org (member path)
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
    else
      v_user_id := auth.uid();
      if v_user_id is null then raise exception 'member claim requires authentication' using errcode = '42501'; end if;
      if exists (select 1 from amux.actors act where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
        raise exception 'already a member of this team' using errcode = '23505';
      end if;

      insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values (v_invite.team_id, 'member', v_user_id, v_invite.invited_by_actor_id, v_invite.display_name, now())
      returning id into v_actor;
      insert into amux.members (id, status) values (v_actor, 'active');
      insert into amux.team_members (team_id, member_id, role) values (v_invite.team_id, v_actor, v_invite.team_role);
    end if;

    -- S3-FC.3: strict single-org — claimer's org becomes the invite team's org.
    if v_team_org is not null and v_user_id is not null then
      select org_id into v_old_org from public.users where id = v_user_id;
      if v_old_org is null then
        insert into public.users (id, org_id, mobile) values (v_user_id, v_team_org, '');
      else
        update public.users set org_id = v_team_org, updated_at = now() where id = v_user_id;
      end if;
      -- best-effort GC of OUR teams under the abandoned old org; never fail the
      -- claim. public.orgs is deliberately left alone — see 20260817000000: that
      -- row belongs to saas-mono, and on a merged instance deleting it cascades
      -- into another product's data.
      begin
        if v_old_org is not null and v_old_org <> v_team_org
           and not exists (select 1 from public.users where org_id = v_old_org) then
          delete from amux.teams where oid = v_old_org;   -- cascades actors/members/sessions/...
        end if;
      exception when others then
        null;  -- leave the orphan; reassignment already succeeded
      end;
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
  'Consumes an invite token. Member claims move the claimer onto the invite team''s org (strict single-org) and collect any amux.teams left under the org they vacated; public.orgs and its rows are never deleted here — that table is saas-mono-owned. Agent claims that name a target_actor_id rotate the credential in place: the agent keeps the auth.users account it already had, so anything keyed on that user id (public.users.admin_type, user_metadata, grants) survives the rotation. A NEW agent account is written at admin_type 2 when the inviter is staff (admin_type >= 2, own or same-phone row) of the team''s org, else 1.';
