import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  daemonHomeDisplayPathFor,
  daemonManagedLogDisplayPathFor,
  daemonPortFileDisplayPathFor,
  daemonTeamsDisplayPathFor,
} from '@/lib/daemon/daemon-paths'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('daemon display paths', () => {
  it('keeps the official brand on ~/.amuxd and namespaces white-label homes', () => {
    expect(daemonHomeDisplayPathFor('teamclu')).toBe('~/.amuxd')
    expect(daemonHomeDisplayPathFor('copilot361')).toBe('~/.amuxd-copilot361')
    expect(daemonHomeDisplayPathFor('teamclaw')).toBe('~/.amuxd-teamclaw')
  })

  it('points Copilot 361 users at the branded managed log', () => {
    expect(daemonManagedLogDisplayPathFor('copilot361')).toBe(
      '~/.amuxd-copilot361/logs/amuxd.managed.log',
    )
    expect(daemonPortFileDisplayPathFor('copilot361')).toBe(
      '~/.amuxd-copilot361/run/amuxd.http.port',
    )
    expect(daemonTeamsDisplayPathFor('copilot361')).toBe('~/.amuxd-copilot361/teams/')
  })
})

describe('guardrail: no hardcoded ~/.amuxd in user-visible copy', () => {
  it('locale files parameterize the daemon home instead of hardcoding ~/.amuxd', () => {
    const localeDir = path.join(SRC_DIR, 'locales')
    const offenders: string[] = []
    for (const file of ['en.json', 'zh-CN.json']) {
      const full = path.join(localeDir, file)
      const lines = fs.readFileSync(full, 'utf8').split('\n')
      lines.forEach((line, idx) => {
        if (line.includes('~/.amuxd')) {
          offenders.push(`${file}:${idx + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('onboarding and daemon-unavailable fallbacks interpolate a branded path', () => {
    const files = [
      'App.tsx',
      'hooks/use-workspace-init.ts',
      'stores/daemon-onboarding.ts',
      'components/auth/DaemonOnboardingWizard.tsx',
      'components/settings/DaemonResetRemediationCard.tsx',
      'components/settings/DaemonManualResetCard.tsx',
    ]
    const offenders: string[] = []
    for (const rel of files) {
      const full = path.join(SRC_DIR, rel)
      const lines = fs.readFileSync(full, 'utf8').split('\n')
      lines.forEach((line, idx) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
        if (line.includes('~/.amuxd')) {
          offenders.push(`${rel}:${idx + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
