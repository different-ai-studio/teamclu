import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppRow } from '@/lib/backend/types'

const mocks = vi.hoisted(() => ({
  activeSessionId: null as string | null,
  appIdBySessionId: {} as Record<string, string>,
  recordAppSession: vi.fn(),
  switchToSession: vi.fn(),
  ensureAppSession: vi.fn(),
  createAppSessionShell: vi.fn(),
  send: vi.fn(),
}))

vi.mock('@/lib/i18n', () => ({
  default: {
    t: (_k: string, fallback: string, vars?: Record<string, string>) =>
      fallback.replace('{{name}}', vars?.name ?? ''),
  },
}))
vi.mock('@/stores/session-selection-store', () => ({
  useSessionSelectionStore: { getState: () => ({ activeSessionId: mocks.activeSessionId }) },
}))
vi.mock('@/stores/apps-store', () => ({
  useAppsStore: {
    getState: () => ({
      appIdBySessionId: mocks.appIdBySessionId,
      recordAppSession: mocks.recordAppSession,
    }),
  },
}))
vi.mock('@/stores/ui', () => ({
  useUIStore: { getState: () => ({ switchToSession: mocks.switchToSession }) },
}))
vi.mock('@/lib/apps/app-session', () => ({
  ensureAppSession: (...a: unknown[]) => mocks.ensureAppSession(...a),
  createAppSessionShell: (...a: unknown[]) => mocks.createAppSessionShell(...a),
}))
vi.mock('@/lib/session/session-send-agent', () => ({
  sendAgentPromptInActiveSession: (...a: unknown[]) => mocks.send(...a),
}))

import { deployPromptForApp, requestAgentDeploy } from '../app-deploy-prompt'

const app = { id: 'app-1', teamId: 't', name: ' Alpha ' } as AppRow

beforeEach(() => {
  vi.clearAllMocks()
  mocks.activeSessionId = null
  mocks.appIdBySessionId = {}
  mocks.send.mockResolvedValue('msg-1')
  mocks.switchToSession.mockImplementation(async (id: string) => {
    mocks.activeSessionId = id
  })
})

describe('deployPromptForApp', () => {
  it('names the app and the deploy tool', () => {
    const text = deployPromptForApp(app)
    expect(text).toContain('「Alpha」')
    expect(text).toContain('amuxd app deploy')
    expect(text).not.toContain('manage_app')
  })
})

describe('requestAgentDeploy', () => {
  it('sends into the open session when it belongs to this app', async () => {
    mocks.activeSessionId = 's-open'
    mocks.appIdBySessionId = { 's-open': 'app-1' }
    await expect(requestAgentDeploy(app)).resolves.toBe('s-open')
    expect(mocks.ensureAppSession).not.toHaveBeenCalled()
    expect(mocks.switchToSession).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith(expect.stringContaining('amuxd app deploy'))
  })

  it("switches to the app's latest session when another one is open", async () => {
    mocks.activeSessionId = 's-other'
    mocks.ensureAppSession.mockResolvedValue('s-recent')
    await expect(requestAgentDeploy(app)).resolves.toBe('s-recent')
    expect(mocks.switchToSession).toHaveBeenCalledWith('s-recent', { keepSidebarFilter: true })
    expect(mocks.recordAppSession).toHaveBeenCalledWith('app-1', 's-recent')
    expect(mocks.send).toHaveBeenCalled()
  })

  it('creates a session for an app that has none', async () => {
    mocks.ensureAppSession.mockResolvedValue(null)
    mocks.createAppSessionShell.mockResolvedValue('s-new')
    await expect(requestAgentDeploy(app)).resolves.toBe('s-new')
    expect(mocks.send).toHaveBeenCalled()
  })

  it('does not send into a session the user moved away from', async () => {
    mocks.ensureAppSession.mockResolvedValue('s-recent')
    mocks.switchToSession.mockImplementation(async () => {
      mocks.activeSessionId = 's-elsewhere'
    })
    await expect(requestAgentDeploy(app)).resolves.toBeNull()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
