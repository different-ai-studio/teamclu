import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { QuickChatState } from '@/hooks/use-quick-chat-readiness'

const h = vi.hoisted(() => ({
  state: { kind: 'loading' } as QuickChatState,
  createQuickSession: vi.fn(async () => ({ ok: true as const, agentDisplayName: 'Bot' })),
}))

vi.mock('@/hooks/use-quick-chat-readiness', () => ({
  useQuickChatReadiness: () => h.state,
}))
vi.mock('@/lib/session/create-quick-session', () => ({
  createQuickSession: h.createQuickSession,
  describeQuickSessionFailure: () => ({ title: 'x', description: 'y' }),
}))
vi.mock('@/components/sidebar/NewChatSplitButton', () => ({
  NewChatSplitButton: ({ onPrimaryClick }: { onPrimaryClick: () => void }) => (
    <button type="button" data-testid="quick-new-chat" onClick={onPrimaryClick} />
  ),
}))
vi.mock('@/components/sidebar/ContactsNavEntry', () => ({ ContactsNavEntry: () => null }))
vi.mock('@/components/sidebar/AppsNavSection', () => ({ AppsNavSection: () => null }))
vi.mock('@/lib/config/remote-features', () => ({ useFeatures: () => ({ apps: true }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { NavRail } from '../NavRail'

describe('NavRail quick new chat', () => {
  beforeEach(() => {
    h.createQuickSession.mockClear()
  })

  // On a cold start the background resolve runs for 1–1.5 s after the button
  // paints. A click in that window used to be dropped; it now resolves the
  // agent itself.
  it('starts a chat while the agent is still resolving', () => {
    h.state = { kind: 'loading' }
    render(<NavRail />)
    fireEvent.click(screen.getByTestId('quick-new-chat'))
    expect(h.createQuickSession).toHaveBeenCalledWith(null)
  })

  it('uses the resolved agent once ready', () => {
    const target = { agentId: 'a1', displayName: 'Bot', source: 'local' as const }
    h.state = { kind: 'ready', target }
    render(<NavRail />)
    fireEvent.click(screen.getByTestId('quick-new-chat'))
    expect(h.createQuickSession).toHaveBeenCalledWith(target)
  })

  it.each(['no_team', 'no_agent'] as const)('does nothing when quick chat is %s', (kind) => {
    h.state = { kind }
    render(<NavRail />)
    fireEvent.click(screen.getByTestId('quick-new-chat'))
    expect(h.createQuickSession).not.toHaveBeenCalled()
  })
})
