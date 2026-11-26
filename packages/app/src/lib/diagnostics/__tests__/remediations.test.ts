import { describe, expect, it } from 'vitest'
import { causeCodesFromFindings, remediationsForFinding } from '../remediations'

describe('remediationsForFinding', () => {
  it('returns no actions for a healthy finding', () => {
    expect(
      remediationsForFinding({ code: 'model.catalog_ok', status: 'ok' }).map((a) => a.id),
    ).toEqual([])
  })

  it('maps auth and mqtt failures to login / reconnect', () => {
    expect(
      remediationsForFinding({ code: 'auth.session_invalid', status: 'fail' }).map((a) => a.id),
    ).toEqual(['relogin'])
    expect(
      remediationsForFinding({ code: 'realtime.mqtt_auth_failed', status: 'fail' }).map((a) => a.id),
    ).toEqual(['relogin'])
    expect(
      remediationsForFinding({
        code: 'realtime.mqtt_network_failed',
        status: 'fail',
      }).map((a) => a.id),
    ).toEqual(['reconnect_mqtt'])
  })

  it('maps provider and model problems onto LLM settings', () => {
    expect(
      remediationsForFinding({
        code: 'model.backend_probe_failed',
        status: 'fail',
      }).map((a) => a.id),
    ).toEqual(['open_llm'])
    expect(
      remediationsForFinding({ code: 'agent.turn_timeout', status: 'fail' }).map((a) => a.id),
    ).toEqual(['reselect_model'])
  })

  it('offers nothing for a failure with no known fix', () => {
    // Export used to be appended to every non-ok finding; it now lives only in
    // the page-level export card.
    expect(
      remediationsForFinding({ code: 'sync.team_link_broken', status: 'fail' }),
    ).toEqual([])
  })

  it('maps unreachable daemon to reset', () => {
    expect(
      remediationsForFinding({
        code: 'model.daemon_unreachable',
        status: 'fail',
      }).map((a) => a.id),
    ).toEqual(['reset_daemon'])
  })
})

describe('causeCodesFromFindings', () => {
  it('skips ok findings and keeps first-seen order', () => {
    expect(
      causeCodesFromFindings([
        { code: 'model.catalog_ok', status: 'ok' },
        { code: 'model.backend_probe_failed', status: 'fail' },
        { code: 'send.mqtt_publish_failed', status: 'warn' },
        { code: 'model.backend_probe_failed', status: 'fail' },
      ]),
    ).toEqual(['model.backend_probe_failed', 'send.mqtt_publish_failed'])
  })
})
