import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewChatSplitButton } from '../NewChatSplitButton'

const onPrimaryClick = vi.fn()
const openDialog = vi.fn()

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ openNewSessionDialog: openDialog }),
  },
}))

describe('NewChatSplitButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('primary click delegates to onPrimaryClick when ready', () => {
    render(
      <NewChatSplitButton
        quickChatState={{
          kind: 'ready',
          target: { agentId: 'a1', displayName: 'Bot', source: 'team_default' },
        }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /新聊天/i }))
    expect(onPrimaryClick).toHaveBeenCalled()
  })

  it('disables primary when no default agent is configured', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'no_agent' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    const button = screen.getByRole('button', { name: /新聊天/i })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title')
  })

  it('disables primary while loading', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'loading' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    expect(screen.getByRole('button', { name: /新聊天/i })).toBeDisabled()
  })

  it('opens the advanced dialog directly, with no intermediate menu', () => {
    render(
      <NewChatSplitButton
        quickChatState={{
          kind: 'ready',
          target: { agentId: 'a1', displayName: 'Bot', source: 'member_default' },
        }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    fireEvent.click(screen.getByTestId('new-chat-advanced'))
    expect(openDialog).toHaveBeenCalledTimes(1)
  })

  // The advanced half is the escape hatch: it is the only way to start a chat
  // when the quick half is dead, so it stays live in every state the quick half
  // refuses — including `no_team`, which the dialog answers with its empty state.
  it.each(['no_team', 'no_agent', 'loading'] as const)(
    'keeps the advanced half enabled when quick chat is %s',
    (kind) => {
      render(
        <NewChatSplitButton
          quickChatState={{ kind }}
          creating={true}
          onPrimaryClick={onPrimaryClick}
        />,
      )
      const advanced = screen.getByTestId('new-chat-advanced')
      expect(advanced).not.toBeDisabled()
      fireEvent.click(advanced)
      expect(openDialog).toHaveBeenCalled()
    },
  )
})
