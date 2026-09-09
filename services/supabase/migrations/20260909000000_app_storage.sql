-- Per-app file storage: where an app's bytes live, and how much of it it has used.
--
-- Design: docs/specs/2026-09-09-app-storage-design.md
--
-- Four nullable columns, no backfill. Everything about the layout is derivable
-- from the app id (`app-files/<appId>/…`), so an existing row needs no value to
-- be correct — NULL here means "the deployment default", not "unknown".
--
-- `oss_bucket` is the escape hatch of §2.3: it exists so the key builder reads
-- the bucket off the row instead of a constant. It is expected to stay NULL for
-- every app; the day one customer needs a dedicated bucket, that is a row
-- update rather than a code change.
--
-- Guarded with an existence check rather than `add column if not exists`:
-- that form checks ownership BEFORE it checks whether the column is there, so
-- on a deployment whose migrate role does not own amux.apps it fails with
-- `must be owner of table apps` even when there is nothing to do. CI runs as
-- supabase_admin and self-host as postgres, so the two disagree on ownership
-- and CI cannot see the failure.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux' and table_name = 'apps' and column_name = 'oss_bucket'
  ) then
    alter table amux.apps add column oss_bucket text;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux' and table_name = 'apps' and column_name = 'storage_bytes'
  ) then
    alter table amux.apps add column storage_bytes bigint;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux' and table_name = 'apps' and column_name = 'storage_counted_at'
  ) then
    alter table amux.apps add column storage_counted_at timestamptz;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux' and table_name = 'apps' and column_name = 'storage_quota_bytes'
  ) then
    alter table amux.apps add column storage_quota_bytes bigint;
  end if;
end $$;

comment on column amux.apps.oss_bucket is
  'Bucket holding this app''s files. NULL means the deployment''s apps bucket (APPS_OSS_BUCKET). Present so the key builder reads the bucket from the row, not a constant; a dedicated bucket per app is deliberately NOT the default (see design 2026-09-09 §2).';

comment on column amux.apps.storage_bytes is
  'Bytes under app-files/<appId>/ as of storage_counted_at. EVENTUALLY CONSISTENT: the app writes to OSS directly with an STS token, so this is a periodic ListObjectsV2 sweep, not a running total. Never bill from it and never treat it as a synchronous quota.';

comment on column amux.apps.storage_counted_at is
  'When storage_bytes was last measured. NULL means never measured, which is not the same as zero bytes.';

comment on column amux.apps.storage_quota_bytes is
  'Per-app ceiling. NULL falls back to APPS_STORAGE_QUOTA_BYTES so raising the global default does not need a backfill. Enforced when credentials are minted, not per write.';
