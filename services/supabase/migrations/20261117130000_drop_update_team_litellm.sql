-- Drop amux.update_team_litellm.
--
-- A LiteLLM-era leftover: SECURITY DEFINER, no check on who is calling, and
-- granted to `anon` and `authenticated`. It upserts litellm_team_id and
-- ai_gateway_endpoint on team_workspace_config for ANY team id it is handed —
-- which makes it callable through PostgREST by an unauthenticated client.
--
-- Nothing calls it. FC stopped provisioning LiteLLM when the gateway became
-- configured rather than minted (PUT /v1/teams/:id/llm-config); no client,
-- daemon or service references the function name. The litellm_team_id COLUMN
-- stays: it is still served to older clients.

drop function if exists amux.update_team_litellm(uuid, text, text);
