import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const revealInFinder = vi.fn()
vi.mock('@/components/workspace/file-tree-operations', () => ({
  revealInFinder: (...args: unknown[]) => revealInFinder(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

import { AgentsSkillsAccessBanner } from '../AgentsSkillsAccessBanner'
import { useAgentsSkillsAccessStore } from '@/stores/agents-skills-access-store'

describe('AgentsSkillsAccessBanner', () => {
  beforeEach(() => {
    revealInFinder.mockReset()
    useAgentsSkillsAccessStore.setState({
      access: null,
      checking: false,
      dismissed: false,
    })
  })

  it('renders nothing when access is ok', () => {
    useAgentsSkillsAccessStore.setState({
      access: {
        path: '/Users/me/.agents/skills',
        ok: true,
        kind: 'ok',
        message: 'ok',
        osReadable: true,
        osWritable: true,
        scopeGranted: true,
      },
    })
    const { container } = render(<AgentsSkillsAccessBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows reveal and retry when blocked', async () => {
    const user = userEvent.setup()
    useAgentsSkillsAccessStore.setState({
      access: {
        path: '/Users/me/.agents/skills',
        ok: false,
        kind: 'os_permission',
        message: 'denied',
        osReadable: false,
        osWritable: false,
        scopeGranted: true,
      },
      dismissed: false,
    })
    render(<AgentsSkillsAccessBanner />)
    expect(screen.getByTestId('agents-skills-access-banner')).toBeTruthy()
    await user.click(screen.getByTestId('agents-skills-access-reveal'))
    expect(revealInFinder).toHaveBeenCalledWith('/Users/me/.agents/skills')
  })
})
