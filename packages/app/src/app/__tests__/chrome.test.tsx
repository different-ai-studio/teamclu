import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BookOpen } from 'lucide-react'
import { HeaderPanelTab } from '../chrome'

describe('HeaderPanelTab', () => {
  it('calls onClick and shows the label as its title when enabled', () => {
    const onClick = vi.fn()
    render(<HeaderPanelTab icon={BookOpen} label="Files" isActive={false} onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'Files' })
    expect(button.getAttribute('title')).toBe('Files')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  // Shown greyed out with a reason, not removed: a vanished icon read as a bug.
  // aria-disabled (not disabled) so the hover title still appears in WebKit.
  it('stays hoverable but ignores clicks when disabled', () => {
    const onClick = vi.fn()
    render(
      <HeaderPanelTab
        icon={BookOpen}
        label="Files"
        isActive={false}
        disabled
        title="Agent runs on Mac.lan"
        onClick={onClick}
      />,
    )
    const button = screen.getByRole('button', { name: 'Files' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('title')).toBe('Agent runs on Mac.lan')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})
