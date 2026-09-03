import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DiagnoseSessionButton } from '../DiagnoseSessionButton'

const requestSessionFocus = vi.fn()
const openSettings = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

vi.mock('@/stores/diagnostics-store', () => ({
  useDiagnosticsStore: (selector: (state: { requestSessionFocus: (id: string) => void }) => unknown) =>
    selector({ requestSessionFocus }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: { openSettings: (section?: string) => void }) => unknown) =>
    selector({ openSettings }),
}))

describe('DiagnoseSessionButton', () => {
  it('opens diagnostics focused on the current session', () => {
    render(<DiagnoseSessionButton sessionId="sess-9" />)
    fireEvent.click(screen.getByRole('button', { name: '诊断此会话' }))
    expect(requestSessionFocus).toHaveBeenCalledWith('sess-9')
    expect(openSettings).toHaveBeenCalledWith('diagnostics')
  })
})
