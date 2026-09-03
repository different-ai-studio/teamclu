import { describe, test, expect } from 'vitest'
import { canReseed, appStatusMeta, deployDisabledReason, showsPublicBadge } from '@/lib/apps/app-list-helpers'
import { pickMostRecentSession, firstPromptForApp } from '@/lib/apps/app-session'
import type { AppSessionRow } from '@/lib/backend/types'

function row(p: Partial<AppSessionRow>): AppSessionRow {
  return {
    id: 'id',
    teamId: 't',
    title: 'title',
    mode: 'collab',
    lastMessageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  }
}

describe('pickMostRecentSession', () => {
  test('returns null for empty list', () => {
    expect(pickMostRecentSession([])).toBeNull()
  })

  test('picks the row with the latest lastMessageAt', () => {
    const rows = [
      row({ id: 'a', lastMessageAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'b', lastMessageAt: '2026-06-10T00:00:00.000Z' }),
      row({ id: 'c', lastMessageAt: '2026-06-05T00:00:00.000Z' }),
    ]
    expect(pickMostRecentSession(rows)?.id).toBe('b')
  })

  test('falls back to createdAt when lastMessageAt is null', () => {
    const rows = [
      row({ id: 'a', lastMessageAt: null, createdAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'b', lastMessageAt: null, createdAt: '2026-06-09T00:00:00.000Z' }),
    ]
    expect(pickMostRecentSession(rows)?.id).toBe('b')
  })

  test('lastMessageAt takes precedence over createdAt within a row', () => {
    const rows = [
      row({ id: 'a', createdAt: '2026-06-20T00:00:00.000Z', lastMessageAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'b', createdAt: '2026-06-02T00:00:00.000Z', lastMessageAt: '2026-06-15T00:00:00.000Z' }),
    ]
    expect(pickMostRecentSession(rows)?.id).toBe('b')
  })

  test('handles a single row', () => {
    expect(pickMostRecentSession([row({ id: 'solo' })])?.id).toBe('solo')
  })
})

describe('canReseed', () => {
  test('allows reseed while the files are missing or the seed failed', () => {
    expect(canReseed('pending')).toBe(true)
    expect(canReseed('repo_created')).toBe(true)
    expect(canReseed('error')).toBe(true)
  })

  test('disallows reseed for ready/seeding and unknown states', () => {
    expect(canReseed('ready')).toBe(false)
    expect(canReseed('seeding')).toBe(false)
    expect(canReseed('whatever')).toBe(false)
  })
})

describe('appStatusMeta', () => {
  const app = (p: Partial<Parameters<typeof appStatusMeta>[0]>) => ({
    provisionStatus: 'ready',
    fcStatus: null,
    fcEndpoint: null,
    ...p,
  })

  test('an in-flight deploy wins over everything', () => {
    expect(appStatusMeta(app({ fcStatus: 'live', fcEndpoint: 'https://x' }), true).key)
      .toBe('apps.deploying')
  })

  test('live requires both fcStatus and an endpoint', () => {
    expect(appStatusMeta(app({ fcStatus: 'live', fcEndpoint: 'https://x' }), false).dot).toBe('live')
    expect(appStatusMeta(app({ fcStatus: 'live', fcEndpoint: null }), false).key).toBe('apps.ready')
  })

  test('a persisted failed deploy is surfaced, not hidden behind "Ready"', () => {
    const meta = appStatusMeta(app({ fcStatus: 'deploy_error' }), false)
    expect(meta.dot).toBe('failed')
    expect(meta.key).toBe('apps.deployFailed')
  })

  test('every in-progress deploy state reads as deploying', () => {
    for (const s of ['awaiting_build', 'building', 'deploying']) {
      expect(appStatusMeta(app({ fcStatus: s }), false).key).toBe('apps.deploying')
    }
  })

  test('falls back to the provision lifecycle when never deployed', () => {
    expect(appStatusMeta(app({ provisionStatus: 'ready' }), false).key).toBe('apps.ready')
    expect(appStatusMeta(app({ provisionStatus: 'error' }), false).key).toBe('apps.error')
    expect(appStatusMeta(app({ provisionStatus: 'repo_created' }), false).key).toBe('apps.provisioning')
  })
})

describe('deployDisabledReason', () => {
  test('blocks third-party auth and container runtime', () => {
    expect(deployDisabledReason({ authMode: 'third', runtime: 'node' })).toBe('apps.deployDisabledThird')
    expect(deployDisabledReason({ authMode: 'none', runtime: 'container' })).toBe('apps.deployDisabledContainer')
    expect(deployDisabledReason({ authMode: 'none', runtime: 'node' })).toBeNull()
  })
})

describe('showsPublicBadge', () => {
  test('only when live with no auth gate', () => {
    expect(showsPublicBadge({ authMode: 'none', fcStatus: 'live' })).toBe(true)
    expect(showsPublicBadge({ authMode: 'none', fcStatus: 'deploy_error' })).toBe(false)
    expect(showsPublicBadge({ authMode: 'platform', fcStatus: 'live' })).toBe(false)
  })
})

describe('firstPromptForApp', () => {
  const app = (name: string, type: string) => ({ name, type })

  test('names the app and points the agent at AGENTS.md', () => {
    const prompt = firstPromptForApp(app('copilot 官网', 'static_web'))
    expect(prompt).toContain('copilot 官网')
    expect(prompt).toContain('AGENTS.md')
  })

  test('asks for a plan before edits, per type', () => {
    expect(firstPromptForApp(app('X', 'static_web'))).toContain('public/')
    expect(firstPromptForApp(app('X', 'slides'))).toContain('提纲')
    expect(firstPromptForApp(app('X', 'data_app'))).toContain('数据表')
  })

  test('a legacy type gets the data-app prompt', () => {
    expect(firstPromptForApp(app('X', 'fullstack_tanstack_postgres'))).toContain('数据表')
    expect(firstPromptForApp(app('X', ''))).toContain('数据表')
  })

  test('trims the name the user typed', () => {
    expect(firstPromptForApp(app('  spaced  ', 'slides'))).toContain('：spaced\n')
  })
})
