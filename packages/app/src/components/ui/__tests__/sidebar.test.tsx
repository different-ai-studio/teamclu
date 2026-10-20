import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.filter(Boolean).join(' ') }))

import {
  Sidebar,
  SidebarProvider,
  SidebarInset,
  useSidebar,
} from '../sidebar'

// Helper component to test the context
function SidebarConsumer() {
  const ctx = useSidebar()
  return <div data-testid="state">{ctx.state}</div>
}

// Mirrors how the second column's expand button decides to show itself.
function ExpandButton() {
  const { state, hasSidebar, toggleSidebar } = useSidebar()
  if (!hasSidebar || state !== 'collapsed') return null
  return <button onClick={toggleSidebar}>expand</button>
}

describe('SidebarProvider', () => {
  it('renders children and provides context', () => {
    render(
      <SidebarProvider>
        <SidebarConsumer />
      </SidebarProvider>
    )
    expect(screen.getByTestId('state').textContent).toBe('expanded')
  })

  it('SidebarInset renders children', () => {
    render(
      <SidebarProvider>
        <SidebarInset>
          <span>content</span>
        </SidebarInset>
      </SidebarProvider>
    )
    expect(screen.getByText('content')).toBeTruthy()
  })
})

describe('SidebarProvider overlay (medium / narrow layouts)', () => {
  it('opens the sidebar as a drawer from the expand button', () => {
    // The Windows bug: at 900–1023px the sidebar was not rendered, so the
    // expand button flipped `open` and then hid itself with nothing shown.
    render(
      <SidebarProvider overlay>
        <Sidebar>
          <span>nav</span>
        </Sidebar>
        <ExpandButton />
      </SidebarProvider>
    )
    expect(screen.queryByText('nav')).toBeNull()
    fireEvent.click(screen.getByText('expand'))
    expect(screen.getByText('nav')).toBeTruthy()
    // Still collapsed as far as inline room goes, so the button stays.
    expect(screen.getByText('expand')).toBeTruthy()
  })

  it('reads as collapsed even while `open` is true', () => {
    render(
      <SidebarProvider overlay defaultOpen>
        <SidebarConsumer />
      </SidebarProvider>
    )
    expect(screen.getByTestId('state').textContent).toBe('collapsed')
  })

  it('offers no expand button when no sidebar is mounted', () => {
    render(
      <SidebarProvider overlay>
        <ExpandButton />
      </SidebarProvider>
    )
    expect(screen.queryByText('expand')).toBeNull()
  })
})
