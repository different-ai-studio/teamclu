import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
const isTauriMock = vi.fn(() => true)

vi.mock('@/lib/utils', () => ({
  isTauri: () => isTauriMock(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

describe('getObsidianStatus', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    isTauriMock.mockReset()
    isTauriMock.mockReturnValue(true)
  })

  it('passes the vault path through to the backend', async () => {
    invokeMock.mockResolvedValue({ installed: true, vaultRegistered: true })
    const { getObsidianStatus } = await import('@/lib/knowledge/obsidian')

    const status = await getObsidianStatus('/tmp/team/knowledge')

    expect(invokeMock).toHaveBeenCalledWith('obsidian_status', {
      vaultPath: '/tmp/team/knowledge',
    })
    expect(status).toEqual({ installed: true, vaultRegistered: true })
  })

  it('sends an empty string when there is no knowledge dir yet', async () => {
    invokeMock.mockResolvedValue({ installed: true, vaultRegistered: false })
    const { getObsidianStatus } = await import('@/lib/knowledge/obsidian')

    await getObsidianStatus(null)

    expect(invokeMock).toHaveBeenCalledWith('obsidian_status', { vaultPath: '' })
  })

  // The probe runs on every focus, in the header of a column that has nothing
  // to do with Obsidian. A throwing probe must grey the button out, not take
  // the header down with it.
  it('reports "not installed" when the probe throws', async () => {
    invokeMock.mockRejectedValue(new Error('command not found'))
    const { getObsidianStatus } = await import('@/lib/knowledge/obsidian')

    await expect(getObsidianStatus('/tmp/team/knowledge')).resolves.toEqual({
      installed: false,
      vaultRegistered: false,
    })
  })

  it('reports "not installed" outside the desktop app', async () => {
    isTauriMock.mockReturnValue(false)
    const { getObsidianStatus } = await import('@/lib/knowledge/obsidian')

    await expect(getObsidianStatus('/tmp/team/knowledge')).resolves.toEqual({
      installed: false,
      vaultRegistered: false,
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('openVaultInObsidian', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    isTauriMock.mockReset()
    isTauriMock.mockReturnValue(true)
  })

  // Unlike the probe, a failed open has to surface: the user clicked, and
  // swallowing the error is how a button becomes "it does nothing".
  it('propagates the backend error', async () => {
    invokeMock.mockRejectedValue(new Error('obsidian: not installed'))
    const { openVaultInObsidian } = await import('@/lib/knowledge/obsidian')

    await expect(openVaultInObsidian('/tmp/team/knowledge')).rejects.toThrow(
      'obsidian: not installed',
    )
  })

  it('invokes the backend with the vault path', async () => {
    invokeMock.mockResolvedValue('opened')
    const { openVaultInObsidian } = await import('@/lib/knowledge/obsidian')

    await openVaultInObsidian('/tmp/team/knowledge')

    expect(invokeMock).toHaveBeenCalledWith('obsidian_open_vault', {
      vaultPath: '/tmp/team/knowledge',
    })
  })

  // The caller branches on this to decide whether to tell the user to restart
  // Obsidian, so it has to come back untouched.
  it('returns the outcome the backend reports', async () => {
    invokeMock.mockResolvedValue('registeredNeedsRestart')
    const { openVaultInObsidian } = await import('@/lib/knowledge/obsidian')

    await expect(openVaultInObsidian('/tmp/team/knowledge')).resolves.toBe(
      'registeredNeedsRestart',
    )
  })
})
