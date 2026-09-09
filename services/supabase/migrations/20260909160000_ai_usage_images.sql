-- Image generation billing on the team AI gateway.
--
-- Images are billed PER IMAGE, not per token (design
-- docs/specs/2026-09-09-image-generation-skill-design.md §2.1). The upstream
-- does return tokens, and they are still recorded here — but for margin
-- analysis only, exactly like `cached_input_tokens`. Billing simple, records
-- detailed.

-- 'fixed' = charged from a per-image price, no token arithmetic involved.
--
-- Not folded into 'upstream': the reports need to separate image spend from
-- token spend. Not folded into 'estimated' either — that value is the "an
-- upstream misbehaved and returned no usage" alarm, and a per-image charge is
-- not an estimate. Letting images land there would make that alarm meaningless.
alter table amux.ai_usage_logs
  drop constraint if exists ai_usage_logs_usage_source_check;
alter table amux.ai_usage_logs
  add constraint ai_usage_logs_usage_source_check
  check (usage_source in ('upstream', 'estimated', 'fixed'));

-- Without this, an n=4 request records credits = 4 × unit with nothing saying
-- it was four pictures, so "images this month" is not answerable.
--
-- Deliberately NOT `add column if not exists`: self-host applies migrations as
-- `postgres` while CI uses `supabase_admin`, and for a non-owner that form
-- errors even when there is nothing to do. The existence check runs the ALTER
-- only when it is actually needed, so a re-run is a no-op for both roles.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux'
       and table_name = 'ai_usage_logs'
       and column_name = 'image_count'
  ) then
    alter table amux.ai_usage_logs add column image_count int not null default 0;
  end if;
end
$$;
