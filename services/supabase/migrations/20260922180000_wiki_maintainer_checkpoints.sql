-- Cross-device Wiki maintainer checkpoint coordination (phase one).
-- Raw source documents and model credentials never enter these tables.

CREATE TABLE IF NOT EXISTS amux.wiki_maintainer_configs (
    team_id uuid PRIMARY KEY REFERENCES amux.teams(id) ON DELETE CASCADE,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    updated_by uuid NOT NULL REFERENCES amux.actors(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS amux.wiki_maintainer_checkpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES amux.teams(id) ON DELETE CASCADE,
    generation bigint NOT NULL CHECK (generation > 0),
    parent_generation bigint NOT NULL CHECK (parent_generation >= 0),
    object_key text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size bigint NOT NULL CHECK (size > 0 AND size <= 67108864),
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    created_by uuid NOT NULL REFERENCES amux.actors(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wiki_maintainer_checkpoint_generation_uniq UNIQUE (team_id, generation),
    CONSTRAINT wiki_maintainer_checkpoint_hash_uniq UNIQUE (team_id, sha256)
);

CREATE TABLE IF NOT EXISTS amux.wiki_maintainer_state (
    team_id uuid PRIMARY KEY REFERENCES amux.teams(id) ON DELETE CASCADE,
    config_version bigint NOT NULL DEFAULT 0 CHECK (config_version >= 0),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    current_checkpoint_id uuid REFERENCES amux.wiki_maintainer_checkpoints(id) ON DELETE SET NULL,
    stage text NOT NULL DEFAULT 'idle'
      CHECK (stage IN ('idle', 'ready_to_publish', 'publishing', 'sync_pending', 'needs_attention')),
    publishing jsonb,
    publish_token_hash text,
    published_generation bigint NOT NULL DEFAULT 0 CHECK (published_generation >= 0),
    published_commit text,
    sync_status text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wiki_maintainer_checkpoints_team_created
  ON amux.wiki_maintainer_checkpoints(team_id, created_at DESC);

ALTER TABLE amux.wiki_maintainer_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE amux.wiki_maintainer_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE amux.wiki_maintainer_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE amux.wiki_maintainer_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE amux.wiki_maintainer_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE amux.wiki_maintainer_state FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION amux.wiki_maintainer_put_config(
  p_team_id uuid,
  p_expected_version bigint,
  p_config jsonb,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = amux, pg_temp AS $$
DECLARE
  v_current bigint;
  v_next bigint;
  v_row amux.wiki_maintainer_configs;
BEGIN
  IF p_expected_version < 0 OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'invalid wiki maintainer config';
  END IF;
  INSERT INTO amux.wiki_maintainer_state(team_id) VALUES (p_team_id)
    ON CONFLICT (team_id) DO NOTHING;
  PERFORM 1 FROM amux.wiki_maintainer_state WHERE team_id = p_team_id FOR UPDATE;
  SELECT version INTO v_current FROM amux.wiki_maintainer_configs WHERE team_id = p_team_id;
  v_current := COALESCE(v_current, 0);
  IF v_current <> p_expected_version THEN
    RAISE EXCEPTION 'wiki config version conflict: current %, expected %', v_current, p_expected_version;
  END IF;
  v_next := v_current + 1;
  INSERT INTO amux.wiki_maintainer_configs(team_id, version, config, updated_by)
    VALUES (p_team_id, v_next, p_config, p_actor_id)
  ON CONFLICT (team_id) DO UPDATE SET
    version = EXCLUDED.version,
    config = EXCLUDED.config,
    updated_by = EXCLUDED.updated_by,
    updated_at = now()
  RETURNING * INTO v_row;
  UPDATE amux.wiki_maintainer_state
    SET config_version = v_next, updated_at = now()
    WHERE team_id = p_team_id;
  RETURN jsonb_build_object(
    'version', v_row.version,
    'config', v_row.config,
    'updatedAt', v_row.updated_at
  );
END $$;

CREATE OR REPLACE FUNCTION amux.wiki_maintainer_complete_checkpoint(
  p_team_id uuid,
  p_expected_generation bigint,
  p_config_version bigint,
  p_object_key text,
  p_sha256 text,
  p_size bigint,
  p_manifest jsonb,
  p_created_by uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = amux, pg_temp AS $$
DECLARE
  v_state amux.wiki_maintainer_state;
  v_checkpoint amux.wiki_maintainer_checkpoints;
  v_ready boolean;
BEGIN
  INSERT INTO amux.wiki_maintainer_state(team_id) VALUES (p_team_id)
    ON CONFLICT (team_id) DO NOTHING;
  SELECT * INTO v_state FROM amux.wiki_maintainer_state
    WHERE team_id = p_team_id FOR UPDATE;
  IF v_state.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'wiki checkpoint generation conflict: current %, expected %',
      v_state.generation, p_expected_generation;
  END IF;
  IF v_state.config_version <> p_config_version THEN
    RAISE EXCEPTION 'wiki config version conflict: current %, expected %',
      v_state.config_version, p_config_version;
  END IF;
  IF v_state.stage = 'publishing' THEN
    RAISE EXCEPTION 'wiki publish is in progress';
  END IF;
  INSERT INTO amux.wiki_maintainer_checkpoints(
    team_id, generation, parent_generation, object_key, sha256, size, manifest, created_by
  ) VALUES (
    p_team_id, p_expected_generation + 1, p_expected_generation,
    p_object_key, p_sha256, p_size, p_manifest, p_created_by
  ) RETURNING * INTO v_checkpoint;
  v_ready := COALESCE((p_manifest->>'readyToPublish')::boolean, false);
  UPDATE amux.wiki_maintainer_state SET
    generation = v_checkpoint.generation,
    current_checkpoint_id = v_checkpoint.id,
    stage = CASE WHEN v_ready THEN 'ready_to_publish' ELSE 'idle' END,
    updated_at = now()
  WHERE team_id = p_team_id;
  RETURN jsonb_build_object(
    'generation', v_checkpoint.generation,
    'stage', CASE WHEN v_ready THEN 'ready_to_publish' ELSE 'idle' END,
    'checkpointId', v_checkpoint.id
  );
END $$;

CREATE OR REPLACE FUNCTION amux.wiki_maintainer_begin_publish(
  p_team_id uuid,
  p_generation bigint,
  p_config_version bigint,
  p_target_commit text,
  p_target_tree_hash text,
  p_base_tree_hash text,
  p_node_id text,
  p_publish_token_hash text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = amux, pg_temp AS $$
DECLARE
  v_state amux.wiki_maintainer_state;
  v_publishing jsonb;
BEGIN
  SELECT * INTO v_state FROM amux.wiki_maintainer_state
    WHERE team_id = p_team_id FOR UPDATE;
  IF NOT FOUND OR v_state.generation <> p_generation THEN
    RAISE EXCEPTION 'wiki checkpoint generation conflict';
  END IF;
  IF v_state.config_version <> p_config_version THEN
    RAISE EXCEPTION 'wiki config version conflict';
  END IF;
  IF v_state.stage <> 'ready_to_publish' THEN
    RAISE EXCEPTION 'wiki is not ready to publish (stage %)', v_state.stage;
  END IF;
  v_publishing := jsonb_build_object(
    'generation', p_generation,
    'targetCommit', p_target_commit,
    'targetTreeHash', p_target_tree_hash,
    'baseTreeHash', p_base_tree_hash,
    'nodeId', p_node_id,
    'actorId', p_actor_id,
    'startedAt', now()
  );
  UPDATE amux.wiki_maintainer_state SET
    stage = 'publishing',
    publishing = v_publishing,
    publish_token_hash = p_publish_token_hash,
    updated_at = now()
  WHERE team_id = p_team_id;
  RETURN jsonb_build_object('stage', 'publishing', 'publishing', v_publishing);
END $$;

CREATE OR REPLACE FUNCTION amux.wiki_maintainer_complete_publish(
  p_team_id uuid,
  p_publish_token_hash text,
  p_sync_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = amux, pg_temp AS $$
DECLARE
  v_state amux.wiki_maintainer_state;
  v_next_stage text;
  v_commit text;
BEGIN
  SELECT * INTO v_state FROM amux.wiki_maintainer_state
    WHERE team_id = p_team_id FOR UPDATE;
  IF NOT FOUND OR v_state.stage <> 'publishing'
     OR v_state.publish_token_hash <> p_publish_token_hash THEN
    RAISE EXCEPTION 'wiki publish token conflict';
  END IF;
  IF p_sync_status NOT IN ('synced', 'published_local_sync_pending') THEN
    RAISE EXCEPTION 'invalid wiki sync status';
  END IF;
  v_next_stage := CASE WHEN p_sync_status = 'synced' THEN 'idle' ELSE 'sync_pending' END;
  v_commit := v_state.publishing->>'targetCommit';
  UPDATE amux.wiki_maintainer_state SET
    stage = v_next_stage,
    published_generation = generation,
    published_commit = v_commit,
    publishing = NULL,
    publish_token_hash = NULL,
    sync_status = p_sync_status,
    updated_at = now()
  WHERE team_id = p_team_id;
  RETURN jsonb_build_object(
    'stage', v_next_stage,
    'generation', v_state.generation,
    'publishedCommit', v_commit,
    'syncStatus', p_sync_status
  );
END $$;

CREATE OR REPLACE FUNCTION amux.wiki_maintainer_recover_publish(
  p_team_id uuid,
  p_publish_token_hash text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = amux, pg_temp AS $$
DECLARE
  v_state amux.wiki_maintainer_state;
  v_publishing jsonb;
BEGIN
  SELECT * INTO v_state FROM amux.wiki_maintainer_state
    WHERE team_id = p_team_id FOR UPDATE;
  IF NOT FOUND OR v_state.stage <> 'publishing' THEN
    RAISE EXCEPTION 'wiki publish is not recoverable';
  END IF;
  v_publishing := v_state.publishing || jsonb_build_object(
    'recoveredBy', p_actor_id,
    'recoveredAt', now()
  );
  UPDATE amux.wiki_maintainer_state SET
    publishing = v_publishing,
    publish_token_hash = p_publish_token_hash,
    updated_at = now()
  WHERE team_id = p_team_id;
  RETURN jsonb_build_object('stage', 'publishing', 'publishing', v_publishing);
END $$;

REVOKE ALL ON amux.wiki_maintainer_configs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON amux.wiki_maintainer_checkpoints FROM PUBLIC, anon, authenticated;
REVOKE ALL ON amux.wiki_maintainer_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON amux.wiki_maintainer_configs TO service_role;
GRANT ALL ON amux.wiki_maintainer_checkpoints TO service_role;
GRANT ALL ON amux.wiki_maintainer_state TO service_role;

REVOKE ALL ON FUNCTION amux.wiki_maintainer_put_config(uuid,bigint,jsonb,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION amux.wiki_maintainer_complete_checkpoint(uuid,bigint,bigint,text,text,bigint,jsonb,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION amux.wiki_maintainer_begin_publish(uuid,bigint,bigint,text,text,text,text,text,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION amux.wiki_maintainer_complete_publish(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION amux.wiki_maintainer_recover_publish(uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION amux.wiki_maintainer_put_config(uuid,bigint,jsonb,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION amux.wiki_maintainer_complete_checkpoint(uuid,bigint,bigint,text,text,bigint,jsonb,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION amux.wiki_maintainer_begin_publish(uuid,bigint,bigint,text,text,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION amux.wiki_maintainer_complete_publish(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION amux.wiki_maintainer_recover_publish(uuid,text,uuid) TO service_role;
