import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TEAMCLU_DIR } from '@/lib/config/build-config'
import {
  isNearlyEmptyWorkspace,
  renderWorkspaceInstructionTemplate,
  seedDefaultWorkspaceInstructions,
} from '@/lib/workspace-seed/seed-default-instructions'

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
  readDir: vi.fn(),
  writeTextFile: vi.fn(),
}))

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
}))

import { exists, readDir, writeTextFile } from '@tauri-apps/plugin-fs'

describe('isNearlyEmptyWorkspace', () => {
  it('treats an empty listing as nearly empty', () => {
    expect(isNearlyEmptyWorkspace([])).toBe(true)
  })

  it('ignores scaffolding noise entries', () => {
    expect(
      isNearlyEmptyWorkspace(['.git', '.gitignore', '.DS_Store', TEAMCLU_DIR]),
    ).toBe(true)
  })

  it('rejects directories that already have project files', () => {
    expect(isNearlyEmptyWorkspace(['.git', 'README.md'])).toBe(false)
    expect(isNearlyEmptyWorkspace(['src'])).toBe(false)
  })
})

describe('renderWorkspaceInstructionTemplate', () => {
  it('fills workspace name and omits the team block when teamName is missing', () => {
    const rendered = renderWorkspaceInstructionTemplate(
      '# {{workspaceName}}\n{{#teamName}}Team: {{teamName}}\n{{/teamName}}Hello',
      { workspaceName: 'demo-ws', teamName: null },
    )
    expect(rendered).toContain('# demo-ws')
    expect(rendered).not.toContain('Team:')
    expect(rendered).toContain('Hello')
  })

  it('includes the team block when teamName is present', () => {
    const rendered = renderWorkspaceInstructionTemplate(
      '{{#teamName}}Team: {{teamName}}\n{{/teamName}}',
      { workspaceName: 'demo-ws', teamName: 'Acme' },
    )
    expect(rendered).toBe('Team: Acme\n')
  })
})

describe('seedDefaultWorkspaceInstructions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes AGENTS.md and CLAUDE.md for a nearly empty workspace', async () => {
    vi.mocked(readDir).mockResolvedValue([])
    vi.mocked(exists).mockResolvedValue(false)

    await seedDefaultWorkspaceInstructions('/workspace/demo-ws', { teamName: 'Acme' })

    const written = Object.fromEntries(
      vi.mocked(writeTextFile).mock.calls.map(([path, content]) => [path, content]),
    )
    expect(written['/workspace/demo-ws/AGENTS.md']).toContain('work assistant')
    expect(written['/workspace/demo-ws/AGENTS.md']).toContain('Acme')
    expect(written['/workspace/demo-ws/AGENTS.md']).toContain('demo-ws')
    expect(written['/workspace/demo-ws/CLAUDE.md']).toContain('demo-ws')
    expect(written['/workspace/demo-ws/CLAUDE.md']).toContain('Acme')
  })

  it('does not write anything when the workspace already has project files', async () => {
    vi.mocked(readDir).mockResolvedValue([{ name: 'README.md', isDirectory: false, isFile: true }])

    await seedDefaultWorkspaceInstructions('/workspace/demo-ws', { teamName: 'Acme' })

    expect(writeTextFile).not.toHaveBeenCalled()
    expect(exists).not.toHaveBeenCalled()
  })

  it('never overwrites an existing instruction file', async () => {
    vi.mocked(readDir).mockResolvedValue([])
    vi.mocked(exists).mockImplementation(async (path: string) => path.endsWith('AGENTS.md'))

    await seedDefaultWorkspaceInstructions('/workspace/demo-ws', { teamName: null })

    expect(writeTextFile).toHaveBeenCalledTimes(1)
    expect(writeTextFile).toHaveBeenCalledWith(
      '/workspace/demo-ws/CLAUDE.md',
      expect.any(String),
    )
  })

  it('omits team personalization when teamName is absent', async () => {
    vi.mocked(readDir).mockResolvedValue([])
    vi.mocked(exists).mockResolvedValue(false)

    await seedDefaultWorkspaceInstructions('/workspace/demo-ws', { teamName: null })

    const agents = vi.mocked(writeTextFile).mock.calls.find(([path]) =>
      String(path).endsWith('AGENTS.md'),
    )?.[1]
    expect(agents).toContain('demo-ws')
    expect(agents).not.toMatch(/Team:/)
  })
})
