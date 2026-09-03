import { describe, expect, it } from 'vitest'
import {
  formatRuntimeRefreshChangeKinds,
  runtimeRefreshNeedsBanner,
} from '@/lib/agent/workspace-runtime-refresh-labels'

describe('workspace-runtime-refresh-labels', () => {
  it('formats known change kinds', () => {
    expect(formatRuntimeRefreshChangeKinds(['skills', 'mcp', 'env_vars'])).toBe(
      'skills, MCP, environment',
    )
  })

  it('detects banner-worthy statuses', () => {
    expect(runtimeRefreshNeedsBanner('pending')).toBe(true)
    expect(runtimeRefreshNeedsBanner('failed')).toBe(true)
    expect(runtimeRefreshNeedsBanner('applying')).toBe(false)
    expect(runtimeRefreshNeedsBanner('clean')).toBe(false)
    expect(runtimeRefreshNeedsBanner(null)).toBe(false)
  })
})
