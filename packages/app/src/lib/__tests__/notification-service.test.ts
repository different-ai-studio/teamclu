import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendNotificationMock = vi.hoisted(() => vi.fn())
const onActionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
  sendNotification: sendNotificationMock,
  onAction: onActionMock,
}))

vi.mock('@/lib/permission-policy', () => ({
  getPermissionPolicy: vi.fn(() => 'default'),
}))

const requestUserAttentionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const isFocusedMock = vi.hoisted(() => vi.fn().mockResolvedValue(false))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    requestUserAttention: requestUserAttentionMock,
    isFocused: isFocusedMock,
  }),
  UserAttentionType: { Informational: 2 },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: vi.fn(() => true),
}))

const selectionState = vi.hoisted(() => ({ activeSessionId: null as string | null }))
vi.mock('@/stores/session-selection-store', () => ({
  useSessionSelectionStore: {
    getState: () => selectionState,
  },
}))

const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: vi.fn((k: string) => store[k] ?? null),
  setItem: vi.fn((k: string, v: string) => { store[k] = v }),
  removeItem: vi.fn((k: string) => { delete store[k] }),
})

import { notificationService } from '@/lib/notification-service'
import { appShortName } from '@/lib/build-config'

describe('notification-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isFocusedMock.mockResolvedValue(false)
    selectionState.activeSessionId = null
    Object.keys(store).forEach(k => delete store[k])
    notificationService.resetDockAttentionForTests()
  })

  it('getLevel returns default "important" when nothing stored', () => {
    expect(notificationService.getLevel()).toBe('important')
  })

  it('setLevel persists to localStorage', () => {
    notificationService.setLevel('all')
    expect(store[`${appShortName}-notification-level`]).toBe('all')
  })

  it('getLevel reads from localStorage', () => {
    store[`${appShortName}-notification-level`] = 'mute'
    expect(notificationService.getLevel()).toBe('mute')
  })

  it('send does not create notification when level is mute', async () => {
    store[`${appShortName}-notification-level`] = 'mute'
    await notificationService.send('action_required', 'Test', 'body', 'sess-1')
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })

  it('send uses Tauri sendNotification when level allows', async () => {
    store[`${appShortName}-notification-level`] = 'important'
    const result = await notificationService.send('action_required', 'Auth Required', 'Please approve', 'sess-3')
    expect(result).toBe('sent')
    expect(sendNotificationMock).toHaveBeenCalledOnce()
    expect(sendNotificationMock.mock.calls[0][0]).toMatchObject({
      title: 'Auth Required',
      body: 'Please approve',
      autoCancel: true,
    })
  })

  it('send does not create notification for info at important level', async () => {
    store[`${appShortName}-notification-level`] = 'important'
    const result = await notificationService.send('info', 'FYI', 'Just letting you know', 'sess-5')
    expect(result).toBe('skipped')
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })

  it('suppresses action_required when focused and viewing the same session', async () => {
    store[`${appShortName}-notification-level`] = 'important'
    isFocusedMock.mockResolvedValue(true)
    selectionState.activeSessionId = 'sess-7'
    const result = await notificationService.send('action_required', 'Auth Required', 'Please approve', 'sess-7')
    expect(result).toBe('skipped')
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })

  it('sends action_required when focused but on a different session', async () => {
    store[`${appShortName}-notification-level`] = 'important'
    isFocusedMock.mockResolvedValue(true)
    selectionState.activeSessionId = 'other-session'
    await notificationService.send('action_required', 'Auth Required', 'Please approve', 'sess-7')
    expect(sendNotificationMock).toHaveBeenCalledOnce()
  })

  it('sends notification when window is not focused', async () => {
    store[`${appShortName}-notification-level`] = 'important'
    isFocusedMock.mockResolvedValue(false)
    await notificationService.send('action_required', 'Auth Required', 'Please approve', 'sess-8')
    expect(sendNotificationMock).toHaveBeenCalledOnce()
  })

  it('requestDockAttention bounces dock when window is in background', async () => {
    isFocusedMock.mockResolvedValue(false)
    await notificationService.requestDockAttention()
    expect(requestUserAttentionMock).toHaveBeenCalledWith(2)
  })

  it('requestDockAttention skips when window is focused', async () => {
    isFocusedMock.mockResolvedValue(true)
    await notificationService.requestDockAttention()
    expect(requestUserAttentionMock).not.toHaveBeenCalled()
  })

  it('requestDockAttention throttles within 5 seconds', async () => {
    vi.useFakeTimers()
    isFocusedMock.mockResolvedValue(false)
    await notificationService.requestDockAttention()
    expect(requestUserAttentionMock).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(4000)
    await notificationService.requestDockAttention()
    expect(requestUserAttentionMock).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(1000)
    await notificationService.requestDockAttention()
    expect(requestUserAttentionMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
