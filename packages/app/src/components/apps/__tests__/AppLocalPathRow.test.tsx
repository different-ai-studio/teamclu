import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppLocalPathRow } from '../AppLocalPathRow'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

const mocks = vi.hoisted(() => ({
  daemonAppWorkdir: vi.fn(),
  openPathWithApp: vi.fn(),
  localAppIds: ['app-1'] as string[] | null,
  toastError: vi.fn(),
}))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  daemonAppWorkdir: (...args: unknown[]) => mocks.daemonAppWorkdir(...args),
}))
vi.mock('@/lib/apps/open-with-app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apps/open-with-app')>()),
  openPathWithApp: (...args: unknown[]) => mocks.openPathWithApp(...args),
}))
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  isTauri: () => true,
}))
vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: { localAppIds: string[] | null }) => unknown) =>
    sel({ localAppIds: mocks.localAppIds }),
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const app = { id: 'app-1', teamId: 'team-1', name: 'Alpha' } as AppRow

beforeEach(() => {
  vi.clearAllMocks()
  mocks.localAppIds = ['app-1']
  mocks.daemonAppWorkdir.mockResolvedValue({ workdir: '/Users/me/apps/alpha', deviceName: 'Mac' })
  mocks.openPathWithApp.mockResolvedValue(undefined)
})

describe('AppLocalPathRow', () => {
  it('shows the checkout path and copies it', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<AppLocalPathRow app={app} />)
    expect(await screen.findByTestId('app-local-path-value')).toHaveTextContent('/Users/me/apps/alpha')
    await user.click(screen.getByTestId('app-local-path-copy'))
    expect(writeText).toHaveBeenCalledWith('/Users/me/apps/alpha')
  })

  it('opens the checkout in the chosen tool', async () => {
    const user = userEvent.setup()
    render(<AppLocalPathRow app={app} />)
    await user.click(await screen.findByTestId('app-local-path-open-with'))
    await user.click(await screen.findByTestId('app-local-path-open-cursor'))
    expect(mocks.openPathWithApp).toHaveBeenCalledWith('/Users/me/apps/alpha', 'cursor')
  })

  it('offers every supported tool', async () => {
    const user = userEvent.setup()
    render(<AppLocalPathRow app={app} />)
    await user.click(await screen.findByTestId('app-local-path-open-with'))
    for (const id of ['vscode', 'cursor', 'claude', 'codex', 'qoder', 'workbuddy']) {
      expect(await screen.findByTestId(`app-local-path-open-${id}`)).toBeInTheDocument()
    }
  })

  it('surfaces a tool that failed to open', async () => {
    const user = userEvent.setup()
    mocks.openPathWithApp.mockRejectedValue(new Error('Qoder is not installed on this computer'))
    render(<AppLocalPathRow app={app} />)
    await user.click(await screen.findByTestId('app-local-path-open-with'))
    await user.click(await screen.findByTestId('app-local-path-open-qoder'))
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('does not offer a path for an app with no checkout here', async () => {
    mocks.localAppIds = []
    render(<AppLocalPathRow app={app} />)
    expect(await screen.findByText('这台电脑上还没有这个应用的代码')).toBeInTheDocument()
    expect(screen.queryByTestId('app-local-path-copy')).toBeNull()
  })
})
