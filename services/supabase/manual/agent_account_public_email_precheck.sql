-- ============================================================================
-- agent_account_public_email — pre-check before the backfill (read-only)
--
-- Run BEFORE agent_account_public_email_backfill.sql. Nothing here writes.
--
--     psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f \
--       services/supabase/manual/agent_account_public_email_precheck.sql
--
-- Agent accounts are the auth.users rows TeamClu mints as
-- daemon.<id>@amuxd.run (amux.claim_team_invite_legacy). Their public.users
-- row has the same id and, before 20261009000000, email = ''.
--
-- What to look at:
--   1) How many rows the backfill will touch, by admin_type. belayo had 116
--      agent accounts, 4 lifted to admin by hand (20261008010000 header).
--   2) For every agent at admin_type >= 2: where saas-mono already uses it.
--      saas-mono's staff list (apps/api/src/services/admin-employee.ts
--      listEmployees, apps/admin/.../employee/lib/employee.ts getEmployees)
--      selects org_id + admin_type in (2,3,4); it never filters on email, so
--      the backfill does not change WHO is listed, only fills the column.
--      Any non-zero count below means the agent is wired into scheduling or
--      performance — confirm with the partner that is intended before going on.
--
-- saas-mono tables are checked only where they exist (self-host has none of
-- them), so this runs anywhere.
-- ============================================================================

\echo '== 1) rows the backfill will touch, by admin_type'
select u.admin_type, count(*) as agents, count(*) filter (where u.email = '') as blank_email
  from public.users u
  join auth.users au on au.id = u.id
 where au.email like 'daemon.%@amuxd.run'
 group by u.admin_type
 order by u.admin_type;

\echo '== 2) staff-grade agents and where saas-mono references them'
create temp table _agent_staff as
select u.id, u.org_id, u.admin_type, u.email, au.email as login_email,
       (select o.name from public.orgs o where o.id = u.org_id) as org_name
  from public.users u
  join auth.users au on au.id = u.id
 where au.email like 'daemon.%@amuxd.run'
   and u.admin_type >= 2;

create temp table _agent_refs (user_id uuid, ref text, n bigint);

do $$
declare
  -- (label, table, predicate on the agent id `a.id`)
  v_checks text[][] := array[
    ['roles_users (角色)',                  'public.roles_users',                  't.user_id = a.id'],
    ['staffs',                               'public.staffs',                       't.id = a.id'],
    ['coaches (教练档案)',                  'public.coaches',                      't.user_id = a.id'],
    ['schedules via coaches (排课)',        'public.schedules',                    't.coach_id in (select c.id from public.coaches c where c.user_id = a.id)'],
    ['coach_schedules via coaches (排班)',  'public.coach_schedules',              't.coach_id in (select c.id from public.coaches c where c.user_id = a.id)'],
    ['schedule_staffs (排课人员)',          'public.schedule_staffs',              't.user_id = a.id'],
    ['coach_schedule_confirmations',         'public.coach_schedule_confirmations', 't.coach_user_id = a.id or t.confirmed_by = a.id'],
    ['work_sessions',                        'public.work_sessions',                't.user_id = a.id'],
    ['workers',                              'public.workers',                      't.user_id = a.id'],
    ['order_attributions (业绩归属)',       'public.order_attributions',           't.user_id = a.id'],
    ['orders.consultant_id / consultant_ids','public.orders',                       't.consultant_id = a.id or a.id = any(t.consultant_ids)'],
    ['orders.affiliate_user_id',             'public.orders',                       't.affiliate_user_id = a.id'],
    ['users.consultant (会籍顾问)',         'public.users',                        't.consultant = a.id'],
    ['order_items.redeemed_by (核销)',      'public.order_items',                  't.redeemed_by = a.id'],
    ['revenue_sharing_details (分成)',      'public.revenue_sharing_details',      't.role_id = a.id']
  ];
  i int;
begin
  for i in 1 .. array_length(v_checks, 1) loop
    if to_regclass(v_checks[i][2]) is null then
      raise notice 'skip % — % does not exist here', v_checks[i][1], v_checks[i][2];
      continue;
    end if;
    begin
      execute format(
        'insert into _agent_refs select a.id, %L, count(*) from _agent_staff a join %s t on (%s) group by a.id',
        v_checks[i][1], v_checks[i][2], v_checks[i][3]);
    exception when undefined_column then
      raise notice 'skip % — column shape differs on this database', v_checks[i][1];
    end;
  end loop;
end;
$$;

select a.id, a.org_name, a.admin_type, a.email as current_email, a.login_email,
       coalesce(string_agg(r.ref || '=' || r.n, ', ' order by r.ref), '(none)') as referenced_by
  from _agent_staff a
  left join _agent_refs r on r.user_id = a.id and r.n > 0
 group by a.id, a.org_name, a.admin_type, a.email, a.login_email
 order by a.org_name, a.id;
