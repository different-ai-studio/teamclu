import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, vars?: Record<string, string>) =>
      vars ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? '') : fallback,
  }),
}))

import { DeleteTeamSkillDialog } from '../TeamShareListColumn'

/**
 * The gate on deleting a team skill.
 *
 * Worth its own test because it is the only thing standing between one click
 * and every member losing a skill: the click is one person's, the consequence
 * is the whole team's, and there is no undo.
 */
describe('DeleteTeamSkillDialog', () => {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()

  const setup = (slug = 'deploy-check') =>
    render(
      <DeleteTeamSkillDialog
        slug={slug}
        open
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

  const confirmButton = () => screen.getByRole('button', { name: '移除' })
  const box = () => screen.getByRole('textbox')

  beforeEach(() => {
    cleanup()
    onConfirm.mockClear()
    onCancel.mockClear()
  })

  test('refuses to confirm until the name is typed', () => {
    setup()
    expect(confirmButton()).toBeDisabled()

    fireEvent.change(box(), { target: { value: 'deploy' } })
    expect(confirmButton()).toBeDisabled()

    fireEvent.change(box(), { target: { value: 'deploy-check' } })
    expect(confirmButton()).toBeEnabled()

    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('a different skill\'s name does not open the gate', () => {
    // The check people actually need: not "did you mean it" but "are you on the
    // row you think you are". A near-miss must not pass.
    setup()
    fireEvent.change(box(), { target: { value: 'deploy-checks' } })
    expect(confirmButton()).toBeDisabled()
  })

  test('surrounding whitespace is forgiven', () => {
    setup()
    fireEvent.change(box(), { target: { value: '  deploy-check ' } })
    expect(confirmButton()).toBeEnabled()
  })

  test('Enter confirms only once the name matches', () => {
    setup()
    fireEvent.change(box(), { target: { value: 'nope' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(box(), { target: { value: 'deploy-check' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('a delete in flight cannot be fired twice', () => {
    render(
      <DeleteTeamSkillDialog
        slug="deploy-check"
        open
        busy
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )
    fireEvent.change(box(), { target: { value: 'deploy-check' } })
    expect(confirmButton()).toBeDisabled()
  })

  test('switching to another skill clears what was already typed', () => {
    // Otherwise closing on one row and opening on the next arrives
    // pre-confirmed, which is the failure this dialog exists to prevent.
    const { rerender } = setup()
    fireEvent.change(box(), { target: { value: 'deploy-check' } })
    expect(confirmButton()).toBeEnabled()

    rerender(
      <DeleteTeamSkillDialog
        slug="release-notes"
        open
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )
    expect(confirmButton()).toBeDisabled()
    expect(box()).toHaveValue('')
  })
})
