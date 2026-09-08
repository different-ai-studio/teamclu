import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConflictBar } from '../ConflictBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string | { v?: number; count?: number }) => {
    if (typeof d === 'string') return d
    return _k
  } }),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

vi.mock('lucide-react', () => ({
  Loader2: () => null,
  Trash2: () => null,
  Copy: () => null,
  Upload: () => null,
}))

const noop = () => {}

describe('ConflictBar file preview', () => {
  it('shows at most five paths and keeps publish visible with 200 added files', () => {
    const added = Array.from({ length: 200 }, (_, i) => `results/out-${i}.json`)
    render(
      <ConflictBar
        modified={['SKILL.md']}
        deleted={[]}
        added={added}
        installedVersion={5}
        latestVersion={5}
        busy={false}
        canPublish
        isStaleDirty={false}
        source="member"
        onViewDiff={noop}
        onPublish={noop}
        onFork={noop}
        onDiscard={noop}
        onRebaseOnLatest={noop}
      />,
    )

    expect(screen.getByText('Publish as v{{v}}')).toBeTruthy()
    expect(screen.getByText('SKILL.md')).toBeTruthy()
    expect(screen.getByText('results/out-0.json')).toBeTruthy()
    expect(screen.queryByText('results/out-199.json')).toBeNull()
    expect(screen.getByText('and {{count}} more files')).toBeTruthy()
  })

  it('hides publish and shows discard-and-use when the draft is stale', () => {
    render(
      <ConflictBar
        modified={['SKILL.md']}
        deleted={[]}
        added={[]}
        installedVersion={5}
        latestVersion={7}
        busy={false}
        canPublish
        isStaleDirty
        source="member"
        onViewDiff={noop}
        onPublish={noop}
        onFork={noop}
        onDiscard={noop}
        onRebaseOnLatest={noop}
      />,
    )

    expect(screen.queryByText('Publish as v{{v}}')).toBeNull()
    expect(screen.getByText('Discard local changes and use v{{v}}')).toBeTruthy()
  })
})
