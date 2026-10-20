# Manual ops scripts

One-off SQL meant to be run **by a human, against a database the deploy pipeline
does not reach**. Nothing here is applied automatically.

## Why this directory is not `../migrations/`

`deploy/self-host/init/apply-migrations.sh` applies **every** `.sql` file in
`../migrations/` in lexical order and records it in `_selfhost.schema_migrations`.
A script dropped in there gets run against the self-host box whether or not that
was the intent. Keep manual scripts here so the runner never sees them.

The flip side: nothing here is tracked, so a script in this directory tells you
nothing about whether it has been run anywhere. Treat each one as documentation
of a procedure, not as a record of state.

## Contents

| File | What it does |
|------|--------------|
| `gateway_session_switch_rds.sql` | Standalone copy of `20260728000000_gateway_session_switch.sql` (`gateway_key` + `list_gateway_sessions` + `attach_gateway_session`), adapted for a plain PostgreSQL/RDS target rather than a Supabase one. |
| `agent_account_public_email_precheck.sql` | Read-only. Counts the agent accounts (`daemon.<id>@amuxd.run`) whose `public.users.email` is blank, and lists where saas-mono already references the staff-grade ones (roles, scheduling, performance). Run before the backfill. |
| `agent_account_public_email_backfill.sql` | Copies each agent account's login email into its blank `public.users.email` (rows minted before `20261009000000_agent_account_public_email.sql`). |
| `member_identity_public_email_precheck.sql` | Read-only. Lists the staff-grade (`admin_type >= 2`) member identities whose `public.users.email` is blank and the email the backfill would write (from `email_users_links`, else the account's own real login email). |
| `member_identity_public_email_backfill.sql` | Fills those rows (identities minted before `20261009010000_member_identity_public_email.sql`). Customers (`admin_type 1`) and phone users are not touched. |

## Running one

All scripts here are written to be idempotent and to run in a single
transaction, so a failure rolls the whole thing back rather than leaving half a
schema behind:

```bash
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -1 -f services/supabase/manual/<script>.sql
```

## Before running anything against a non-Supabase target

Three assumptions the `migrations/` files make that a plain RDS instance will
not satisfy. Each script restates the ones that apply to it; this is the general
list.

1. **Function ownership.** `CREATE OR REPLACE FUNCTION` fails with
   `must be owner of function` if the existing function belongs to another role,
   and because migrations run in one transaction that aborts everything after it
   too. Check before you start:

   ```sql
   select proname, pg_get_userbyid(proowner) as owner
     from pg_proc where pronamespace = 'amux'::regnamespace;
   ```

   This is not hypothetical — see the note in `../migrations/README.md`.

2. **`gen_random_bytes` schema.** Supabase installs pgcrypto into `extensions`;
   a stock RDS instance usually puts it in `public`. Functions that call
   `extensions.gen_random_bytes(...)` need that reference adjusted.

3. **The `authenticated` role.** A Supabase-ism. `GRANT ... TO authenticated`
   errors out on a database that has no such role, so guard the grant and use
   the target's own role model instead.
