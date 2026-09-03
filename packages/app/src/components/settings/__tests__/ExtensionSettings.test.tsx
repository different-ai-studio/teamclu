import * as React from 'react'
import { render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

vi.mock('@/lib/config/version', () => ({
  useAppVersion: () => '0.2.3',
}))

describe('ExtensionSettings', () => {
  let resizeCallback: ((entries: Pick<ResizeObserverEntry, 'contentRect'>[]) => void) | null = null

  beforeEach(() => {
    resizeCallback = null
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(function (this: void, cb: ResizeObserverCallback) {
        resizeCallback = (entries) => cb(entries as ResizeObserverEntry[], this as unknown as ResizeObserver)
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        }
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the Extension nav group instead of desktop Client settings', async () => {
    const { ExtensionSettings } = await import('../ExtensionSettings')

    render(<ExtensionSettings />)

    await act(async () => {
      resizeCallback?.([{ contentRect: { width: 720 } as DOMRectReadOnly }])
    })

    expect(screen.getByTestId('extension-settings-wide')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Extension' })).toBeInTheDocument()
    expect(screen.getByTestId('extension-subnav')).toBeInTheDocument()
    expect(screen.getByText('Extension settings for the browser side panel.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Client' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Daemon' })).toBeNull()
  })

  it('collapses sidebar to icon-only when the container is narrow', async () => {
    const { ExtensionSettings } = await import('../ExtensionSettings')

    render(<ExtensionSettings />)

    await act(async () => {
      resizeCallback?.([{ contentRect: { width: 400 } as DOMRectReadOnly }])
    })

    expect(screen.getByTestId('extension-settings-compact')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Extension' })).toBeNull()
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument()
    expect(screen.queryByText('v0.2.3')).toBeNull()
  })
})
