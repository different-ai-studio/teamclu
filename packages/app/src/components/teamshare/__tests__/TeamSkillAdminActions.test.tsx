import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, vars?: Record<string, string>) =>
      vars ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? '') : fallback,
  }),
}))

import { TeamSkillAdminActions } from '../TeamSkillAdminActions'

describe('TeamSkillAdminActions', () => {
  const onDeprecate = vi.fn()
  const onRestore = vi.fn()
  const onDelete = vi.fn()

  const base = {
    canManageTeam: true,
    origin: 'registry',
    status: 'published',
    slug: 'deploy-check',
    publishedSlugs: ['hotfix-deploy', 'release-notes'],
    busy: false,
    onDeprecate,
    onRestore,
    onDelete,
  }

  beforeEach(() => {
    cleanup()
    onDeprecate.mockClear()
    onRestore.mockClear()
    onDelete.mockClear()
  })

  test('member sees no admin actions', () => {
    render(<TeamSkillAdminActions {...base} canManageTeam={false} />)
    expect(screen.queryByRole('button', { name: '退役' })).toBeNull()
    expect(screen.queryByRole('button', { name: '从团队移除…' })).toBeNull()
  })

  test('non-registry origin renders nothing', () => {
    render(<TeamSkillAdminActions {...base} origin="personal" />)
    expect(screen.queryByRole('button', { name: '退役' })).toBeNull()
  })

  test('admin + published shows deprecate and remove-from-team', () => {
    render(<TeamSkillAdminActions {...base} />)
    expect(screen.getByRole('button', { name: '退役' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '从团队移除…' })).toBeInTheDocument()
  })

  test('admin + published: deprecate opens dialog', () => {
    render(<TeamSkillAdminActions {...base} />)
    fireEvent.click(screen.getByRole('button', { name: '退役' }))
    expect(screen.getByText('退役团队 Skill')).toBeInTheDocument()
  })

  test('admin + deprecated shows restore, not deprecate', () => {
    render(<TeamSkillAdminActions {...base} status="deprecated" />)
    expect(screen.getByRole('button', { name: '恢复发布' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '退役' })).toBeNull()
    expect(screen.getByRole('button', { name: '从团队移除…' })).toBeInTheDocument()
  })

  test('admin + deprecated: restore calls onRestore directly', () => {
    render(<TeamSkillAdminActions {...base} status="deprecated" />)
    fireEvent.click(screen.getByRole('button', { name: '恢复发布' }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  test('admin + draft has remove-from-team but no deprecate', () => {
    render(<TeamSkillAdminActions {...base} status="draft" />)
    expect(screen.queryByRole('button', { name: '退役' })).toBeNull()
    expect(screen.getByRole('button', { name: '从团队移除…' })).toBeInTheDocument()
  })

  test('remove-from-team calls onDelete', () => {
    render(<TeamSkillAdminActions {...base} />)
    fireEvent.click(screen.getByRole('button', { name: '从团队移除…' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
