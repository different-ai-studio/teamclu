import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppFilesSection, baseName, breadcrumbFor } from '../AppFilesSection'
import type { AppRow } from '@/lib/backend/types'

const backendMocks = vi.hoisted(() => ({
  listAppFiles: vi.fn(),
  getAppStorageUsage: vi.fn(),
  refreshAppStorageUsage: vi.fn(),
  createAppFileUploadUrl: vi.fn(),
  createAppFileDownloadUrl: vi.fn(),
  deleteAppFile: vi.fn(),
  deleteAppFolder: vi.fn(),
  purgeAppFiles: vi.fn(),
}))
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('@/lib/backend', () => ({ getBackend: () => ({ apps: backendMocks }) }))
vi.mock('sonner', () => ({ toast: toastMocks }))
vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, string>) => {
      let text = fallback ?? key
      if (opts) for (const [k, v] of Object.entries(opts)) text = text.replace(`{{${k}}}`, String(v))
      return text
    },
  }),
}))

const app = { id: 'app-1', teamId: 'team-1', name: 'Demo' } as unknown as AppRow

const file = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  size: 1024,
  lastModified: '2026-04-11T00:00:00Z',
  etag: 'e',
  ...over,
})

/** One page per prefix, so navigation can be asserted end to end. */
function pages(byPrefix: Record<string, { folders?: string[]; items?: any[]; nextCursor?: string | null }>) {
  backendMocks.listAppFiles.mockImplementation(async (_id: string, q: any) => {
    const p = byPrefix[q.prefix ?? ''] ?? {}
    return {
      folders: p.folders ?? [],
      items: p.items ?? [],
      nextCursor: p.nextCursor ?? null,
      canWrite: true,
    }
  })
}

describe('AppFilesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    backendMocks.getAppStorageUsage.mockResolvedValue({ bytes: 2048, quotaBytes: null })
    pages({
      '': { folders: ['resumes/', 'generated/'], items: [file('resume.pdf')] },
      'resumes/': { items: [file('resumes/alice.pdf'), file('resumes/bob.pdf')] },
    })
  })

  // --- the pure helpers ------------------------------------------------------

  it('a row shows the last segment, not the whole key', () => {
    expect(baseName('resumes/alice.pdf')).toBe('alice.pdf')
    expect(baseName('resumes/')).toBe('resumes')
    expect(baseName('top.txt')).toBe('top.txt')
    expect(baseName('a/b/c/')).toBe('c')
  })

  it('the breadcrumb is derived from the prefix, not accumulated by clicking', () => {
    // So arriving anywhere produces the same trail as walking there.
    expect(breadcrumbFor('')).toEqual([])
    expect(breadcrumbFor('a/b/')).toEqual([
      { label: 'a', prefix: 'a/' },
      { label: 'b', prefix: 'a/b/' },
    ])
  })

  // --- browsing --------------------------------------------------------------

  it('asks the store to collapse one level, and lists folders before files', async () => {
    render(<AppFilesSection app={app} canManage />)
    await waitFor(() => expect(screen.getAllByTestId('app-files-folder')).toHaveLength(2))

    // 100, not a round number of taste: `parseLimit` on the server rejects
    // anything above it with a 400, and the mocked backend here cannot tell us
    // that — see the route test that pins the ceiling.
    expect(backendMocks.listAppFiles).toHaveBeenCalledWith('app-1', {
      prefix: '',
      delimiter: '/',
      limit: 100,
    })
    const rows = screen.getAllByTestId(/^app-files-(folder|file)$/)
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'app-files-folder',
      'app-files-folder',
      'app-files-file',
    ])
  })

  it('navigates into a folder and back out through the breadcrumb', async () => {
    render(<AppFilesSection app={app} canManage />)
    await waitFor(() => expect(screen.getByText('resumes')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByText('resumes'))
    await waitFor(() => expect(screen.getByText('alice.pdf')).toBeTruthy())
    expect(backendMocks.listAppFiles).toHaveBeenLastCalledWith('app-1', {
      prefix: 'resumes/',
      delimiter: '/',
      limit: 100,
    })

    await user.click(screen.getByText('全部文件'))
    await waitFor(() => expect(screen.getByText('resume.pdf')).toBeTruthy())
  })

  it('tells an empty folder apart from an app with no files at all', async () => {
    pages({ '': { folders: ['empty/'] }, 'empty/': {} })
    render(<AppFilesSection app={app} canManage />)
    await waitFor(() => expect(screen.getByText('empty')).toBeTruthy())
    await userEvent.setup().click(screen.getByText('empty'))
    await waitFor(() =>
      expect(screen.getByTestId('app-files-empty').textContent).toContain('这个文件夹是空的'),
    )
  })

  it('uploads into the folder being looked at, not the root', async () => {
    // An upload button whose destination depends on nothing visible is how a
    // file lands somewhere nobody expects.
    backendMocks.createAppFileUploadUrl.mockResolvedValue({ url: 'https://signed', path: 'x' })
    global.fetch = vi.fn(async () => new Response('', { status: 200 })) as any

    render(<AppFilesSection app={app} canManage />)
    await waitFor(() => expect(screen.getByText('resumes')).toBeTruthy())
    const user = userEvent.setup()
    await user.click(screen.getByText('resumes'))
    await waitFor(() => expect(screen.getByText('alice.pdf')).toBeTruthy())

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['x'], 'carol.pdf', { type: 'application/pdf' }))

    await waitFor(() => expect(backendMocks.createAppFileUploadUrl).toHaveBeenCalled())
    expect(backendMocks.createAppFileUploadUrl.mock.calls[0][1].path).toBe('resumes/carol.pdf')
  })

  it('deletes a file by its full path, not its displayed name', async () => {
    render(<AppFilesSection app={app} canManage />)
    await waitFor(() => expect(screen.getByText('resumes')).toBeTruthy())
    const user = userEvent.setup()
    await user.click(screen.getByText('resumes'))
    await waitFor(() => expect(screen.getByText('alice.pdf')).toBeTruthy())

    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await waitFor(() =>
      expect(backendMocks.deleteAppFile).toHaveBeenCalledWith('app-1', 'resumes/alice.pdf'),
    )
  })

  it('confirms before deleting a folder, and names what goes with it', async () => {
    backendMocks.deleteAppFolder.mockResolvedValue({ deleted: 12 })
    render(<AppFilesSection app={app} canManage />)
    await waitFor(() => expect(screen.getAllByTestId('app-files-folder')).toHaveLength(2))

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: '删除文件夹' })[0])
    expect(screen.getByText(/删除「resumes」整个文件夹/)).toBeTruthy()
    expect(screen.getByText(/包括子文件夹里的/)).toBeTruthy()
    expect(backendMocks.deleteAppFolder).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('app-files-folder-delete-confirm'))
    await waitFor(() =>
      expect(backendMocks.deleteAppFolder).toHaveBeenCalledWith('app-1', 'resumes/'),
    )
  })

  it('offers no write control to a reader', async () => {
    backendMocks.listAppFiles.mockResolvedValue({
      folders: ['resumes/'],
      items: [file('resume.pdf')],
      nextCursor: null,
      canWrite: false,
    })
    render(<AppFilesSection app={app} canManage={false} />)
    await waitFor(() => expect(screen.getByText('resume.pdf')).toBeTruthy())
    expect(screen.queryByTestId('app-files-upload')).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除文件夹' })).toBeNull()
    expect(screen.queryByTestId('app-files-purge')).toBeNull()
  })

  it('pages within the current folder rather than starting over', async () => {
    pages({ '': { items: [file('a.txt')], nextCursor: 'tok' } })
    render(<AppFilesSection app={app} canManage />)
    await waitFor(() => expect(screen.getByTestId('app-files-load-more')).toBeTruthy())
    await userEvent.setup().click(screen.getByTestId('app-files-load-more'))
    await waitFor(() =>
      expect(backendMocks.listAppFiles).toHaveBeenLastCalledWith('app-1', {
        prefix: '',
        delimiter: '/',
        limit: 100,
        after: 'tok',
      }),
    )
  })
})
