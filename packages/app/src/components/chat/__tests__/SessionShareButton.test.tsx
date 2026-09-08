import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { canSystemShare, systemShareText, toastSuccess, toastError, writeText } = vi.hoisted(() => ({
  canSystemShare: vi.fn(() => true),
  systemShareText: vi.fn(async () => {}),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  writeText: vi.fn(async () => {}),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))

vi.mock('@/lib/session/session-share', async () => {
  const actual = await vi.importActual<typeof import('@/lib/session/session-share')>(
    '@/lib/session/session-share',
  )
  return { ...actual, canSystemShare, systemShareText }
})

// Radix menus never open under jsdom's pointer model; the items are what this
// test is about, so the primitives are flattened away.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

import { SessionShareButton } from '../SessionShareButton'

const LINK = 'teamclu://session/sess-9'

describe('SessionShareButton', () => {
  beforeEach(() => {
    canSystemShare.mockReset().mockReturnValue(true)
    systemShareText.mockReset().mockResolvedValue(undefined)
    toastSuccess.mockReset()
    toastError.mockReset()
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('copies the session deeplink', async () => {
    render(<SessionShareButton sessionId="sess-9" />)
    fireEvent.click(screen.getByText('复制链接'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK))
    expect(toastSuccess).toHaveBeenCalledWith('会话链接已复制')
  })

  it('reports a clipboard failure instead of claiming success', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    render(<SessionShareButton sessionId="sess-9" />)
    fireEvent.click(screen.getByText('复制链接'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('复制失败'))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('hands the link to the system share sheet', async () => {
    render(<SessionShareButton sessionId="sess-9" />)
    fireEvent.click(screen.getByText('系统分享…'))
    await waitFor(() => expect(systemShareText).toHaveBeenCalled())
    expect(systemShareText.mock.calls[0][0]).toBe(LINK)
  })

  it('stays quiet when the user dismisses the sheet', async () => {
    const abort = new Error('cancelled')
    abort.name = 'AbortError'
    systemShareText.mockRejectedValueOnce(abort)
    render(<SessionShareButton sessionId="sess-9" />)
    fireEvent.click(screen.getByText('系统分享…'))
    await waitFor(() => expect(systemShareText).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalled()
  })

  it('toasts when the sheet could not be shown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    systemShareText.mockRejectedValueOnce(new Error('no NSWindow'))
    render(<SessionShareButton sessionId="sess-9" />)
    fireEvent.click(screen.getByText('系统分享…'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('分享失败'))
  })

  // Windows has no share sheet wired up: the button keeps its old one-click
  // copy behaviour rather than opening a one-item menu.
  it('degrades to a plain copy button where the OS has no share sheet', async () => {
    canSystemShare.mockReturnValue(false)
    render(<SessionShareButton sessionId="sess-9" />)
    expect(screen.queryByText('系统分享…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK))
  })
})
