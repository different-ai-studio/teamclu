-- Restrict execution of the audited write routines only on the Hangzhou platform database.
-- This file also ships in the portable migration inventory. Other databases keep their ACLs.
do $restrict_studio_write_routines$
declare
  studio_reader constant name := 'teamclu_studio_reader';
  platform_admin constant name := 'teamclu_platform_admin';
  migration_owner constant name := 'teamclu_migration_owner';
  upgrade_signature constant text := 'amux.upgrade_account_to_org(uuid, text, text, uuid)';
  target record;
  routine_oid oid;
  routine_pass integer;
  actual_acl text[];
  restricted_acl text[];
begin
  if current_database() <> 'teamclu_platform' then
    return;
  end if;

  if session_user <> platform_admin or current_user <> platform_admin or pg_is_in_recovery() then
    raise exception 'Studio ACL migration requires the standing platform administrator on the platform primary';
  end if;
  if to_regrole(studio_reader) is null or to_regrole(migration_owner) is null then
    raise exception 'Expected Studio reader and migration owner roles are missing';
  end if;
  if not pg_has_role(platform_admin, migration_owner, 'SET') then
    raise exception 'Platform administrator cannot become the original ensure_agent_for_device grantor';
  end if;

  -- This migration does not change table grants or role membership. Stop if the
  -- reader has acquired persistent write privileges outside the audited routines.
  if has_database_privilege(studio_reader, current_database(), 'CREATE')
    or exists (
      select 1 from pg_roles r
      where r.rolname = studio_reader
        and (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls)
    )
    or exists (
      select 1 from pg_roles r
      where r.rolname <> studio_reader and pg_has_role(studio_reader, r.oid, 'SET')
    )
    or exists (
      select 1 from pg_namespace n
      where n.nspname !~ '^pg_(temp|toast_temp)_[0-9]+$'
        and has_schema_privilege(studio_reader, n.oid, 'CREATE')
    )
    or exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where has_schema_privilege(studio_reader, n.oid, 'USAGE')
        and n.nspname !~ '^pg_(temp|toast_temp)_[0-9]+$'
        -- This system view writes session settings, not persistent relation rows.
        and (n.nspname, c.relname) <> ('pg_catalog', 'pg_settings')
        and case
          when c.relkind = 'S' then has_sequence_privilege(studio_reader, c.oid, 'UPDATE,USAGE')
          when c.relkind in ('r','p','v','m','f') then
            has_table_privilege(studio_reader, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
            or has_any_column_privilege(studio_reader, c.oid, 'INSERT,UPDATE')
          else false
        end
    )
  then
    raise exception 'Unexpected direct writes or role membership for the Studio reader';
  end if;

  -- The audited ACL shape includes the grantor and grant-option bit. The hashes
  -- pin the reviewed body, security mode and settings of each exact overload.
  for target in
    select * from (values
        ('amux.claim_team_invite_legacy(text)',
          'teamclu_platform_admin', 'e6c9d8e23cca6b14409bc3aedfee4b24', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'anon:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.create_session(uuid, uuid, text, text)',
          'teamclu_platform_admin', '9ba4718a568db91d3ad404469008893e', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'anon:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.create_team(text, text, text, text, text)',
          'teamclu_platform_admin', '5b09cddff80cdb2472c5f9689e447ee9', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'anon:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.create_team(text, text, text, text, text, uuid)',
          'teamclu_platform_admin', '3449048d061e24834b71a4140b66fa43', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'anon:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.switch_active_team(uuid)',
          'teamclu_platform_admin', 'fc945360d9e7958b18166431339ab2d1', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'anon:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.upgrade_account_to_org(uuid, text, text, uuid)',
          'teamclu_platform_admin', 'bac0a570b0c431bd1a5fc3760b2351a4', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.set_team_default_agent(uuid, uuid)',
          'teamclu_platform_admin', 'c19ed6be482d47e1b8b03056b2d58eaf', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.join_or_create_org_team(uuid, uuid, text, text, text, text, text)',
          'teamclu_platform_admin', '9755e3ac8b51361dec4590d10cbffa98', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.join_public_team(uuid, uuid)',
          'teamclu_platform_admin', 'b3f5719aba9973a664a40801761fe24b', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.bootstrap_current_org_team(uuid, text)',
          'teamclu_platform_admin', '2551e892c5df739f47687c24013a3705', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.claim_team_invite(text)',
          'teamclu_platform_admin', '84755121acd4573ddf5c69c9c79486d8', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'anon:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.bootstrap_selected_org_team(uuid, text)',
          'teamclu_platform_admin', 'd096d9412d077754696b13d3367b1379', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.ensure_agent_for_device(uuid, text, text)',
          'teamclu_migration_owner', '7522b8828b09bcaea85fe56a3abc3ed0', ARRAY[
            'PUBLIC:teamclu_migration_owner:false',
            'authenticated:teamclu_migration_owner:false',
            'service_role:teamclu_migration_owner:false',
            'teamclu_migration_owner:teamclu_migration_owner:false',
            'teamclu_platform_admin:teamclu_migration_owner:true'
          ]),
        ('amux.create_team_row(text, text, text, text, text, uuid, text)',
          'teamclu_platform_admin', '7e8e4fe4c7cbeb5c4b3968703f3c07d7', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.ensure_org_public_team(uuid, text, text)',
          'teamclu_platform_admin', 'dd3290aeb043fee60da31e467662410a', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ]),
        ('amux.bootstrap_login_team(boolean, uuid, text, text)',
          'teamclu_platform_admin', '982702bae2f63bad09c5a05a02ac3a1f', ARRAY[
            'PUBLIC:teamclu_platform_admin:false',
            'authenticated:teamclu_platform_admin:false',
            'service_role:teamclu_platform_admin:false',
            'teamclu_platform_admin:teamclu_platform_admin:false'
          ])
    ) as approved(signature, owner, definition_md5, baseline_acl)
  loop
    routine_oid := to_regprocedure(target.signature);
    restricted_acl := array_remove(target.baseline_acl, 'PUBLIC:' || target.owner || ':false');
    if target.signature = upgrade_signature then
      -- Cloud API calls this routine with the authenticated user's bearer.
      restricted_acl := array_prepend('authenticated:teamclu_platform_admin:false', restricted_acl);
    end if;

    for routine_pass in 1..2 loop
      select array_agg(entry order by entry collate "C") into actual_acl
      from (
        select case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
          || ':' || pg_get_userbyid(acl.grantor) || ':' || acl.is_grantable::text as entry
        from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        where p.oid = routine_oid and p.prosecdef and p.prokind = 'f'
          and pg_get_userbyid(p.proowner) = target.owner
          and md5(pg_get_functiondef(p.oid)) = target.definition_md5
          and acl.privilege_type = 'EXECUTE'
      ) actual;

      if actual_acl = restricted_acl then
        exit;
      end if;
      if routine_pass = 2 or actual_acl is distinct from target.baseline_acl then
        raise exception 'Unexpected definition, ownership or ACL for %', target.signature;
      end if;

      if target.signature = upgrade_signature then
        grant execute on function amux.upgrade_account_to_org(uuid, text, text, uuid) to authenticated;
      end if;
      if target.owner <> platform_admin then
        execute format('set local role %I', migration_owner);
      end if;
      execute format('revoke execute on function %s from public', target.signature);
      if target.owner <> platform_admin then
        execute format('set local role %I', platform_admin);
      end if;
    end loop;

    if has_function_privilege(studio_reader, routine_oid, 'EXECUTE') then
      raise exception 'Studio reader still has EXECUTE on %', target.signature;
    end if;
  end loop;
end
$restrict_studio_write_routines$;
