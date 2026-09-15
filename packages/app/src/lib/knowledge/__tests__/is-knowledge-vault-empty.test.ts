import { describe, it, expect, vi, beforeEach } from 'vitest'

const { existsMock, readDirMock } = vi.hoisted(() => ({
  existsMock: vi.fn(),
  readDirMock: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (...args: unknown[]) => existsMock(...args),
  readDir: (...args: unknown[]) => readDirMock(...args),
}))

import { isKnowledgeVaultEmpty } from '../is-knowledge-vault-empty'

describe('isKnowledgeVaultEmpty', () => {
  beforeEach(() => {
    existsMock.mockReset()
    readDirMock.mockReset()
  })

  it('is empty when the vault directory is missing', async () => {
    existsMock.mockResolvedValue(false)
    expect(await isKnowledgeVaultEmpty('/sync')).toBe(true)
  })

  it('is empty when only empty scaffold dirs exist', async () => {
    existsMock.mockResolvedValue(true)
    readDirMock.mockImplementation(async (dir: string) => {
      if (dir.endsWith('/knowledge')) {
        return [
          { name: '10-onboarding', isDirectory: true, isFile: false },
          { name: '20-domains', isDirectory: true, isFile: false },
          { name: '.DS_Store', isDirectory: false, isFile: true },
        ]
      }
      return []
    })
    expect(await isKnowledgeVaultEmpty('/sync')).toBe(true)
  })

  it('is not empty when a note file exists', async () => {
    existsMock.mockResolvedValue(true)
    readDirMock.mockImplementation(async (dir: string) => {
      if (dir.endsWith('/knowledge')) {
        return [{ name: '00-home.md', isDirectory: false, isFile: true }]
      }
      return []
    })
    expect(await isKnowledgeVaultEmpty('/sync')).toBe(false)
  })

  it('finds a file nested under a domain folder', async () => {
    existsMock.mockResolvedValue(true)
    readDirMock.mockImplementation(async (dir: string) => {
      if (dir.endsWith('/knowledge')) {
        return [{ name: '20-domains', isDirectory: true, isFile: false }]
      }
      if (dir.endsWith('/20-domains')) {
        return [{ name: 'payments', isDirectory: true, isFile: false }]
      }
      if (dir.endsWith('/payments')) {
        return [{ name: '_index.md', isDirectory: false, isFile: true }]
      }
      return []
    })
    expect(await isKnowledgeVaultEmpty('/sync')).toBe(false)
  })
})
