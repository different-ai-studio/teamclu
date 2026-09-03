import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string | Record<string, unknown>) => typeof d === 'string' ? d : (d?.defaultValue as string) ?? _k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), openExternalUrl: vi.fn() }))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}))
vi.mock('@/stores/channels-store', () => ({
  // EmailConfig type is just used for typing
}))
vi.mock('../shared', () => ({
  GmailIcon: (props: any) => <span data-testid="gmail-icon" {...props} />,
}))

import { EmailSetupWizard } from '../EmailSetupWizard'

describe('EmailSetupWizard', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <EmailSetupWizard open={false} onOpenChange={vi.fn()} onConfigSave={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders intro step when open', () => {
    render(
      <EmailSetupWizard open={true} onOpenChange={vi.fn()} onConfigSave={vi.fn()} />
    )
    expect(screen.getByText('Welcome to Email Setup')).toBeTruthy()
    expect(screen.getByText(/Connect Email to/)).toBeTruthy()
  })

  it('navigates to provider step on Next click', () => {
    render(
      <EmailSetupWizard open={true} onOpenChange={vi.fn()} onConfigSave={vi.fn()} />
    )
    const nextButton = screen.getByText('Next')
    fireEvent.click(nextButton)
    expect(screen.getByText('Choose Provider')).toBeTruthy()
    expect(screen.getByText('Gmail (OAuth2)')).toBeTruthy()
  })
})
