-- Agent reply threads: forked child sessions (Discord-style), hidden from main list.
-- Idempotent (IF NOT EXISTS) for self-host apply-migrations loop.

ALTER TABLE amux.sessions
  ADD COLUMN IF NOT EXISTS parent_session_id uuid REFERENCES amux.sessions (id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS thread_root_message_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_thread_root_message_id_uniq
  ON amux.sessions (thread_root_message_id)
  WHERE thread_root_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_parent_session_id_idx
  ON amux.sessions (parent_session_id)
  WHERE parent_session_id IS NOT NULL;

ALTER TABLE amux.sessions DROP CONSTRAINT IF EXISTS sessions_thread_pair_check;
ALTER TABLE amux.sessions ADD CONSTRAINT sessions_thread_pair_check CHECK (
  (parent_session_id IS NULL AND thread_root_message_id IS NULL)
  OR (parent_session_id IS NOT NULL AND thread_root_message_id IS NOT NULL)
);

COMMENT ON COLUMN amux.sessions.parent_session_id IS 'NULL = main session; set for thread fork child sessions';
COMMENT ON COLUMN amux.sessions.thread_root_message_id IS 'Anchor agent_reply message id (unique per thread)';
