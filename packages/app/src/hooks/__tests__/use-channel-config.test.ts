import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}))

vi.mock('@/lib/i18n', () => ({
  default: { t: (_key: string, fallback: string) => fallback },
}))

import { useChannelConfig } from '../use-channel-config'

type TestConfig = { enabled: boolean }

// Stable identities: the hook syncs `storeConfig` into local state on every
// change, so fresh literals per render would re-render forever.
const STORE_CONFIG: TestConfig = { enabled: true }
const DEFAULT_CONFIG: TestConfig = { enabled: false }
const GATEWAY_STATUS = { status: 'disconnected' } as const

function setup(saveConfig: (config: TestConfig) => Promise<void>) {
  const refreshStatus = vi.fn()
  return renderHook(() =>
    useChannelConfig<TestConfig>({
      storeConfig: STORE_CONFIG,
      defaultConfig: DEFAULT_CONFIG,
      gatewayStatus: GATEWAY_STATUS,
      isLoading: false,
      hasChanges: false,
      setHasChanges: vi.fn(),
      saveConfig,
      startGateway: vi.fn(async () => {}),
      stopGateway: vi.fn(async () => {}),
      refreshStatus,
    }),
  )
}

describe('useChannelConfig handleSave', () => {
  beforeEach(() => {
    mocks.success.mockClear()
    mocks.error.mockClear()
  })

  // Both outcomes used to be silent — nothing renders the stores' `error`
  // field, and there was no success toast, so "Save changes" gave no answer
  // either way.
  it('tells the user the save landed', async () => {
    const { result } = setup(async () => {})

    await act(async () => {
      await result.current.handleSave()
    })

    expect(mocks.success).toHaveBeenCalledWith('Changes saved')
    expect(mocks.error).not.toHaveBeenCalled()
    expect(result.current.isSaving).toBe(false)
  })

  it('surfaces a rejected save instead of swallowing it', async () => {
    const { result } = setup(async () => {
      throw new Error('amuxd not running. Start amuxd and try again.')
    })

    await act(async () => {
      await result.current.handleSave()
    })

    expect(mocks.error).toHaveBeenCalledWith('Failed to save changes', {
      description: 'amuxd not running. Start amuxd and try again.',
    })
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('marks the save in flight so the button can show it', async () => {
    let release: (() => void) | undefined
    const { result } = setup(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )

    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.handleSave()
    })
    await waitFor(() => expect(result.current.isSaving).toBe(true))

    await act(async () => {
      release?.()
      await pending
    })
    expect(result.current.isSaving).toBe(false)
  })
})
