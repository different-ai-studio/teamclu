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
    expect(screen.queryByRole('option', { name: 'Pi default model' })).toBeNull()
  })

  it('selects the session default instead of leaving the model unset', () => {
    render(
      <ChannelRuntimeOptions
        models={models}
        workspaces={[]}
        inheritedWorkspaceId={null}
        inheritedModel="team/glm-4.6"
        onChange={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }))

    expect(screen.getByRole('combobox')).toHaveValue('team/glm-4.6')
    expect(screen.queryByRole('option', { name: 'Pi default model' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Select a model' })).toBeNull()
  })
})
