import { describe, expect, it } from 'vitest'
import { pillSuffixForAgentPill, pillSuffixForUiState } from '../EngagedAgentOfflineBanner'
import type { SessionAgentUiState } from '@/lib/session/session-agent-ui-state'

// Returns the key so a missing case is visible as `null` rather than as a
// plausible-looking English string.
const t = (key: string) => key

describe('pillSuffixForUiState', () => {
  // The switch has a `default:` returning null, so a state added to the union
  // without a case here still type-checks — it just renders a pill with no
  // label. That is how `catalog-error` shipped mute the first time.
  it('labels every state that is meant to be labelled', () => {
    const labelled: SessionAgentUiState[] = [
      'offline',
      'stale',
      'connecting',
      'unconfigured',
      'catalog-error',
      'runtime-error',
    ]
    for (const state of labelled) {
      expect(pillSuffixForUiState(state, t), `no label for ${state}`).not.toBeNull()
    }
  })

  it('says the model list is unavailable, not that none is configured', () => {
    // Two different situations, two different errands for the user: one is
    // "go configure a provider", the other is "something is broken".
    expect(pillSuffixForUiState('catalog-error', t)).toBe('chat.sessionAgent.pillCatalogError')
    expect(pillSuffixForUiState('unconfigured', t)).toBe('chat.sessionAgent.pillUnconfigured')
  })

  it('leaves a ready agent unlabelled', () => {
    expect(pillSuffixForUiState('ready', t)).toBeNull()
  })
})

describe('pillSuffixForAgentPill', () => {
  const t = (key: string) => key

  it('shows a sync-degraded suffix on an otherwise ready local pill', () => {
    expect(pillSuffixForAgentPill('ready', 'degraded', t)).toBe(
      'chat.sessionAgent.pillSyncDegraded',
    )
  })

  it('prefers hard failure labels over sync-degraded', () => {
    expect(pillSuffixForAgentPill('runtime-error', 'degraded', t)).toBe(
      'chat.sessionAgent.pillRuntimeError',
    )
  })

  it('leaves a healthy ready pill unlabelled', () => {
    expect(pillSuffixForAgentPill('ready', null, t)).toBeNull()
  })
})
