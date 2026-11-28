begin;

select plan(7);

create temporary table studio_write_signatures (signature text primary key);
insert into studio_write_signatures values
  ('amux.claim_team_invite_legacy(text)'),
  ('amux.create_session(uuid, uuid, text, text)'),
  ('amux.create_team(text, text, text, text, text)'),
  ('amux.create_team(text, text, text, text, text, uuid)'),
  ('amux.switch_active_team(uuid)'),
  ('amux.upgrade_account_to_org(uuid, text, text, uuid)'),
  ('amux.set_team_default_agent(uuid, uuid)'),
  ('amux.join_or_create_org_team(uuid, uuid, text, text, text, text, text)'),
  ('amux.join_public_team(uuid, uuid)'),
  ('amux.bootstrap_current_org_team(uuid, text)'),
  ('amux.claim_team_invite(text)'),
  ('amux.bootstrap_selected_org_team(uuid, text)'),
  ('amux.ensure_agent_for_device(uuid, text, text)'),
  ('amux.create_team_row(text, text, text, text, text, uuid, text)'),
  ('amux.ensure_org_public_team(uuid, text, text)'),
  ('amux.bootstrap_login_team(boolean, uuid, text, text)');

select is((
  select count(*) from studio_write_signatures s
  join pg_proc p on p.oid = to_regprocedure(s.signature)
  where p.prosecdef
), 16::bigint, 'all reviewed security definer signatures remain');

select ok(
  has_function_privilege('authenticated', 'amux.upgrade_account_to_org(uuid, text, text, uuid)', 'EXECUTE'),
  'the authenticated Cloud API account-upgrade caller keeps EXECUTE'
);
select ok(
  has_function_privilege('anon', 'amux.claim_team_invite(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'amux.claim_team_invite(text)', 'EXECUTE'),
  'anonymous daemon claims and the existing service caller keep EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'amux.list_my_teams_current_org()', 'EXECUTE'),
  'the existing team-read routine remains executable by the app caller'
);

select ok(
  case when current_database() = 'teamclu_platform' then not exists (
    select 1 from studio_write_signatures s
    join pg_proc p on p.oid = to_regprocedure(s.signature)
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ) else exists (
    select 1 from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = 'amux.upgrade_account_to_org(uuid, text, text, uuid)'::regprocedure
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ) end,
  'PUBLIC ACL changes apply only to the Hangzhou platform database'
);

select * from skip('Studio reader assertions require the Hangzhou database fixture', 2)
where current_database() <> 'teamclu_platform';

select ok(
  not exists (
    select 1 from studio_write_signatures
    where has_function_privilege('teamclu_studio_reader', to_regprocedure(signature), 'EXECUTE')
  ),
  'Studio reader cannot execute any reviewed write routine'
) where current_database() = 'teamclu_platform';

select ok(
  has_schema_privilege('teamclu_studio_reader', 'amux', 'USAGE')
  and has_table_privilege('teamclu_studio_reader', 'amux.teams', 'SELECT')
  and has_function_privilege('teamclu_studio_reader', 'amux.list_my_teams_current_org()', 'EXECUTE'),
  'Studio reader still has existing table and read routine access'
) where current_database() = 'teamclu_platform';

select * from finish();
rollback;
