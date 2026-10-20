-- ============================================================================
-- amux.apps.org_id becomes NOT NULL.
--
-- 20260923200000 made the column the app's live tenant pointer, backfilled it
-- and added the foreign key, but deliberately left it nullable: `org_id` was
-- written at the first successful finalize, so the constraint would have
-- rejected the INSERT that creates an app. `createApp` now settles the tenant
-- at creation (and answers 409 `team_has_no_org` when the team has no org
-- rather than letting this constraint surface as a 500), so the invariant can
-- be the database's rather than a convention.
--
-- WHY IT IS WORTH A CONSTRAINT. Every reader of this column treats a null as a
-- broken app and says so — the gateway with `no_app_org`, the login page with
-- a 503. Those branches exist because the column could be null, and they are
-- the kind of "cannot happen" path that rots unexercised. Making it impossible
-- is what lets them stay honest.
--
-- The backfill below is expected to update 0 rows: 20260923200000 already did
-- it. It is here because a migration must be able to run on a database where
-- an app was created between the two, and because a `set not null` that fails
-- on production data is a worse way to learn about such a row.
-- ============================================================================

update amux.apps a
set org_id = t.oid
from amux.teams t
where a.team_id = t.id
  and a.org_id is null
  and t.oid is not null;

-- A row with no team, or a team with no org, cannot be resolved here and must
-- not be guessed at. Fail with the ids rather than with a bare constraint
-- violation: `set not null` reports neither which rows nor why.
do $$
declare
  v_bad int;
  v_ids text;
begin
  select count(*), string_agg(id::text, ', ' order by id)
    into v_bad, v_ids
  from amux.apps where org_id is null;

  if v_bad > 0 then
    raise exception
      'cannot set amux.apps.org_id NOT NULL: % app(s) have no resolvable tenant (%). '
      'Each needs its team to have an oid, or the app removed.',
      v_bad, v_ids;
  end if;
end
$$;

alter table amux.apps
  alter column org_id set not null;
