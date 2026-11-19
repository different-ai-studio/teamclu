-- Read-only. Run on each live database (self-host, belayo) BEFORE applying
-- migrations/20261119130000_drop_shortcut_role_visibility.sql.
--
-- That migration refuses to drop anything while amux.team_roles,
-- amux.team_member_roles or amux.permission_roles has rows; this tells you in
-- advance whether it will, and what is in them. Expected result everywhere:
-- all three exist and hold 0 rows.

begin transaction read only;

-- 1. Do the tables exist, and how many rows does each hold?
select to_regclass('amux.team_roles')        as team_roles_exists,
       to_regclass('amux.team_member_roles') as team_member_roles_exists,
       to_regclass('amux.permission_roles')  as permission_roles_exists;
select (select count(*) from amux.team_roles)        as team_roles_rows,
       (select count(*) from amux.team_member_roles) as team_member_roles_rows,
       (select count(*) from amux.permission_roles)  as permission_roles_rows;

-- 2. If any count > 0: which teams, and which shortcuts carry a restriction?
select r.team_id, r.code, r.name, count(tmr.id) as members_holding
  from amux.team_roles r
  left join amux.team_member_roles tmr on tmr.role_id = r.id
 group by r.team_id, r.code, r.name
 order by r.team_id, r.code;

select p.team_id, p.resource_id as shortcut_id, s.label, count(*) as roles_bound
  from amux.permission_roles pr
  join amux.permissions p on p.id = pr.permission_id
  left join amux.shortcuts s on s.id = p.resource_id
 group by p.team_id, p.resource_id, s.label
 order by p.team_id;

-- 3. Nothing outside the three tables may depend on them (views, foreign keys
--    from other tables). Expected: no rows. The migration drops without
--    CASCADE, so anything listed here would make it fail.
select distinct d.refobjid::regclass as table_name,
       d.classid::regclass as dependent_catalog,
       coalesce(v.oid::regclass::text, c.conname) as dependent
  from pg_depend d
  left join pg_rewrite r on d.classid = 'pg_rewrite'::regclass and r.oid = d.objid
  left join pg_class v on v.oid = r.ev_class
  left join pg_constraint c on d.classid = 'pg_constraint'::regclass and c.oid = d.objid
 where d.refobjid in ('amux.team_roles'::regclass,
                      'amux.team_member_roles'::regclass,
                      'amux.permission_roles'::regclass)
   and (
     (v.oid is not null and v.oid not in ('amux.team_roles'::regclass,
                                          'amux.team_member_roles'::regclass,
                                          'amux.permission_roles'::regclass))
     or (c.oid is not null and c.conrelid not in ('amux.team_roles'::regclass,
                                                   'amux.team_member_roles'::regclass,
                                                   'amux.permission_roles'::regclass))
   );

-- 4. Functions whose body still names them, besides the three the migration
--    drops and member_can_see_shortcut, which it rewrites. Expected: no rows.
select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as function
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog', 'information_schema')
   and p.prokind = 'f'
   and (p.prosrc ~ '\mteam_roles\M' or p.prosrc ~ '\mteam_member_roles\M'
        or p.prosrc ~ '\mpermission_roles\M' or p.prosrc ~ '\mmember_can_access_permission\M')
   and p.proname not in ('member_can_access_permission', 'shortcut_set_visible_roles',
                         'team_member_set_roles', 'member_can_see_shortcut');

-- 5. Who owns them? The migration must run as this role (postgres on
--    self-host).
select relname, pg_get_userbyid(relowner) as owner
  from pg_class
 where oid in ('amux.team_roles'::regclass,
               'amux.team_member_roles'::regclass,
               'amux.permission_roles'::regclass);

rollback;
