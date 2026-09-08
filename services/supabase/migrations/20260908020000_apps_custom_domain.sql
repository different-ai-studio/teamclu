-- A domain the app's owner controls, bound to one app.
--
--   custom_domain              — ASCII (punycode) hostname. That is the form
--                                DNS carries, the form the certificate is
--                                issued for, and the form an incoming Host
--                                header holds, so storing anything else would
--                                mean converting on every lookup.
--   custom_domain_token        — the value that must appear in
--                                TXT _teamclu.<domain> to prove ownership.
--                                Reissued whenever the domain changes.
--   custom_domain_verified_at  — when that proof last succeeded. NULL means
--                                the domain is STORED BUT NOT SERVED.
--
-- The verified_at column is what the certificate gate reads. Caddy asks this
-- service before completing a TLS handshake for a name it has no certificate
-- for, and answering 200 for an unverified name would turn that gate into an
-- open certificate-minting endpoint — anyone can point a hostname at the box,
-- and Let's Encrypt's rate limit counts per REGISTERED domain, shared with
-- api/supabase/mqtt on the same name.
--
-- Traffic goes through OUR proxy, not through Alibaba FC's custom domains: a
-- custom domain there needs an ICP filing the owner's domain does not have,
-- and the proxy is already where Host → app routing and the login wall live,
-- so a user domain inherits both without further work.
--
-- NOTE for anyone reading the code: `ensureCustomDomain` / `deleteCustomDomain`
-- in provisioning/fc-client.ts are a DIFFERENT thing — the Alibaba-side route
-- host (<label>.$APPS_FC_ROUTE_DOMAIN) that the proxy forwards to. They have
-- nothing to do with these columns.

alter table amux.apps
  add column if not exists custom_domain text,
  add column if not exists custom_domain_token text,
  add column if not exists custom_domain_verified_at timestamptz;

-- One domain, one app. A partial index so the (very many) apps with no custom
-- domain do not all collide on NULL, and lower() because hostnames are
-- case-insensitive while text columns are not.
create unique index if not exists apps_custom_domain_uniq
  on amux.apps (lower(custom_domain))
  where custom_domain is not null;

comment on column amux.apps.custom_domain is
  'ASCII (punycode) hostname bound to this app, or NULL. Served only once custom_domain_verified_at is set.';
comment on column amux.apps.custom_domain_verified_at is
  'When DNS ownership of custom_domain was last proven. NULL = stored but NOT served: the Caddy certificate gate answers 404 for it, so no certificate is ever requested.';
