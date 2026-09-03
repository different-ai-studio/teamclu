import { describe, expect, it } from 'vitest'

import {
  defaultFormState,
  formStateToPayload,
  getRegistryEntry,
  jobToFormState,
} from '@/lib/cron/cron-utils'
import type { CronJob } from '@/stores/cron'

describe('cron-utils timeout compatibility', () => {
  it('does not write timeoutSeconds into new or edited job payloads', () => {
    const payload = formStateToPayload({
      ...defaultFormState,
      message: 'run the report',
    })

    expect(payload).toEqual({ message: 'run the report', permissionMode: 'full_access' })
    expect('timeoutSeconds' in payload).toBe(false)
  })

  it('loads legacy jobs with timeoutSeconds without exposing timeout form state', () => {
    const now = new Date().toISOString()
    const job: CronJob = {
      id: 'job-1',
      name: 'Legacy job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 30 * 60 * 1000 },
      payload: {
        message: 'legacy',
        timeoutSeconds: 30,
      },
      deleteAfterRun: false,
      createdAt: now,
      updatedAt: now,
    }

    const form = jobToFormState(job)

    expect(form.message).toBe('legacy')
    expect('timeoutSeconds' in form).toBe(false)
  })
})

describe('cron-utils permission mode', () => {
  const legacyJob = (payload: CronJob['payload']): CronJob => {
    const now = new Date().toISOString()
    return {
      id: 'job-1',
      name: 'Job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 30 * 60 * 1000 },
      payload,
      deleteAfterRun: false,
      createdAt: now,
      updatedAt: now,
    }
  }

  it('defaults new jobs to full access', () => {
    expect(defaultFormState.permissionMode).toBe('full_access')
    expect(formStateToPayload(defaultFormState).permissionMode).toBe('full_access')
  })

  it('reads a job saved without the field as full access', () => {
    // Those jobs already ran with approvals auto-granted, so this is a faithful
    // reading of past behavior rather than a silent change to it.
    const form = jobToFormState(legacyJob({ message: 'legacy' }))
    expect(form.permissionMode).toBe('full_access')
  })

  it('round-trips an explicit opt-out back into the payload', () => {
    const form = jobToFormState(legacyJob({ message: 'ask me', permissionMode: 'default' }))
    expect(form.permissionMode).toBe('default')
    expect(formStateToPayload(form).permissionMode).toBe('default')
  })
})

describe('cron-utils seatalk delivery registry', () => {
  it('builds and parses SeaTalk group/DM targets', () => {
    const entry = getRegistryEntry('seatalk')
    expect(entry?.name).toBe('SeaTalk')
    expect(entry?.buildTarget('group', { groupId: 'g1' })).toBe('group:g1')
    expect(entry?.buildTarget('single', { employeeCode: 'E1' })).toBe('single:E1')
    expect(entry?.parseTarget('group:g1')).toEqual({
      mode: 'group',
      values: { groupId: 'g1' },
    })
    expect(entry?.parseTarget('single:E1')).toEqual({
      mode: 'single',
      values: { employeeCode: 'E1' },
    })
  })
})
