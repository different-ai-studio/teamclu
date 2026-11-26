import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TEAMCLU_DIR } from '@/lib/config/build-config'
import {
  ensureGitignoreEntries,
  parseGitignore,
} from '@/lib/workspace/gitignore-manager'

// Mock Tauri FS API
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
}))

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
}))

import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs'

describe('gitignore-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('parseGitignore', () => {
    it('should parse gitignore content into lines', () => {
      const content = `# Comment\n${TEAMCLU_DIR}/\nnode_modules/\n`
      const result = parseGitignore(content)
      expect(result).toEqual(['# Comment', `${TEAMCLU_DIR}/`, 'node_modules/'])
    })

    it('should handle empty content', () => {
      const result = parseGitignore('')
      expect(result).toEqual([])
    })
  })

  describe('ensureGitignoreEntries', () => {
    it('should create .gitignore if it does not exist', async () => {
      vi.mocked(exists).mockResolvedValue(false)
      
      await ensureGitignoreEntries('/workspace')
      
      expect(writeTextFile).toHaveBeenCalledWith(
        '/workspace/.gitignore',
        expect.stringContaining(`${TEAMCLU_DIR}/`)
      )
    })

    it('should append missing entries to existing .gitignore', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readTextFile).mockResolvedValue('# Existing\nnode_modules/\n')

      await ensureGitignoreEntries('/workspace')

      const writtenContent = vi.mocked(writeTextFile).mock.calls[0][1]
      expect(writtenContent).toContain('# Existing')
      expect(writtenContent).toContain('node_modules/')
      expect(writtenContent).toContain(`${TEAMCLU_DIR}/`)
      expect(writtenContent.indexOf('# Existing')).toBeLessThan(writtenContent.indexOf(`${TEAMCLU_DIR}/`))
    })

    it('should not duplicate entries with different formatting', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      // No trailing slash on the meta dir.
      vi.mocked(readTextFile).mockResolvedValue(`${TEAMCLU_DIR}\n`)

      await ensureGitignoreEntries('/workspace')

      expect(writeTextFile).not.toHaveBeenCalled()
    })

    // The daemon no longer writes a workspace `opencode.json`, so there is
    // nothing of ours to keep out of the user's history.
    it('does not add opencode.json', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readTextFile).mockResolvedValue('node_modules/\n')

      await ensureGitignoreEntries('/workspace')

      const writtenContent = vi.mocked(writeTextFile).mock.calls[0][1]
      expect(writtenContent).not.toContain('opencode.json')
    })

    it('should add comment header when appending entries', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readTextFile).mockResolvedValue('node_modules/\n')

      await ensureGitignoreEntries('/workspace')

      expect(writeTextFile).toHaveBeenCalledWith(
        '/workspace/.gitignore',
        expect.stringContaining('system directories')
      )
    })

    it('should not duplicate existing entries', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readTextFile).mockResolvedValue(`${TEAMCLU_DIR}/\n`)

      await ensureGitignoreEntries('/workspace')

      expect(writeTextFile).not.toHaveBeenCalled()
    })
  })
})
