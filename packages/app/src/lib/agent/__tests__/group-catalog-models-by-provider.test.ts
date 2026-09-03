import { describe, expect, it } from 'vitest'
import {
  catalogModelsForProvider,
  groupCatalogModelsByProvider,
} from '@/lib/agent/group-catalog-models-by-provider'

describe('groupCatalogModelsByProvider', () => {
  it('groups by provider prefix and keeps full refs + display names', () => {
    const groups = groupCatalogModelsByProvider([
      { id: 'opencode/qwen3.6-plus-free', displayName: 'OpenCode Zen/Qwen3.6 Plus Free' },
      { id: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4' },
      { id: 'opencode/gpt-5-nano', displayName: 'OpenCode Zen/GPT-5 Nano' },
    ])
    expect(groups).toEqual([
      {
        providerId: 'opencode',
        models: [
          { id: 'opencode/qwen3.6-plus-free', name: 'OpenCode Zen/Qwen3.6 Plus Free' },
          { id: 'opencode/gpt-5-nano', name: 'OpenCode Zen/GPT-5 Nano' },
        ],
      },
      {
        providerId: 'anthropic',
        models: [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }],
      },
    ])
  })

  it('dedupes by full id and falls back name to id', () => {
    const groups = groupCatalogModelsByProvider([
      { id: 'opencode/a', displayName: 'A' },
      { id: 'opencode/a', displayName: 'A duplicate' },
      { id: 'opencode/b', displayName: '  ' },
      { id: '', displayName: 'skip' },
      { id: 'nopath', displayName: 'No slash' },
    ])
    expect(groups).toEqual([
      {
        providerId: 'opencode',
        models: [
          { id: 'opencode/a', name: 'A' },
          { id: 'opencode/b', name: 'opencode/b' },
        ],
      },
      {
        providerId: 'nopath',
        models: [{ id: 'nopath', name: 'No slash' }],
      },
    ])
  })

  it('catalogModelsForProvider returns only that provider', () => {
    const models = catalogModelsForProvider(
      [
        { id: 'opencode/a', displayName: 'A' },
        { id: 'openai/b', displayName: 'B' },
      ],
      'opencode',
    )
    expect(models).toEqual([{ id: 'opencode/a', name: 'A' }])
  })
})
