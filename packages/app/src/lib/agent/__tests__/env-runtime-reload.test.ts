import { describe, expect, it } from 'vitest'
import { describeEnvReloadOutcome } from '@/lib/agent/env-runtime-reload'

describe('describeEnvReloadOutcome', () => {
  it('describes restart_required', () => {
    expect(describeEnvReloadOutcome('restart_required')).toMatch(/新开 session/)
  })

  it('describes reload_required', () => {
    expect(describeEnvReloadOutcome('reload_required')).toMatch(/下次 spawn/)
  })

  it('describes applied_live', () => {
    expect(describeEnvReloadOutcome('applied_live')).toMatch(/已应用/)
  })
})
