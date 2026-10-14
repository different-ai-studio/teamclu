import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalAgentRequiredCard } from './LocalAgentRequiredCard'
import { useLocalAgentInstallStore } from '@/stores/local-agent-install'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

describe('LocalAgentRequiredCard', () => {
  beforeEach(() => {
    useLocalAgentInstallStore.setState({ wizardOpen: false })
  })

  it('asks before opening the install wizard', () => {
    render(<LocalAgentRequiredCard />)

    expect(screen.getByText('Local agent is not installed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(useLocalAgentInstallStore.getState().wizardOpen).toBe(false)

    expect(screen.getByText('Install the local agent?')).toBeInTheDocument()
    const installButtons = screen.getAllByRole('button', { name: 'Install' })
    fireEvent.click(installButtons[installButtons.length - 1])

    expect(useLocalAgentInstallStore.getState().wizardOpen).toBe(true)
  })
})
