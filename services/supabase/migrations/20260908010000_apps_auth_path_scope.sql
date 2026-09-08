-- Which PATHS of an app sit behind its login wall.
--
-- `auth_mode` says whether there is a wall and `auth_audience` says who gets
-- past it; both are app-wide. Real apps are not: a product's landing page is
-- public while /app needs an account, and a docs site is readable by anyone
-- while editing is not. Without this, the only honest options were "all of it"
-- or "none of it".
--
--   auth_scope  — the baseline when no rule matches.
--                 'all'   → the whole site needs a login (the default, and
--                           what every app did before this column existed)
--                 'paths' → only what the rules protect
--   auth_rules  — exceptions, as [{"path": "/api", "auth": "required"|"public"}].
--                 The LONGEST matching path prefix wins.
--
-- Longest-prefix rather than list order keeps the set declarative: nobody has
-- to read the rules top to bottom to know what a URL resolves to. Same reason
-- routing tables work this way.
--
-- Prefix matching, not globs. Every rule people actually write is a prefix
-- (/admin, /api, /_serverFn); `*`/`**` would buy flexibility nobody asked for
-- at the price of explaining whether they cross a slash — and a misread glob
-- fails in the direction of "I thought that was protected". The API strips a
-- trailing `/*` (it is what people type) and refuses `*` anywhere else.
--
-- WHY BOTH COLUMNS, rather than expressing the baseline as a `{"path": "/"}`
-- rule: that root rule can be deleted, and an empty list would then mean "the
-- whole site is public" while auth_mode still claimed a wall — a contradiction
-- with no error attached. As its own column it has a CHECK constraint, and an
-- EMPTY auth_rules stays a perfectly ordinary state (most apps want the whole
-- site behind the login and need no exceptions at all).
--
-- WHY THEY LIVE ON amux.apps rather than in a table of their own: the rules are
-- strictly one-to-one with the app and share its lifetime, the gateway reads
-- them on EVERY request (so the existing single-query vanity lookup returns
-- them with no join), and they are only ever read and written whole — nothing
-- queries across rule rows.
--
-- Nothing to backfill: 'all' + [] reproduces exactly the behaviour every
-- existing row already had.

alter table amux.apps
  add column if not exists auth_scope text not null default 'all',
  add column if not exists auth_rules jsonb not null default '[]'::jsonb;

alter table amux.apps
  drop constraint if exists apps_auth_scope_check;
alter table amux.apps
  add constraint apps_auth_scope_check check (auth_scope in ('all', 'paths'));

-- A guard against a direct write, not against the API: the gateway treats a
-- non-array as "protect everything", so this keeps the failure at the write
-- rather than turning a whole site opaque later.
alter table amux.apps
  drop constraint if exists apps_auth_rules_is_array;
alter table amux.apps
  add constraint apps_auth_rules_is_array check (jsonb_typeof(auth_rules) = 'array');

comment on column amux.apps.auth_scope is
  'Baseline for the login wall when no rule in auth_rules matches: ''all'' = every path needs a login, ''paths'' = only what auth_rules protects. Read by the FC proxy gateway, so a change takes effect without redeploying.';

comment on column amux.apps.auth_rules is
  'Exceptions to auth_scope, as [{"path","auth"}] with auth in (required, public). Longest matching path PREFIX wins; matching is case-insensitive. Only read when auth_mode = ''platform''.';
