import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NavGroupSwitch } from '../NavGroupSwitch'
import { useUIStore } from '@/stores/ui'

describe('NavGroupSwitch', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' }, embedMode: false, navGroupLast: {} })
  })

  it('renders nothing outside a group', () => {
    render(<NavGroupSwitch />)
    expect(screen.queryByTestId('nav-group-switch')).toBeNull()
  })

  it('switches between knowledge base and ideas in 知识', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'teamShare', section: 'knowledge' } })
    render(<NavGroupSwitch />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['知识库', '想法'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')

    fireEvent.click(tabs[1])
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'ideas' })
    expect(useUIStore.getState().navGroupLast.knowledge).toBe('ideas')
  })

  it('lists skills, MCP and secrets in 能力', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'teamShare', section: 'mcp' } })
    render(<NavGroupSwitch />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
  })

  it('hides itself in embed mode, where 知识 has only the knowledge base', () => {
    useUIStore.setState({ embedMode: true, sidebarFilter: { kind: 'teamShare', section: 'knowledge' } })
    render(<NavGroupSwitch />)
    expect(screen.queryByTestId('nav-group-switch')).toBeNull()
  })
})
