import { describe, expect, it } from 'vitest'
import {
  collectDaemonResetRemediation,
  type DiagnosticCheck,
} from '@/lib/diagnostics/diagnostic-report'

describe('collectDaemonResetRemediation', () => {
  it('suggests reset when daemon HTTP token is invalid', () => {
    const checks: DiagnosticCheck[] = [
      {
        id: 'daemon_http',
        title: '本地 Daemon',
        status: 'fail',
        message: 'daemon 令牌无效，需重启应用',
        resetTrigger: 'daemon_http_token_invalid',
      },
    ]

    const result = collectDaemonResetRemediation(checks)

    expect(result.suggest).toBe(true)
    expect(result.triggers).toHaveLength(1)
    expect(result.triggers[0]?.resetTrigger).toBe('daemon_http_token_invalid')
  })

  it('does not suggest reset when daemon is merely not running', () => {
    const checks: DiagnosticCheck[] = [
      {
        id: 'daemon_http',
        title: '本地 Daemon',
        status: 'fail',
        message: 'amuxd 未运行或无法访问',
      },
    ]

    const result = collectDaemonResetRemediation(checks)

    expect(result.suggest).toBe(false)
    expect(result.triggers).toHaveLength(0)
  })

  it('suggests reset when daemon port file is missing', () => {
    const checks: DiagnosticCheck[] = [
      {
        id: 'daemon_http',
        title: '本地 Daemon',
        status: 'fail',
        message: '未找到 daemon 配置（可能尚未初始化）',
        resetTrigger: 'daemon_http_port_missing',
      },
    ]

    const result = collectDaemonResetRemediation(checks)

    expect(result.suggest).toBe(true)
    expect(result.triggers[0]?.resetTrigger).toBe('daemon_http_port_missing')
  })

  it('suggests reset for unreadable daemon info when probe succeeded', () => {
    const checks: DiagnosticCheck[] = [
      {
        id: 'daemon_info',
        title: 'Daemon 云同步',
        status: 'warn',
        message: '无法读取 daemon 详情',
        resetTrigger: 'daemon_info_unreadable',
      },
    ]

    expect(collectDaemonResetRemediation(checks).suggest).toBe(true)
  })

  it('only suggests reset for expired cloud auth after auto-heal failed', () => {
    const checks: DiagnosticCheck[] = [
      {
        id: 'daemon_info',
        title: 'Daemon 云同步',
        status: 'fail',
        message: 'daemon 云认证已过期，需重新 onboarding',
        resetTrigger: 'daemon_cloud_auth_expired',
      },
    ]

    expect(collectDaemonResetRemediation(checks).suggest).toBe(false)
    expect(
      collectDaemonResetRemediation(checks, { cloudAuthHealFailed: true }).suggest,
    ).toBe(true)
  })

  it('suggests reset when onboarding reports team mismatch', () => {
    const result = collectDaemonResetRemediation([], { teamMismatch: true })

    expect(result.suggest).toBe(true)
    expect(result.triggers[0]?.resetTrigger).toBe('daemon_team_mismatch')
  })
})
