import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/lib/config/version', () => ({ useAppVersion: () => '0.0.0-test' }))

import { RoleStep } from '../RoleStep'
import { useOnboardingStore } from '@/stores/onboarding'

describe('RoleStep', () => {
  beforeEach(() => {
    useOnboardingStore.getState().reset()
  })

  // The unit env runs zh-CN per project convention, so assert on that copy.
  it('offers both setup paths', () => {
    render(<RoleStep onDone={() => {}} />)
    expect(screen.getByText('我自己来')).toBeInTheDocument()
    expect(screen.getByText('直接开始用')).toBeInTheDocument()
  })

  // The recommended path leads: a first-timer reads it before the one that asks
  // them to choose a runtime.
  it('puts the guided card first', () => {
    render(<RoleStep onDone={() => {}} />)
    const order = screen.getAllByText(/^(直接开始用|我自己来)$/).map((el) => el.textContent)
    expect(order).toEqual(['直接开始用', '我自己来'])
  })

  // The heading is brand-free on purpose: every brand ships this screen, and the
  // display name added nothing the window title does not already say.
  it('does not name the app in the heading', () => {
    render(<RoleStep onDone={() => {}} />)
    expect(screen.getByText('想怎么配置？')).toBeInTheDocument()
  })

  // The titles alone read as two equally valid moods. Saying who each one is for
  // is the whole point of the screen — a first-timer must not have to guess.
  it('says who each path is for', () => {
    render(<RoleStep onDone={() => {}} />)
    expect(screen.getByText('适合开发者')).toBeInTheDocument()
    expect(screen.getByText('新手推荐')).toBeInTheDocument()
  })

  it.each([
    ['我自己来', 'developer'],
    ['直接开始用', 'guided'],
  ])('records %s as role %s', (label, role) => {
    const onDone = vi.fn()
    render(<RoleStep onDone={onDone} />)
    fireEvent.click(screen.getByText(label))
    expect(useOnboardingStore.getState().role).toBe(role)
    expect(onDone).toHaveBeenCalledWith(role)
  })

  // Language moved to a dedicated step ahead of this one (LanguageStep): as a
  // control on this screen it competed with the setup choice and got missed.
  it('no longer carries a language switch', () => {
    render(<RoleStep onDone={() => {}} />)
    expect(screen.queryByText('English')).not.toBeInTheDocument()
    expect(screen.queryByText('中文')).not.toBeInTheDocument()
  })
})
