-- Read-only. Run on each live database (self-host, belayo) BEFORE applying
-- migrations/20261119000100_drop_idea_external_refs.sql.
--
-- That migration refuses to drop the table if it has any rows; this tells you
-- in advance whether it will, and what is in it. Expected result everywhere:
-- the table exists and has 0 rows.

begin transaction read only;

-- 1. Does the table exist, and how many rows does it hold?
select to_regclass('amux.idea_external_refs') as table_exists;
select count(*) as rows from amux.idea_external_refs;

-- 2. If rows > 0: what are they, and when were they last written?
select provider, count(*) as rows, min(created_at) as first, max(updated_at) as last
  from amux.idea_external_refs
 group by provider
 order by rows desc;

-- 3. Nothing outside the table may depend on it (views, foreign keys from
--    other tables). Expected: no rows. The migration drops without CASCADE,
--    so anything listed here would make it fail.
select distinct d.classid::regclass as dependent_catalog,
       coalesce(v.oid::regclass::text, c.conname) as dependent
  from pg_depend d
  left join pg_rewrite r on d.classid = 'pg_rewrite'::regclass and r.oid = d.objid
  left join pg_class v on v.oid = r.ev_class and v.oid <> 'amux.idea_external_refs'::regclass
  left join pg_constraint c on d.classid = 'pg_constraint'::regclass and c.oid = d.objid
                           and c.conrelid <> 'amux.idea_external_refs'::regclass
 where d.refobjid = 'amux.idea_external_refs'::regclass
   and (v.oid is not null or c.oid is not null);

-- 4. Who owns it? The migration must run as this role (postgres on
--    self-host).
select pg_get_userbyid(relowner) as owner
  from pg_class where oid = 'amux.idea_external_refs'::regclass;

rollback;
