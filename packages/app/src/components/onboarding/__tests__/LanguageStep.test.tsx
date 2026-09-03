import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/lib/config/version', () => ({ useAppVersion: () => '0.0.0-test' }))

const { changeLanguage, localeState } = vi.hoisted(() => ({
  changeLanguage: vi.fn(),
  localeState: { current: 'zh-CN', languages: ['en', 'zh-CN'] },
}))
vi.mock('@/lib/i18n', () => ({
  changeLanguage,
  getCurrentLanguage: () => localeState.current,
  get availableLanguages() {
    return localeState.languages
  },
}))

import { LanguageStep } from '../LanguageStep'

describe('LanguageStep', () => {
  beforeEach(() => {
    localeState.current = 'zh-CN'
    localeState.languages = ['en', 'zh-CN']
    changeLanguage.mockClear()
  })

  // Each language in its own script — an ISO code is unreadable to exactly the
  // person this screen exists for.
  it('names every shipped language in its own script', () => {
    render(<LanguageStep onDone={() => {}} />)
    expect(screen.getByText('English')).toBeInTheDocument()
    expect(screen.getByText('中文')).toBeInTheDocument()
  })

  // The prompt cannot rely on a locale the user has not chosen yet.
  it('prompts in both languages', () => {
    render(<LanguageStep onDone={() => {}} />)
    expect(screen.getByText('选择语言')).toBeInTheDocument()
    expect(screen.getByText('Choose your language')).toBeInTheDocument()
  })

  it.each([
    ['English', 'en'],
    ['中文', 'zh-CN'],
  ])('applies %s and moves on', (label, lang) => {
    const onDone = vi.fn()
    render(<LanguageStep onDone={onDone} />)
    fireEvent.click(screen.getByText(label))
    expect(changeLanguage).toHaveBeenCalledWith(lang)
    expect(onDone).toHaveBeenCalled()
  })

  // The system-derived default arrives pre-marked so the common case is a
  // confirmation, not a decision.
  it('marks the language already in effect', () => {
    localeState.current = 'en'
    render(<LanguageStep onDone={() => {}} />)
    const english = screen.getByText('English').closest('button')
    const chinese = screen.getByText('中文').closest('button')
    expect(english).toHaveAttribute('aria-current', 'true')
    expect(chinese).toHaveAttribute('aria-current', 'false')
  })
})
