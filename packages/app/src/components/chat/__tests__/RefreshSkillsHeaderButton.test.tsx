import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RefreshSkillsHeaderButton } from '../RefreshSkillsHeaderButton'
import { SKILLS_CHANGED_EVENT } from '@/lib/skills/changed-event'

const notifyDaemonSkillsChanged = vi.fn()
const refreshNow = vi.fn(async () => {})
const toastSuccess = vi.fn()
const toastMessage = vi.fn()
const toastError = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    message: (...args: unknown[]) => toastMessage(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => `ws:${path}`,
  notifyDaemonSkillsChanged: (...args: unknown[]) => notifyDaemonSkillsChanged(...args),
}))

vi.mock('@/stores/workspace-runtime-refresh', () => ({
  useWorkspaceRuntimeRefreshStore: {
    getState: () => ({ refreshNow }),
  },
}))

describe('RefreshSkillsHeaderButton', () => {
  beforeEach(() => {
    notifyDaemonSkillsChanged.mockReset()
    refreshNow.mockReset()
    toastSuccess.mockReset()
    toastMessage.mockReset()
    toastError.mockReset()
  })

  it('refreshes skills and toasts applied', async () => {
    notifyDaemonSkillsChanged.mockResolvedValue({ ok: true, status: 'applied' })
    const changed = vi.fn()
    window.addEventListener(SKILLS_CHANGED_EVENT, changed)

    render(<RefreshSkillsHeaderButton workspacePath="/tmp/ws" />)
    fireEvent.click(screen.getByRole('button', { name: '强制刷新 Skills' }))

    await waitFor(() => {
      expect(notifyDaemonSkillsChanged).toHaveBeenCalledWith('ws:/tmp/ws')
    })
    expect(changed).toHaveBeenCalled()
    expect(refreshNow).toHaveBeenCalledWith('/tmp/ws')
    expect(toastSuccess).toHaveBeenCalledWith('Skills 已刷新')
    window.removeEventListener(SKILLS_CHANGED_EVENT, changed)
  })

  it('toasts pending when an active turn blocks apply', async () => {
    notifyDaemonSkillsChanged.mockResolvedValue({
      ok: true,
      status: 'pending_active_turn',
    })

    render(<RefreshSkillsHeaderButton workspacePath="/tmp/ws" />)
    fireEvent.click(screen.getByRole('button', { name: '强制刷新 Skills' }))

    await waitFor(() => {
      expect(toastMessage).toHaveBeenCalledWith(
        '当前会话正在运行，Skills 将在结束后生效',
      )
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('toasts the daemon error when refresh fails', async () => {
    notifyDaemonSkillsChanged.mockRejectedValue(new Error('daemon down'))

    render(<RefreshSkillsHeaderButton workspacePath="/tmp/ws" />)
    fireEvent.click(screen.getByRole('button', { name: '强制刷新 Skills' }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('daemon down')
    })
  })
})
