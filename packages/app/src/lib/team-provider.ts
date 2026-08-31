/**
 * The team's shared ("host") LLM is CLOUD-stored per team and is the single
 * source of truth:
 * - READ:  `GET /v1/teams/:id/workspace-config` → `llm`
 * - WRITE: `PUT /v1/teams/:id/llm-config`
 *
 * There is no longer an on-disk mirror (`_meta/provider.json`): the daemon
 * materializes `opencode.json`'s `provider.team` directly from the cloud config
 * at agent-spawn time (see `teamclu-runtime-env::team_provider`), so the shared
 * LLM converges on first install without waiting for a git clone.
 *
 * The credential in `provider.team.options.apiKey` is a daemon session token
 * scoped to `ai:invoke`, minted by the daemon and written during reconcile. It
 * used to be `sk-tc-{actor_id[..40]}`, a LiteLLM virtual key derived from the
 * actor id — the daemon token replaced it precisely because a derived
 * credential is a guessable one.
 *
 * This module now only exports the shared provider id used to tag the team
 * provider across the model selector / cron dialogs.
 */
export const TEAM_SHARED_PROVIDER_ID = 'team'
