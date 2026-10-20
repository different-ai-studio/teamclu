-- Pending checkpoint uploads so unreferenced objects can be removed after 24 hours.
-- Checkpoint rows themselves stay governed by the service-role API.

CREATE TABLE IF NOT EXISTS amux.wiki_maintainer_uploads (
    object_key text PRIMARY KEY,
    team_id uuid NOT NULL REFERENCES amux.teams(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE amux.wiki_maintainer_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE amux.wiki_maintainer_uploads FORCE ROW LEVEL SECURITY;

REVOKE ALL ON amux.wiki_maintainer_uploads FROM PUBLIC, anon, authenticated;
GRANT ALL ON amux.wiki_maintainer_uploads TO service_role;
