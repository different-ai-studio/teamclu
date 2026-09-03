import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

describe('ensureBundledAmuxdCurrent', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
  })

  it('is a no-op under desktop-managed amuxd (no bin copy)', async () => {
    const { ensureBundledAmuxdCurrent } = await import('@/lib/daemon/daemon-version-upgrade')
    await ensureBundledAmuxdCurrent()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
