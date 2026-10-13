-- Support sessions for the Windows helper. The helper is not signed in, so
-- clients never touch this table: Cloud API writes it with the service role.

create table amux.support_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null,
  phase text not null,
  support_user_id uuid,
  support_display_name text,
  bundle jsonb,
  conclusion text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint support_sessions_status_check check (
    status in ('waiting', 'redeemed', 'allowed', 'concluded', 'rejected', 'closed', 'expired')
  ),
  constraint support_sessions_phase_check check (
    phase in ('install', 'webview', 'manual')
  )
);

alter table amux.support_sessions enable row level security;

revoke all on amux.support_sessions from public, anon, authenticated;
grant select, insert, update, delete on amux.support_sessions to service_role;
