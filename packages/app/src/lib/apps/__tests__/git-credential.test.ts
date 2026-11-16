import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const apps = vi.hoisted(() => ({ mintGitToken: vi.fn(), revokeGitTokens: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/backend', () => ({ getBackend: () => ({ apps }) }))
vi.mock('@/lib/config/server-config', () => ({
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: 'https://api.example.com' }),
}))
vi.mock('@/lib/utils', () => ({ isTauri: () => true }))

import {
  GIT_TOKEN_RENEW_BEFORE_MS,
  gitTokenIsFresh,
  revokeGitCredential,
  syncGitCredential,
} from '../git-credential'

const NOW = Date.parse('2026-11-17T08:00:00Z')
const session = { accessToken: 'session', user: { id: 'user-1' } }
const grant = {
  token: 'git-token',
  expiresAt: '2026-12-17T08:00:00Z',
  ttlSeconds: 2592000,
  userId: 'user-1',
  userName: 'uuser1',
  gitHost: 'gitea.example.com',
}

describe('gitTokenIsFresh', () => {
  it('keeps a token for the same account with more than a week left', () => {
    const ok = { present: true, userId: 'user-1', gitHost: null, expiresAt: new Date(NOW + GIT_TOKEN_RENEW_BEFORE_MS + 60_000).toISOString() }
    expect(gitTokenIsFresh(ok, 'user-1', NOW)).toBe(true)
  })
  it('renews one that is about to expire, belongs to someone else, or is missing', () => {
    const soon = { present: true, userId: 'user-1', gitHost: null, expiresAt: new Date(NOW + 60_000).toISOString() }
    expect(gitTokenIsFresh(soon, 'user-1', NOW)).toBe(false)
    expect(gitTokenIsFresh({ ...soon, expiresAt: '2027-01-01T00:00:00Z', userId: 'user-2' }, 'user-1', NOW)).toBe(false)
    expect(gitTokenIsFresh({ present: false, userId: null, expiresAt: null, gitHost: null }, 'user-1', NOW)).toBe(false)
    expect(gitTokenIsFresh(null, 'user-1', NOW)).toBe(false)
  })
})

describe('syncGitCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apps.mintGitToken.mockResolvedValue(grant)
  })

  it('mints and stores a token when there is none, with the API base for the helper', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'git_credential_status' ? { present: false, userId: null, expiresAt: null, gitHost: null } : undefined,
    )
    await syncGitCredential(session)
    expect(apps.mintGitToken).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('git_credential_write', {
      credential: {
        gitHost: 'gitea.example.com',
        apiBase: 'https://api.example.com',
        userId: 'user-1',
        userName: 'uuser1',
        token: 'git-token',
        expiresAt: '2026-12-17T08:00:00Z',
      },
    })
  })

  it('leaves a fresh token alone', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'git_credential_status'
        ? { present: true, userId: 'user-1', gitHost: 'g', expiresAt: '2099-01-01T00:00:00Z' }
        : undefined,
    )
    await syncGitCredential(session)
    expect(apps.mintGitToken).not.toHaveBeenCalled()
  })

  it('shares one round trip between concurrent calls', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'git_credential_status' ? { present: false, userId: null, expiresAt: null, gitHost: null } : undefined,
    )
    await Promise.all([syncGitCredential(session), syncGitCredential(session), syncGitCredential(session)])
    expect(apps.mintGitToken).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a support session, or without a signed-in user', async () => {
    await syncGitCredential(session, { isSupportSession: true })
    await syncGitCredential(null)
    await syncGitCredential({ accessToken: 'x', user: null })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('swallows a deployment without per-account git (503)', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'git_credential_status' ? { present: false, userId: null, expiresAt: null, gitHost: null } : undefined,
    )
    apps.mintGitToken.mockRejectedValue(Object.assign(new Error('git_token_unavailable'), { status: 503 }))
    await expect(syncGitCredential(session)).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalledWith('git_credential_write', expect.anything())
  })
})

describe('revokeGitCredential', () => {
  beforeEach(() => vi.clearAllMocks())

  it('revokes server-side, then removes the file', async () => {
    const order: string[] = []
    apps.revokeGitTokens.mockImplementation(async () => { order.push('revoke') })
    invoke.mockImplementation(async (cmd: string) => { order.push(cmd) })
    await revokeGitCredential()
    expect(order).toEqual(['revoke', 'git_credential_clear'])
  })

  it('removes the file even when the revoke fails', async () => {
    apps.revokeGitTokens.mockRejectedValue(new Error('offline'))
    await revokeGitCredential()
    expect(invoke).toHaveBeenCalledWith('git_credential_clear')
  })
})
