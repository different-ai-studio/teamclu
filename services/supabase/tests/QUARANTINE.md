# The pgTAP suite

Nothing is quarantined. `run.sh` runs every `.sql` file in this directory and CI
fails on any failure.

That was not true until recently, and the reasons are worth keeping, because
most of them are traps that will silently re-appear in the next test somebody
writes.

## How to run

```sh
cd services/supabase/tests

# against a local stack
PGHOST=… PGUSER=postgres PGDATABASE=postgres ./run.sh

# against a compose deployment
PSQL="docker exec -i supabase-db psql -U postgres -d postgres" ./run.sh

./run.sh 016_session_list_v2_rpc.sql   # one file
```

Every file wraps itself in `begin … rollback`, so running the suite leaves
nothing behind and is safe against a live database.

To reproduce CI exactly (same image, empty database, all migrations):

```sh
docker run -d --name pgtap -e POSTGRES_PASSWORD=postgres \
  public.ecr.aws/supabase/postgres:17.6.1.106
docker cp "$PWD/../../.." pgtap:/work
docker exec -e PGUSER=supabase_admin -e PGPASSWORD=postgres -e PGDATABASE=postgres pgtap \
  psql -v ON_ERROR_STOP=1 -f /work/services/supabase/tests/ci-bootstrap.sql
docker exec -e PGUSER=supabase_admin -e PGPASSWORD=postgres -e PGDATABASE=postgres pgtap \
  bash -c 'MIGRATIONS_DIR=/work/services/supabase/migrations bash /work/deploy/self-host/init/apply-migrations.sh'
docker exec -e PGUSER=supabase_admin -e PGPASSWORD=postgres -e PGDATABASE=postgres pgtap \
  bash -c 'cd /work/services/supabase/tests && bash run.sh'
```

## Three ways this suite used to report green while failing

`run.sh` now guards all three. Do not loosen these checks.

1. **Indented TAP.** Failures were detected with `grep '^not ok'`, but psql's
   default aligned output wraps results in a bordered table and indents every
   TAP line by one space. 68 failing assertions across 10 files were invisible
   this way. Fixed by running psql with `-tA` *and* accepting leading
   whitespace in the grep — either alone would do, and neither alone is enough
   if someone changes the other.

2. **A crashed connection.** `ON_ERROR_STOP=0` makes psql exit 0 through SQL
   errors, so nothing looked at its exit code. A backend crash prints
   `server closed the connection unexpectedly` and no `ERROR:` line, so a file
   that killed the server mid-run counted as a pass — and every file after it
   died with `FATAL: the database system is in recovery mode`, which also
   contains no `ERROR:`, so the whole tail of the suite reported clean.
   `run.sh` now fails on a non-zero psql exit.

3. **A stale `plan()` count.** A file that declares `plan(17)` and runs 18
   assertions is not proving what it claims, but every individual assertion
   still says `ok`. `run.sh` now fails on `# Looks like you planned …`.

## Traps

### pgTAP's two-argument overloads

Assertions are overloaded on both `(schema, object)` and `(object, description)`,
and two untyped string literals bind to the **latter**:

```sql
select has_table('amux', 'session_read_markers');   -- asserts a table NAMED "amux"
```

Always pass a description. It picks the schema-qualified overload and makes the
output readable:

```sql
select has_table('amux', 'session_read_markers', 'session_read_markers exists');
```

`001_schema_shape.sql` was written entirely in the two-argument form — 68
assertions that could not have caught a schema change if they had ever run.

### A permission-denied function call segfaults the server

On the Supabase image this suite runs against (`postgres:17.6.1.106`), calling a
function the current role has no `EXECUTE` privilege for crashes the backend
instead of raising `42501`:

```sql
set role authenticated;
select pg_read_file('/etc/hostname');   -- server closed the connection unexpectedly
```

It reproduces with core functions, so it is the image's permission-denied path
rather than anything in this schema. Consequences:

* **Never call a function from a role that lacks EXECUTE on it.** Assert the
  privilege instead: `select ok(not has_function_privilege('authenticated',
  'amux.f(uuid)', 'EXECUTE'), …)`.
* Watch the *current* role, not just the role in the test you are writing.
  `015_rbac_shortcuts.sql` crashed because a helper call three sections later
  inherited `service_role` from an earlier `set role`.

### Impersonation swallows writes

`set role authenticated` (or `set_config('role', …)`) applies to everything that
follows, including fixture bookkeeping, and RLS silently filters writes that
match no policy — a DELETE or UPDATE that matches zero rows reports success.
Several tests were asserting against state their own cleanup had failed to
change: `002_rls.sql` (session_participants has no DELETE policy),
`003_team_invites.sql` (team_invites has no UPDATE policy, so backdating an
expiry did nothing and the "expired" invite claimed fine),
`claim_team_invite_agent_org.test.sql` (nulling `teams.oid`).

Do fixture setup and cleanup as the session role: `reset role;` at the top
level, or `execute 'reset role';` inside a `DO` block. Note that
`set_config('role', 'postgres', …)` is *not* the same thing — the temp tables
and fixtures belong to `supabase_admin`, and `postgres` is a different role that
has no privileges on them.

### Temp tables belong to whoever created them

A temp table created before `set role` is unreadable after it. Either grant it
(`grant select on fx to anon, authenticated, service_role;` — include every role
the file impersonates) or create and write it as the session role.

## Open questions this repair surfaced

These are product decisions, not test bugs. They are recorded here rather than
silently encoded as "expected".

### ~~Member re-invite is unreachable by its intended caller~~ → removed

Settled by deleting the feature: `20260811110000_remove_member_reinvite.sql`.

Its three parts disagreed. `create_team_invite(p_target_actor_id => …)` only
accepted a target whose auth user **was anonymous**; the claim branch then kept
the actor on that anonymous user and minted a fresh session + refresh token
**for it** (device recovery: get your anonymous membership back on a new
machine); but the wrapper added in `20260801010000` rejects anonymous and
bearerless callers for every member invite, and the person on the new device is
exactly such a caller. The only caller who could get through was somebody
already signed into a real account, who would then be handed credentials for the
anonymous one.

`p_target_actor_id` stays on the signature and keeps working for **agent**
invites — daemon credential rotation depends on it. `004_member_reinvite.sql`
now guards the removal and pins that agent path.

### A disabled member keeps reading their sessions

`current_member_id()` honours `members.status = 'disabled'`, but
`is_session_participant()` joins `session_participants` to `actors` and never
looks at status, so a disabled member still reads the sessions they are in.
Nothing in the product writes that status today — removal deletes the actor row
— so this is dormant rather than a live leak, and closing it would add a join to
the messages SELECT policy that `20260810040000`/`20260811000000` spent two
migrations trimming. Documented in `002_rls.sql` where the assertion used to be.

### The attachments bucket is public, but its paths must not be listable

`20260530000001_attachments_bucket_public.sql` deliberately made `attachments`
public (clients render attachment URLs with no bearer; the unguessable path is
the capability). It also added `attachments_public_read`, a `to public` SELECT
policy, "so the intent is visible". Serving a public URL never consults RLS, so
that policy did nothing for the URLs — what it did was open
`/storage/v1/object/list/attachments` to anyone with the anon key, which ships
in every deployed app's browser bundle. A listed path is a working public URL,
so "unguessable" had become "enumerable".

`20260920000000_attachments_bucket_team_scoped_policies.sql` keeps the bucket
public and scopes what RLS does govern — listing, and upload including the
read-back storage-api does for an upsert — to members of the team in the first
path segment. By-path reads are not among them: on a public bucket storage-api
v1.54.1 serves the authenticated download, HEAD and `/object/info` routes
without consulting RLS, exactly like `/object/public`, so a path remains a
capability until the bucket itself goes private. `019_idea_attachment_storage_rls.sql`
asserts that, pins the policy set on `storage.objects` — permissive policies OR
together, so one broad policy added later would undo it silently — and keeps the
older invariant that `team-skills` and `team-blobs` stay private.

Two things that file cannot show, because CI runs against a stub of the storage
schema rather than storage-api: the anon assertion is made on `pg_policies`
(the stub grants anon no table privilege, which would mask a bad policy), and
the upsert read-back is modelled as `INSERT … RETURNING`.

### A daemon can relay for any session participant

`daemon_can_write_gateway_message` authorizes a write for **any** participant of
a session the daemon's agent is in — that is how a WeCom user's message reaches
the table, but it also means a daemon can post as a human member of that
session. `005_agent_role_rls.sql` probes impersonation with a team member
outside the session, since a member inside it is relayable by design.

## Deleted

- `003_daemon_invites.sql` — the `daemon_invites` table no longer exists
  anywhere in the schema. The test covered a feature that was removed.
