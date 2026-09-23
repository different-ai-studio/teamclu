-- ============================================================================
-- amux.apps.org_id becomes the app's LIVE tenant pointer.
--
-- It used to mean something else. `20260827020000_apps_org_id.sql` introduced
-- it as "the org database this app's schema was created in" — a historical
-- fact, written once on the first successful finalize, deliberately NOT
-- backfilled and deliberately NOT a foreign key. That definition is being
-- retired here, on purpose and with the previous author's reasoning in view.
--
-- WHY. The app login page has to answer "which tenant is asking?" before it can
-- narrow the phone-login account picker to that tenant. Today it cannot: the
-- login page never loads any org at all, so it offers every org's identity for
-- a phone number and the proxy gateway rejects the wrong pick afterwards with
-- `wrong_org`. The gateway answers the same question from `teams.oid`. Two
-- sources for one fact is what produced the bug; this migration picks one.
--
-- WHY THIS COLUMN AND NOT `teams.oid`. `teams.oid` stays the team's org; the
-- app's tenant is now stated on the app. Product decision, taken with the
-- divergence below understood.
--
-- THE DIVERGENCE THIS HAS TO CLOSE. `amux.upgrade_account_to_org` reparents a
-- team to a brand-new org (`update amux.teams set oid = ...`). A column written
-- once at finalize would be stale from that moment on, so the function is
-- replaced below to carry the app rows along. Without that cascade "must be the
-- tenant id" is false the first time anyone upgrades an account.
--
-- ON BACKFILLING, WHICH THE PREVIOUS AUTHOR REFUSED. Their objection was that
-- "inventing one from today's `teams.oid` would just launder a guess into a
-- fact" — correct while the column meant *where the schema was created*, since
-- a reparented team would make today's oid the wrong answer to that question.
-- Under the new meaning the guess IS the fact: the tenant of an app is the org
-- its team belongs to right now. Verified before writing this: 24 apps, 19 with
-- a null org_id, 0 of them unresolvable (every app has a team and every one of
-- those teams has an oid), and all 5 rows that already carry a value agree with
-- their team's oid — so the backfill changes no existing answer.
--
-- NOT NULL IS NOT ADDED HERE. `org_id` is still written at first finalize, so
-- the constraint would reject the insert that creates an app. Adding it belongs
-- with the change that writes org_id at app-creation time.
-- ============================================================================

-- 1. Backfill from the team's org. `is null` only: never overwrite a stored
--    value, so a row that already disagrees (none today) is left for a human.
update amux.apps a
set org_id = t.oid
from amux.teams t
where a.team_id = t.id
  and a.org_id is null
  and t.oid is not null;

-- 2. A live pointer must point at something. No `on delete` clause, matching
--    `teams_oid_fkey` on the same target: deleting an org that still has apps
--    should fail loudly rather than silently null out their tenant.
alter table amux.apps
  drop constraint if exists apps_org_id_fkey;
alter table amux.apps
  add constraint apps_org_id_fkey
  foreign key (org_id) references public.orgs(id);

comment on column amux.apps.org_id is
  'The app''s tenant org — live, not historical. The login page narrows its account picker to this org and the proxy gateway resolves the app''s audience against it. Kept in step with the team''s org by amux.upgrade_account_to_org. Was previously "the org database the schema was created in"; that meaning was retired by 20260923200000.';

-- ============================================================================
-- 3. Reparenting an account now moves its apps too.
--
-- Byte-identical to `20260618010000_upgrade_account_to_org.sql` except for
-- step 5 at the end, so the diff shows exactly what changed.
-- ============================================================================
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

  -- 5. Carry this team's apps to the new org. `amux.apps.org_id` is a live
  --    tenant pointer (see 20260923200000): leaving it behind would point the
  --    app's login wall and account picker at the org the team just left.
  update amux.apps set org_id = v_org_id where team_id = p_team_id;

  return query select v_org_id, p_team_id, v_name;
end;
$function$;
