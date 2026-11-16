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
  resetGitCredentialState,
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
    resetGitCredentialState()
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
        gitScheme: 'https',
        apiBase: 'https://api.example.com',
        userId: 'user-1',
        userName: 'uuser1',
        token: 'git-token',
        expiresAt: '2026-12-17T08:00:00Z',
      },
    })
  })

  it('passes an http deployment\'s scheme on, so the helper matches http URLs', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'git_credential_status' ? { present: false, userId: null, expiresAt: null, gitHost: null } : undefined,
    )
    apps.mintGitToken.mockResolvedValue({ ...grant, gitScheme: 'http' })
    await syncGitCredential(session)
    expect(invoke).toHaveBeenCalledWith('git_credential_write', {
      credential: expect.objectContaining({ gitHost: 'gitea.example.com', gitScheme: 'http' }),
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

  const freshStatus = { present: true, userId: 'user-1', gitHost: 'g', expiresAt: '2099-01-01T00:00:00Z' }

  it('replaces a fresh-looking token the server rejects (signed out on another machine)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_credential_status') return freshStatus
      if (cmd === 'git_credential_verify') return 'rejected'
      return undefined
    })
    await syncGitCredential(session)
    expect(apps.mintGitToken).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('git_credential_write', expect.anything())
  })

  it('keeps the token when the server cannot be asked, and asks again next time', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_credential_status') return freshStatus
      if (cmd === 'git_credential_verify') return 'unknown'
      return undefined
    })
    await syncGitCredential(session)
    await syncGitCredential(session)
    expect(apps.mintGitToken).not.toHaveBeenCalled()
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'git_credential_verify')).toHaveLength(2)
  })

  it('does not ask the server again right after it confirmed the token', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_credential_status') return freshStatus
      if (cmd === 'git_credential_verify') return 'valid'
      return undefined
    })
    await syncGitCredential(session)
    await syncGitCredential(session)
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'git_credential_verify')).toHaveLength(1)
    expect(apps.mintGitToken).not.toHaveBeenCalled()
  })

  it('a sync caught mid-mint by sign-out writes nothing, and the revoke runs after its mint', async () => {
    const order: string[] = []
    let releaseMint: (v: typeof grant) => void = () => {}
    apps.mintGitToken.mockImplementation(
      () => new Promise((resolve) => { releaseMint = (v) => { order.push('minted'); resolve(v) } }),
    )
    apps.revokeGitTokens.mockImplementation(async () => { order.push('revoke') })
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_credential_status') return { present: false, userId: null, expiresAt: null, gitHost: null }
      order.push(cmd)
      return undefined
    })
    const syncing = syncGitCredential(session)
    await vi.waitFor(() => expect(apps.mintGitToken).toHaveBeenCalled())
    const signingOut = revokeGitCredential()
    releaseMint(grant)
    await Promise.all([syncing, signingOut])
    expect(order).toEqual(['minted', 'revoke', 'git_credential_clear'])
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
  beforeEach(() => {
    vi.clearAllMocks()
    resetGitCredentialState()
  })

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
