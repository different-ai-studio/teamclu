import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, vars?: Record<string, string>) =>
      vars ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? '') : fallback,
  }),
}))

import { DeprecateTeamSkillDialog } from '../DeprecateTeamSkillDialog'

describe('DeprecateTeamSkillDialog', () => {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()

  const setup = (publishedSlugs = ['hotfix-deploy', 'release-notes']) =>
    render(
      <DeprecateTeamSkillDialog
        slug="deploy-check"
        open
        busy={false}
        publishedSlugs={publishedSlugs}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

  beforeEach(() => {
    cleanup()
    onConfirm.mockClear()
    onCancel.mockClear()
  })

  test('confirm works without typing the slug', () => {
    setup()
    const confirm = screen.getByRole('button', { name: '退役' })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith(null)
  })

  test('selecting a replacement slug passes it on confirm', () => {
    setup()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hotfix-deploy' } })
    fireEvent.click(screen.getByRole('button', { name: '退役' }))
    expect(onConfirm).toHaveBeenCalledWith('hotfix-deploy')
  })

  test('leaving replacement at none passes null', () => {
    setup()
    const select = screen.getByRole('combobox')
    expect(select).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '退役' }))
    expect(onConfirm).toHaveBeenCalledWith(null)
  })
})
