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

/**
 * The three capability tiers the team gateway exposes, pinned client-side.
 *
 * Mirrors `teamclu-runtime-env::team_provider::TEAM_MODEL_TIERS` and exists for
 * the same reason: these ids are the whole public contract, while *which*
 * upstream each one resolves to lives in the gateway's catalog — so the
 * backend, the price and the vendor can all move without shipping a client.
 * Adding a fourth tier does need a release, which is the intended trade: a new
 * tier is a product decision, not a config tweak.
 *
 * Deliberately NOT sourced from the cloud team config: that made every member's
 * model menu depend on a round-trip that could come back stale or empty, for a
 * list that has not changed in the product's lifetime.
 */
export const TEAM_MODEL_TIERS: ReadonlyArray<{ id: string; labelKey: string; label: string }> = [
  { id: 'default', labelKey: 'settings.llm.teamTier.default', label: '标准' },
  { id: 'pro', labelKey: 'settings.llm.teamTier.pro', label: '高级' },
  { id: 'max', labelKey: 'settings.llm.teamTier.max', label: '旗舰' },
]
