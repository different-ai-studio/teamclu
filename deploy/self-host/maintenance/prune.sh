#!/bin/sh
# Keeps the self-host box's disk from filling up. Run from deploy/self-host
# (the nightly self-host-deploy.yml does, before it builds).
#
# On 2026-11-24 the 40G root disk hit 100%: Postgres could not write
# postmaster.pid, EMQX could not write its config, both crash-looped, and the
# Cloud API answered 502. Two things had grown without any bound:
#
#   1. Supabase Analytics (Logflare, postgres backend) keeps one table per log
#      source in the _supabase database, `_analytics.log_events_<source>`, and
#      never deletes from them. Kong's table alone had reached 9.9GB in five
#      months. Studio's log explorer is the only reader.
#   2. Every `docker compose build fc ai-gateway` leaves the previous images
#      dangling and adds to the build cache.
#
# Deleting old rows does not shrink the table files, but autovacuum makes the
# space reusable, so with a daily trim each table levels off at about
# LOG_RETENTION_DAYS of logs.
#
# Never fails the caller: a deploy should not stop because housekeeping did.

LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-14}"

echo "  disk before: $(df -h / | awk 'NR==2 {print $5 " used, " $4 " free"}')"

echo "  trim _analytics.log_events_* to ${LOG_RETENTION_DAYS} days"
PGPASSWORD="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
if ! docker compose exec -T -e PGPASSWORD="$PGPASSWORD" db \
    psql -U supabase_admin -d _supabase -v ON_ERROR_STOP=1 -q -v days="$LOG_RETENTION_DAYS" \
    < "$(dirname "$0")/prune-analytics-logs.sql"; then
  echo "  WARN analytics log trim failed (continuing)"
fi

echo "  drop dangling images and build cache older than 7 days"
docker image prune -f >/dev/null || echo "  WARN docker image prune failed (continuing)"
docker builder prune -f --filter until=168h >/dev/null || echo "  WARN docker builder prune failed (continuing)"

echo "  disk after: $(df -h / | awk 'NR==2 {print $5 " used, " $4 " free"}')"
exit 0
