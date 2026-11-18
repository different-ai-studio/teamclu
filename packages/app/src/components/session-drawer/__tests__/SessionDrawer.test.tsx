import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { SessionDrawer } from '@/components/session-drawer/SessionDrawer'
import { useOneSessionSidePanel } from '@/components/session-drawer/use-one-side-panel'
import { useUIStore } from '@/stores/ui'
import { useThreadPanelStore } from '@/stores/thread-panel-store'
import { useThreadListPanelStore } from '@/stores/thread-list-panel-store'

function renderDrawer(onClose = vi.fn()) {
  render(
    <div>
      <button data-testid="outside">chat</button>
      <button data-testid="toggle" data-session-drawer-toggle="">files</button>
      <SessionDrawer open title="Files" onClose={onClose}>
        <button data-testid="inside">a file</button>
      </SessionDrawer>
    </div>,
  )
  return onClose
}

describe('SessionDrawer', () => {
  beforeEach(() => {
    useUIStore.setState({ sessionDrawerPinned: false })
  })

  it('floats by default and closes on a click outside it', () => {
    const onClose = renderDrawer()
    expect(screen.getByTestId('session-drawer')).toHaveAttribute('data-drawer-mode', 'floating')
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open for clicks inside it and on its own toggles', () => {
    const onClose = renderDrawer()
    fireEvent.pointerDown(screen.getByTestId('inside'))
    fireEvent.pointerDown(screen.getByTestId('toggle'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape when focus is not elsewhere', () => {
    const onClose = renderDrawer()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('docks when pinned and then ignores outside clicks', () => {
    const onClose = renderDrawer()
    fireEvent.click(screen.getByTestId('session-drawer-pin'))
    expect(useUIStore.getState().sessionDrawerPinned).toBe(true)
    expect(screen.getByTestId('session-drawer')).toHaveAttribute('data-drawer-mode', 'docked')
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('useOneSessionSidePanel', () => {
  beforeEach(() => {
    useThreadPanelStore.getState().reset()
    useThreadListPanelStore.getState().close()
  })

  it('closes an open thread when the drawer opens', () => {
    act(() => {
      useThreadPanelStore.getState().open({ parentSessionId: 's1', rootMessageId: 'm1', title: 't' })
    })
    const closeDrawer = vi.fn()
    const { rerender } = renderHook(({ open }) => useOneSessionSidePanel(open, closeDrawer), {
      initialProps: { open: false },
    })
    rerender({ open: true })
    expect(useThreadPanelStore.getState().isOpen).toBe(false)
    expect(closeDrawer).not.toHaveBeenCalled()
  })

  it('closes the drawer when a thread opens', () => {
    const closeDrawer = vi.fn()
    renderHook(() => useOneSessionSidePanel(true, closeDrawer))
    act(() => {
      useThreadPanelStore.getState().open({ parentSessionId: 's1', rootMessageId: 'm1', title: 't' })
    })
    expect(closeDrawer).toHaveBeenCalledTimes(1)
  })
})
