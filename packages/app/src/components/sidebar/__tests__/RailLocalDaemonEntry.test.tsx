import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const agent = vi.hoisted(() => ({
  state: {
    absent: false,
    actor: { id: 'a1', display_name: '排班搭档' } as { id: string; display_name: string } | null,
    runtimeStatus: 'online' as string,
  },
}))

vi.mock('@/components/sidebar/LocalDaemonCard', () => ({
  LocalDaemonCard: () => <div data-testid="local-daemon-card" />,
  useLocalDaemonAgent: () => agent.state,
}))
vi.mock('@/components/sidebar/LocalDaemonRow', () => ({
  LocalDaemonMark: () => <span data-testid="local-daemon-mark" />,
  localDaemonStatusLabel: (status: string) => status,
}))

import { RailLocalDaemonEntry } from '../RailLocalDaemonEntry'

describe('RailLocalDaemonEntry', () => {
  beforeEach(() => {
    agent.state = { absent: false, actor: { id: 'a1', display_name: '排班搭档' }, runtimeStatus: 'online' }
  })

  it('opens the card on click, not before', () => {
    render(<RailLocalDaemonEntry />)
    const trigger = screen.getByTestId('rail-local-daemon')
    fireEvent.mouseEnter(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('local-daemon-card')).toBeInTheDocument()
  })

  it('names the agent and its status, and flags it when not online', () => {
    agent.state = { ...agent.state, runtimeStatus: 'offline' }
    render(<RailLocalDaemonEntry />)
    const trigger = screen.getByTestId('rail-local-daemon')
    expect(trigger.getAttribute('aria-label')).toBe('排班搭档 · offline')
    expect(trigger.querySelector('.bg-coral')).not.toBeNull()
  })

  it('shows nothing while no agent is known', () => {
    agent.state = { absent: false, actor: null, runtimeStatus: 'checking' }
    render(<RailLocalDaemonEntry />)
    expect(screen.queryByTestId('rail-local-daemon')).toBeNull()
  })
})
