import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppEnvTabContent } from '../AppEnvTabContent'
import type { AppEnvVar, AppRow } from '@/lib/backend/types'

const backendMocks = vi.hoisted(() => ({
  listAppEnv: vi.fn(),
  putAppEnv: vi.fn(),
  deleteAppEnv: vi.fn(),
}))

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

const storeMocks = vi.hoisted(() => ({
  items: [] as AppRow[],
  deployingIds: [] as string[],
  deploy: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({ getBackend: () => ({ apps: backendMocks }) }))
vi.mock('sonner', () => ({ toast: toastMocks }))
vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: typeof storeMocks) => unknown) => sel(storeMocks),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, string>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) text = text.replace(`{{${k}}}`, String(v))
      }
      return text
    },
  }),
}))

const app = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Demo App',
  provisionStatus: 'ready',
  envPendingRedeploy: false,
} as unknown as AppRow

const plain = (over: Partial<AppEnvVar> = {}): AppEnvVar => ({
  key: 'LOG_LEVEL',
  isSecret: false,
  value: 'debug',
  updatedAt: '2026-09-10T00:00:00Z',
  ...over,
})

const secret = (over: Partial<AppEnvVar> = {}): AppEnvVar => ({
  key: 'STRIPE_KEY',
  isSecret: true,
  value: null,
  updatedAt: '2026-09-10T00:00:00Z',
  ...over,
})

function renderTab(over: Partial<AppRow> = {}) {
  storeMocks.items = [{ ...app, ...over } as AppRow]
  return render(<AppEnvTabContent appId="app-1" />)
}

describe('AppEnvTabContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.deployingIds = []
    backendMocks.listAppEnv.mockResolvedValue({ items: [plain(), secret()], canWrite: true })
  })

  it('shows a plain value and never a secret one', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('LOG_LEVEL')).toBeTruthy())
    expect(screen.getByText('debug')).toBeTruthy()
    expect(screen.getByText('已设置（不可查看）')).toBeTruthy()
  })

  it('tells an empty value apart from a secret one', async () => {
    // `value: ""` is a variable deliberately set to nothing; `value: null` on a
    // secret means "there is a value and you cannot see it". Rendering both as
    // blank would merge two different facts.
    backendMocks.listAppEnv.mockResolvedValue({
      items: [plain({ key: 'EMPTY', value: '' }), secret()],
      canWrite: true,
    })
    renderTab()
    await waitFor(() => expect(screen.getByText('（空）')).toBeTruthy())
    expect(screen.getByText('已设置（不可查看）')).toBeTruthy()
  })

  it('hides every write control from a reader', async () => {
    backendMocks.listAppEnv.mockResolvedValue({ items: [plain()], canWrite: false })
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-env-readonly')).toBeTruthy())
    expect(screen.queryByTestId('app-env-new')).toBeNull()
    expect(screen.queryByTestId('app-env-edit')).toBeNull()
  })

  it('creates a plain variable', async () => {
    backendMocks.listAppEnv.mockResolvedValue({ items: [], canWrite: true })
    backendMocks.putAppEnv.mockResolvedValue(plain({ key: 'API_HOST', value: 'https://x' }))
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-env-new')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-env-new'))
    await user.type(screen.getByTestId('app-env-key'), 'API_HOST')
    await user.type(screen.getByTestId('app-env-value'), 'https://x')
    await user.click(screen.getByTestId('app-env-save'))

    await waitFor(() => expect(backendMocks.putAppEnv).toHaveBeenCalled())
    expect(backendMocks.putAppEnv.mock.calls[0]).toEqual([
      'app-1',
      'API_HOST',
      { value: 'https://x', isSecret: false },
    ])
  })

  it('refuses a name the platform owns, before the request', async () => {
    backendMocks.listAppEnv.mockResolvedValue({ items: [], canWrite: true })
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-env-new')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-env-new'))
    await user.type(screen.getByTestId('app-env-key'), 'DATABASE_URL')
    await user.type(screen.getByTestId('app-env-value'), 'postgres://x')

    expect(screen.getByTestId('app-env-key-reserved')).toBeTruthy()
    expect(screen.getByTestId('app-env-save')).toHaveProperty('disabled', true)
    expect(backendMocks.putAppEnv).not.toHaveBeenCalled()
  })

  it('refuses a TEAMCLU_ name too, since the platform owns the whole prefix', async () => {
    backendMocks.listAppEnv.mockResolvedValue({ items: [], canWrite: true })
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-env-new')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-env-new'))
    await user.type(screen.getByTestId('app-env-key'), 'TEAMCLU_STORAGE_TOKEN')
    expect(screen.getByTestId('app-env-key-reserved')).toBeTruthy()
  })

  it('refuses a name the runtime could not look up', async () => {
    backendMocks.listAppEnv.mockResolvedValue({ items: [], canWrite: true })
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-env-new')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-env-new'))
    await user.type(screen.getByTestId('app-env-key'), 'MY-KEY')
    expect(screen.getByTestId('app-env-save')).toHaveProperty('disabled', true)
  })

  it('will not save a secret with nothing typed, which would wipe it', async () => {
    // Editing a secret starts blank because there is no stored value to show.
    // Letting Save through on a blank field would replace the key with "".
    renderTab()
    await waitFor(() => expect(screen.getAllByTestId('app-env-edit').length).toBe(2))

    const user = userEvent.setup()
    await user.click(screen.getAllByTestId('app-env-edit')[1]) // the secret
    expect(screen.getByTestId('app-env-value')).toHaveProperty('value', '')
    expect(screen.getByTestId('app-env-save')).toHaveProperty('disabled', true)

    await user.type(screen.getByTestId('app-env-value'), 'sk_new')
    expect(screen.getByTestId('app-env-save')).toHaveProperty('disabled', false)
  })

  it('does not let an existing variable be renamed in place', async () => {
    // A rename is a delete plus a create; pretending otherwise would leave the
    // old key behind on the next deploy.
    renderTab()
    await waitFor(() => expect(screen.getAllByTestId('app-env-edit').length).toBe(2))
    await userEvent.setup().click(screen.getAllByTestId('app-env-edit')[0])
    expect(screen.getByTestId('app-env-key')).toHaveProperty('disabled', true)
  })

  it('offers a redeploy exactly while the running function lags', async () => {
    renderTab({ envPendingRedeploy: false })
    await waitFor(() => expect(screen.getByText('LOG_LEVEL')).toBeTruthy())
    expect(screen.queryByTestId('app-env-pending-redeploy')).toBeNull()

    renderTab({ envPendingRedeploy: true })
    await waitFor(() => expect(screen.getByTestId('app-env-pending-redeploy')).toBeTruthy())
    expect(screen.getByTestId('app-env-redeploy-now')).toBeTruthy()
  })

  it('deletes a variable after confirming', async () => {
    backendMocks.deleteAppEnv.mockResolvedValue(true)
    renderTab()
    await waitFor(() => expect(screen.getByText('LOG_LEVEL')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await user.click(screen.getAllByRole('button', { name: '删除' }).at(-1)!)

    await waitFor(() => expect(backendMocks.deleteAppEnv).toHaveBeenCalledWith('app-1', 'LOG_LEVEL'))
  })
})
