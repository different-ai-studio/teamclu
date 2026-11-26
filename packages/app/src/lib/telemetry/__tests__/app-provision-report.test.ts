import { beforeEach, describe, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({ captureTelemetry: vi.fn() }))

vi.mock('@/lib/telemetry/capture', async (orig) => ({
  ...(await orig<typeof import('@/lib/telemetry/capture')>()),
  captureTelemetry: capture.captureTelemetry,
}))

import { __resetTelemetryThrottleForTest } from '@/lib/telemetry/capture'
import {
  classifyAppProvisionFailure,
  reportAppProvisionFailure,
} from '@/lib/telemetry/app-provision-report'

describe('classifyAppProvisionFailure', () => {
  it.each([
    ['git: program not found', 'git_missing'],
    ['failed to spawn git: No such file or directory (os error 2)', 'git_missing'],
    ["'git' 不是内部或外部命令，也不是可运行的程序", 'git_missing'],
    ['git@git.service.ucar.cc: Permission denied (publickey).', 'ssh_auth'],
    ['ssh: connect to host git.example port 2222: Connection timed out', 'network'],
    ['无法获取 Gitea 部署密钥', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
  ])('%s → %s', (reason, kind) => {
    expect(classifyAppProvisionFailure(reason)).toBe(kind)
  })
})

describe('reportAppProvisionFailure', () => {
  beforeEach(() => {
    capture.captureTelemetry.mockClear()
    __resetTelemetryThrottleForTest()
  })

  it('captures one grouped error event with the reason in extra', () => {
    reportAppProvisionFailure('seed', 'git: program not found', { appId: 'a1', teamId: 't1', appType: 'static_web' })
    expect(capture.captureTelemetry).toHaveBeenCalledTimes(1)
    const event = capture.captureTelemetry.mock.calls[0][0]
    expect(event.message).toBe('app_provision_failed: seed (git_missing)')
    expect(event.level).toBe('error')
    expect(event.fingerprint).toEqual(['app_provision', 'seed', 'git_missing'])
    expect(event.extra).toMatchObject({ reason: 'git: program not found', appId: 'a1', teamId: 't1' })
  })

  it('throttles repeats for the same app and stage', () => {
    reportAppProvisionFailure('seed', 'x', { appId: 'a1' })
    reportAppProvisionFailure('seed', 'x', { appId: 'a1' })
    reportAppProvisionFailure('deploy_key', 'x', { appId: 'a1' })
    expect(capture.captureTelemetry).toHaveBeenCalledTimes(2)
  })
})
