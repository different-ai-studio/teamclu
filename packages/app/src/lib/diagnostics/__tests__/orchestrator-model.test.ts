import { describe, expect, it } from 'vitest'
import { diagnose } from '../orchestrator'
import { emptyCtx } from './orchestrator-helpers'

describe('diagnose model flow', () => {
  it('fails as daemon_unreachable when daemon is down and does not keep probing catalog', () => {
    const findings = diagnose(
      emptyCtx({
        daemon: { reachable: false, probeReason: 'not_running', info: null, liveConnected: false },
        catalog: { status: 'error', backend: 'opencode', message: 'should not matter' },
      }),
    )
    const model = findings.filter((f) => f.symptom === 'model')
    expect(model).toHaveLength(1)
    expect(model[0]).toMatchObject({
      code: 'model.daemon_unreachable',
      status: 'fail',
      confidence: 'high',
    })
  })

  it('treats an empty catalog as not configured, not a failure', () => {
    const findings = diagnose(
      emptyCtx({
        catalog: { status: 'empty', backend: 'opencode' },
      }),
    )
    const catalogFinding = findings.find((f) => f.code === 'model.provider_not_configured')
    expect(catalogFinding?.status).toBe('warn')
    expect(catalogFinding?.confidence).toBe('high')
    expect(findings.some((f) => f.code === 'model.backend_probe_failed')).toBe(false)
  })

  it('maps probe_error catalog outcome to backend_probe_failed', () => {
    const findings = diagnose(
      emptyCtx({
        catalog: { status: 'error', backend: 'opencode', message: 'provider auth token invalid' },
      }),
    )
    const failed = findings.find((f) => f.code === 'model.backend_probe_failed')
    expect(failed?.status).toBe('fail')
    expect(failed?.message).toContain('provider auth token invalid')
    expect(failed?.nextAction).toContain('鉴权')
  })

  it('warns catalog_unknown when daemon is up but catalog has no conclusion', () => {
    const findings = diagnose(emptyCtx({ catalog: { status: 'unknown' } }))
    expect(findings.some((f) => f.code === 'model.catalog_unknown' && f.status === 'warn')).toBe(
      true,
    )
  })
})
