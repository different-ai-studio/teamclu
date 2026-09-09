-- amux.apps.auth_audience — WHO may enter an app that has a login wall.
--
-- `auth_mode` answers "is there a wall"; this column answers "who gets past
-- it". They are orthogonal, and conflating them is what made the first design
-- ambiguous: "requires login" meant one thing to someone publishing a customer
-- tool and another to someone publishing an internal dashboard.
--
--   'any' — anyone with an account on this platform's Supabase. The visitor
--           registers through the app's own login page (GoTrue /otp with
--           create_user), so this really does mean the general public.
--   'org' — additionally, the visitor's org must equal the app's:
--           public.users.org_id = teams.oid for the app's team.
--
-- Only meaningful while auth_mode = 'platform'; ignored otherwise.
--
-- WHY THE DEFAULT IS THE STRICT ONE. The apps design (§7, "公开性必须显式化")
-- records the failure this avoids: `visibility` defaults to 'personal' and
-- `auth_mode` to 'none', so a self-serve user's "personal" app went out fully
-- public and the two words did not mean what they appeared to. A column whose
-- default widens access repeats that. Opening an app to everyone is a decision
-- someone makes on purpose, so it is the value you have to choose.
--
-- Nothing needs backfilling: the default applies to existing rows, and no app
-- has ever served a working `platform` login (the GoTrue OAuth server is
-- disabled on the box and APP_SECRETS_ENCRYPTION_KEY is empty, so
-- applyAuthModeChange could never complete). There is no live audience to
-- preserve.

alter table amux.apps
  add column if not exists auth_audience text not null default 'org';

alter table amux.apps
  drop constraint if exists apps_auth_audience_check;
alter table amux.apps
  add constraint apps_auth_audience_check check (auth_audience in ('any', 'org'));

comment on column amux.apps.auth_audience is
  'Who may pass this app''s login wall: ''any'' = any account on this platform, ''org'' = only members of the app team''s org (public.users.org_id = teams.oid). Only read when auth_mode = ''platform''. Enforced in the FC proxy gateway, not in the deployed function, so a change takes effect without redeploying.';
