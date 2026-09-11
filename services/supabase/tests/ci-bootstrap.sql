-- Platform objects the migrations expect, for a database that has only the
-- Supabase Postgres image and none of the services around it.
--
-- On a real deployment the migrate step runs AFTER GoTrue and Storage, which
-- create their own schemas first — see the `depends_on` block on the `migrate`
-- service in deploy/self-host/docker-compose.yml. CI has neither service, so a
-- handful of objects the app migrations reference are simply absent and the
-- baseline fails on the first one.
--
-- This file fills exactly those gaps and nothing else. The image already ships
-- the `auth`, `storage`, `vault` and `extensions` schemas, auth.users,
-- auth.refresh_tokens, auth.uid()/role()/email(), and the anon / authenticated /
-- service_role / authenticator roles — none of that is recreated here.
--
-- Run it as a superuser: `auth` and `storage` are owned by supabase_admin, and
-- the image's `postgres` role is deliberately NOT a superuser, so it cannot
-- create objects in them. See the CI job for the connection it uses.
--
-- These are stand-ins for another service's schema, so they carry only the
-- columns our own migrations and tests touch. Anything beyond that would be
-- inventing a contract we do not own.

-- ############################################################################
-- ##  NEVER RUN THIS AGAINST A REAL DATABASE.                               ##
-- ############################################################################
--
-- This file ALTERs auth.users and creates tables in `auth` and `storage` —
-- schemas owned by GoTrue and Storage, not by this repo. On a real deployment
-- those services own their own migrations and this would corrupt them.
--
-- It lives in tests/, NOT in services/supabase/migrations/, so no deploy path
-- can pick it up: the self-host compose mount and self-host-deploy.yml point at
-- the migrations directory and never recurse into this one. Belayo migrations
-- are applied separately from its Dokploy Cloud API rollout.
--
-- The guard below is the belt to that suspenders: a CI database is empty when
-- this runs, so the presence of `amux` means someone pointed this at a real
-- deployment. Fail loudly instead of touching it.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'amux') THEN
    RAISE EXCEPTION
      'ci-bootstrap.sql refuses to run: schema "amux" already exists, so this is not an empty CI database. This file stubs GoTrue/Storage objects and must never touch a real deployment.';
  END IF;
END
$$;

-- ── auth.users: columns GoTrue added after the image was cut ────────────────
-- The image ships an older auth.users. Our migrations and tests read these
-- three; without them the actor_directory contact view fails to create.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone              text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_anonymous       boolean NOT NULL DEFAULT false;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_token_new     varchar(255);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_token_current varchar(255);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_change               text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_change_token         varchar(255);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS reauthentication_token     varchar(255);

-- auth.refresh_tokens gained session_id when GoTrue introduced sessions;
-- amux.mint_session writes it.
ALTER TABLE auth.refresh_tokens ADD COLUMN IF NOT EXISTS session_id uuid;

-- ── auth.sessions ───────────────────────────────────────────────────────────
-- Written by amux.mint_session (20260706000000_add_auth_mint_session.sql), which
-- inserts (id, user_id, aal, created_at, updated_at).
CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  aal        text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── storage ─────────────────────────────────────────────────────────────────
-- The baseline seeds buckets and defines RLS policies on storage.objects for
-- the attachments / avatars buckets.
CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  owner              uuid,
  public             boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  text REFERENCES storage.buckets(id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  path_tokens text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated, service_role;
GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;

-- ── auth helpers ────────────────────────────────────────────────────────────
-- The image ships an OLDER auth.uid() that only reads `request.jwt.claim.sub`.
-- The deployment's version also falls back to parsing the `request.jwt.claims`
-- JSON, which is the form every test here uses to assume an identity — against
-- the image's version auth.uid() comes back NULL and everything fails with
-- "not authenticated". Replaced with the definitions taken verbatim from the
-- running deployment so RLS behaves the same in both places.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

-- ── pgTAP ───────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgtap;
