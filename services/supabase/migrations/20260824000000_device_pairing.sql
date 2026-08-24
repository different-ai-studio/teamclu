-- Device pairing for the ESP32 voice terminal (M5Stack StopWatch).
-- Design: docs/plans/2026-08-24-esp32-voice-terminal.md §8.1
--
-- Flow: amuxd mints a single-use pairing code and registers it here. The user
-- types that code into the device's captive portal alongside the Wi-Fi
-- credentials. Once online the device redeems the code for a long-lived device
-- secret, which it then exchanges for short-lived MQTT JWTs.
--
-- SECRET HANDLING. Neither the pairing code nor the device secret is stored in
-- the clear. Both are held as sha256 hashes and looked up by hash, so a dump of
-- these tables does not let the holder pair a device or connect to the broker.
-- The hash is unsalted precisely so it stays a *lookup key*; the inputs are
-- high-entropy random values, not user-chosen passwords, so the usual
-- rainbow-table argument for salting does not apply.
--
-- Idempotent: self-host apply-migrations re-runs safely.

-- ---------------------------------------------------------------------------
-- 1. device_pairing_codes — short-lived, single-use
-- ---------------------------------------------------------------------------
create table if not exists amux.device_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  -- sha256(code) hex. The code itself is never persisted.
  code_hash text not null,
  team_id uuid not null references amux.teams (id) on delete cascade,
  actor_id uuid not null references amux.actors (id) on delete cascade,
  -- Who minted it, for audit. Normally the daemon's own actor.
  created_by uuid references amux.actors (id) on delete set null,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  -- Set on redemption so a replay can be told apart from a fresh code.
  redeemed_by_device text,
  created_at timestamptz not null default now(),
  constraint device_pairing_codes_hash_format
    check (code_hash ~ '^[0-9a-f]{64}$')
);

create unique index if not exists uniq_device_pairing_codes_hash
  on amux.device_pairing_codes (code_hash);

-- Redemption looks up by hash and must reject expired/spent rows cheaply.
create index if not exists idx_device_pairing_codes_expiry
  on amux.device_pairing_codes (expires_at)
  where redeemed_at is null;

-- ---------------------------------------------------------------------------
-- 2. devices — one row per physically paired device
-- ---------------------------------------------------------------------------
create table if not exists amux.devices (
  -- Device-chosen stable id (factory MAC, lowercase hex, no separators).
  -- Not a secret: it is also the SoftAP SSID suffix and is printed on screen.
  id text primary key,
  team_id uuid not null references amux.teams (id) on delete cascade,
  actor_id uuid not null references amux.actors (id) on delete cascade,
  -- sha256(device_secret) hex. The secret is returned exactly once, at
  -- redemption, and never again — there is no recovery path but re-pairing.
  secret_hash text not null,
  model text not null default 'unknown',
  firmware text not null default '',
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  -- A physical device can be lost or stolen; revocation is the only recovery.
  revoked_at timestamptz,
  constraint devices_id_format check (id ~ '^[0-9a-f]{4,32}$'),
  constraint devices_secret_hash_format check (secret_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists idx_devices_team on amux.devices (team_id)
  where revoked_at is null;

create index if not exists idx_devices_actor on amux.devices (actor_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------
-- Both tables hold credential material and are only ever touched by FC using
-- the service role. No policy grants any access to `authenticated`: enabling
-- RLS with zero policies is the deny-all default, which is what we want. The
-- device itself is unauthenticated at redemption time and reaches these rows
-- only through FC, never directly.
alter table amux.device_pairing_codes enable row level security;
alter table amux.devices enable row level security;

revoke all on amux.device_pairing_codes from anon, authenticated;
revoke all on amux.devices from anon, authenticated;

grant select, insert, update, delete on amux.device_pairing_codes to service_role;
grant select, insert, update, delete on amux.devices to service_role;

-- ---------------------------------------------------------------------------
-- 4. Housekeeping
-- ---------------------------------------------------------------------------
-- Spent and expired codes have no value and should not accumulate. Called by
-- the redeem path; deliberately not a cron job, so there is one less moving
-- part to misconfigure.
create or replace function amux.purge_stale_device_pairing_codes()
returns void
language sql
security definer
set search_path = amux, public
as $$
  delete from amux.device_pairing_codes
   where expires_at < now() - interval '1 day'
      or (redeemed_at is not null and redeemed_at < now() - interval '1 day');
$$;

revoke all on function amux.purge_stale_device_pairing_codes() from public;
grant execute on function amux.purge_stale_device_pairing_codes() to service_role;
