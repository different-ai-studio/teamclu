import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}))

import { ChannelRuntimeOptions } from '../ChannelRuntimeOptions'

const models = [
  { id: 'anthropic/claude-sonnet', displayName: 'Claude Sonnet', providerName: 'anthropic' },
  { id: 'team/glm-4.6', displayName: '标准', providerName: 'team' },
]

describe('ChannelRuntimeOptions model picker', () => {
  it('groups models by provider the way wiki maintenance does', () => {
    render(
      <ChannelRuntimeOptions
        models={models}
        workspaces={[]}
        inheritedWorkspaceId={null}
        inheritedModel={null}
        onChange={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }))

    const team = document.querySelector('optgroup[label="team"]')
    const anthropic = document.querySelector('optgroup[label="anthropic"]')
    expect(team?.textContent).toContain('标准')
    expect(anthropic?.textContent).toContain('Claude Sonnet')
  })
})
