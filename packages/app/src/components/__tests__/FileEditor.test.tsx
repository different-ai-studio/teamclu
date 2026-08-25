import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

// Mock all heavy dependencies
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, fallback: string) =>
      ({
        'history.noFileHistory': '该文件还没有提交历史',
      })[key] ?? fallback,
  }),
}))

// Hoisted so it is initialized before any vi.mock factory runs. FileEditor now
// imports the OSS history provider, which transitively loads the oss-sync store;
// that store calls isTauri() at module-eval time, invoking this mock during the
// hoisted import phase — before a plain `const` would be initialized (TDZ).
const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => false) }))
vi.mock('@/lib/utils', () => ({
  isTauri: () => isTauriMock(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      reloadSelectedFile: vi.fn(),
      targetLine: null,
      targetHeading: null,
      workspacePath: '/workspace',
    }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ sessionDiff: [] }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({}),
    { getState: () => ({ setFileModeRightTab: vi.fn() }) },
  ),
}))

// OSS is the only history backend now. Stub the provider so the panel renders
// its empty state without reaching for the daemon.
vi.mock('@/lib/history/oss-provider', () => ({
  OssHistoryProvider: class {
    async list() {
      return { entries: [], nextCursor: null }
    }
    async getContent() {
      return null
    }
  },
}))

vi.mock('@/components/editors/utils', () => ({
  getEditorType: () => 'code',
  supportsPreview: () => null,
  // CodeEditor calls this during render; without it the mock throws mid-render
  // and the failure surfaces as an unrelated "no export defined" error.
  getLanguageFromFilename: () => 'markdown',
}))

vi.mock('@/components/editors/useAutoSave', () => ({
  useAutoSave: () => ({
    saveStatus: 'saved',
    isSelfWrite: vi.fn().mockResolvedValue(false),
    saveNow: vi.fn(),
    cancelPendingSave: vi.fn(),
  }),
}))

vi.mock('@/components/editors/ConflictBanner', () => ({
  ConflictBanner: () => null,
}))

vi.mock('@/components/viewers/UnsupportedFileViewer', () => ({
  default: () => <div>Unsupported</div>,
  UNSUPPORTED_BINARY_EXTENSIONS: new Set(['exe', 'dll']),
}))

import { getFileType, FileContentViewer, FileEditor } from '@/components/FileEditor'

describe('FileEditor', () => {
  it('getFileType classifies images correctly', () => {
    expect(getFileType('photo.png')).toBe('image')
    expect(getFileType('logo.svg')).toBe('image')
    expect(getFileType('pic.jpg')).toBe('image')
  })

  it('getFileType classifies text files as text', () => {
    expect(getFileType('main.ts')).toBe('text')
    expect(getFileType('readme.md')).toBe('text')
  })

  it('getFileType classifies pdf files', () => {
    expect(getFileType('doc.pdf')).toBe('pdf')
  })

  it('FileContentViewer shows empty state when no file selected', () => {
    render(
      <FileContentViewer
        selectedFile={null}
        fileContent={null}
        isLoadingFile={false}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Select a file from the explorer')).toBeDefined()
  })

  it('FileContentViewer shows unable-to-load when content is null but file selected', () => {
    render(
      <FileContentViewer
        selectedFile="/workspace/src/main.ts"
        fileContent={null}
        isLoadingFile={false}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Unable to load file content')).toBeDefined()
  })

  it('FileContentViewer renders svg files in an iframe preview', () => {
    const svgDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'

    const { container } = render(
      <FileContentViewer
        selectedFile="/workspace/assets/logo.svg"
        fileContent={svgDataUrl}
        isLoadingFile={false}
        onClose={vi.fn()}
      />,
    )

    const iframe = container.querySelector('iframe[title="logo.svg"]')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('src')).toBe(svgDataUrl)
  })

  it('does not render the history button for non-team files', () => {
    render(
      <FileEditor
        content=""
        filename="note.md"
        filePath="/workspace/note.md"
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTitle(/查看历史|View history|历史/i)).toBeNull()
  })

  /**
   * Team content is exactly what sync carries: the `knowledge/` prefix. This
   * file arrives under the workspace `team-knowledge` symlink — the spelling
   * the workspace file panel produces — and maps to the same sync key as the
   * copy the Knowledge column opens by its real ~/.amuxd path.
   */
  it('renders the history button for team knowledge files and toggles history view', async () => {
    isTauriMock.mockReturnValue(true)
    render(
      <FileEditor
        content=""
        filename="note.md"
        filePath="/workspace/team-knowledge/note.md"
        onClose={() => {}}
      />,
    )
    const button = await screen.findByTitle(/查看历史|View history|历史/i)
    fireEvent.click(button)
    await waitFor(() =>
      expect(screen.getByText('该文件还没有提交历史')).toBeDefined(),
    )
    isTauriMock.mockReturnValue(false)
  })

  /**
   * `teamclu-team/` is a tree sync retired — nothing under it has versions. It
   * used to get the button anyway, which offered a history that could only ever
   * come back empty.
   */
  it('does not render the history button for retired teamclu-team content', () => {
    isTauriMock.mockReturnValue(true)
    render(
      <FileEditor
        content=""
        filename="note.md"
        filePath="/workspace/teamclu-team/skills/note.md"
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTitle(/查看历史|View history|历史/i)).toBeNull()
    isTauriMock.mockReturnValue(false)
  })
})
