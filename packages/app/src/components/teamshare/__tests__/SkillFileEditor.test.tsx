import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const t = (k: string, d?: string) => d ?? k

const { mockPut, mockNotify, mockWrite, mockLoad, mockReconcile } = vi.hoisted(() => ({
  mockPut: vi.fn(async () => ({ slug: 'say-hello' })),
  mockNotify: vi.fn(async () => {}),
  mockWrite: vi.fn(async () => {}),
  mockLoad: vi.fn(async () => {}),
  mockReconcile: vi.fn(async () => {}),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn(async () => ({ size: 12 })),
  readTextFile: vi.fn(async () => 'hello-old'),
  writeTextFile: mockWrite,
}))
vi.mock('@/lib/daemon-local-client', () => ({
  encodeWorkspaceId: (p: string) => `ws:${p}`,
  putDaemonSkill: mockPut,
  notifyDaemonSkillsChanged: mockNotify,
}))
vi.mock('@/lib/effective-workspace', () => ({
  useEffectiveWorkspacePath: () => '/Users/me/project',
}))
vi.mock('@/components/workspace/file-tree-operations', () => ({
  revealInFinder: vi.fn(),
}))
vi.mock('../use-is-dark', () => ({ useIsDark: () => false }))
vi.mock('@/components/editors/CodeEditor', () => ({
  default: ({
    content,
    onChange,
  }: {
    content: string
    onChange: (v: string) => void
  }) => (
    <textarea
      data-testid="code-editor"
      value={content}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

const item = {
  id: 'say-hello',
  slug: 'say-hello',
  name: 'say-hello',
  dirPath: '/hosted/skills',
  filename: 'say-hello',
}

vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: (sel: (s: typeof state) => unknown) => sel(state),
}))

const state = {
  skills: { items: [item] },
  select: vi.fn(),
  loadSection: mockLoad,
  reconcileSkills: mockReconcile,
}

import { SkillFileEditor } from '../SkillFileEditor'
import { toast } from 'sonner'

describe('SkillFileEditor save', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPut.mockResolvedValue({ slug: 'say-hello' })
    mockNotify.mockResolvedValue(undefined)
    mockWrite.mockResolvedValue(undefined)
  })

  it('saves SKILL.md through putDaemonSkill and does not call refresh', async () => {
    render(<SkillFileEditor slug="say-hello" rel="SKILL.md" />)
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeTruthy())
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'hello-new' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockPut).toHaveBeenCalled())
    expect(mockPut).toHaveBeenCalledWith(
      'ws:/Users/me/project',
      'say-hello',
      expect.objectContaining({ content: 'hello-new' }),
    )
    expect(mockWrite).not.toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('writes auxiliary files then notifies daemon skills refresh', async () => {
    render(<SkillFileEditor slug="say-hello" rel="scripts/hello.js" />)
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeTruthy())
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'hello-new' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockWrite).toHaveBeenCalled())
    expect(mockWrite).toHaveBeenCalledWith(
      '/hosted/skills/say-hello/scripts/hello.js',
      'hello-new',
    )
    expect(mockPut).not.toHaveBeenCalled()
    expect(mockNotify).toHaveBeenCalledWith('ws:/Users/me/project')
  })

  it('does not refresh when the auxiliary write fails', async () => {
    mockWrite.mockRejectedValueOnce(new Error('disk full'))
    render(<SkillFileEditor slug="say-hello" rel="scripts/hello.js" />)
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeTruthy())
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'hello-new' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockWrite).toHaveBeenCalled())
    expect(mockNotify).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it('treats a successful write plus failed refresh as saved, not save-failed', async () => {
    mockNotify.mockRejectedValueOnce(new Error('daemon down'))
    render(<SkillFileEditor slug="say-hello" rel="scripts/hello.js" />)
    await waitFor(() => expect(screen.getByTestId('code-editor')).toBeTruthy())
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'hello-new' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockNotify).toHaveBeenCalled())
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Skill 已保存，但新会话可能暂时仍使用旧缓存'),
    )
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('Save failed'))
  })
})
