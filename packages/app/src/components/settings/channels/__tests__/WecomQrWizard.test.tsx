import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useState } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: unknown) => {
      let text = k
      if (typeof d === 'string') text = d
      else if (d && typeof d === 'object' && 'defaultValue' in (d as Record<string, unknown>)) {
        text = String((d as Record<string, unknown>).defaultValue)
      }
      if (d && typeof d === 'object') {
        for (const [name, value] of Object.entries(d as Record<string, unknown>)) {
          if (name === 'defaultValue') continue
          text = text.replaceAll(`{{${name}}}`, String(value ?? ''))
        }
      }
      return text
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}))

const { startWecomQrAuth, pollWecomQrAuth } = vi.hoisted(() => ({
  startWecomQrAuth: vi.fn(),
  pollWecomQrAuth: vi.fn(),
}))

vi.mock('@/stores/channels-store', () => ({
  useChannelsStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { startWecomQrAuth, pollWecomQrAuth }
    return typeof selector === 'function' ? selector(state) : state
  },
  defaultWeComConfig: { enabled: false, bots: [] },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: vi.fn((selector?: (s: { team: null }) => unknown) =>
    typeof selector === 'function' ? selector({ team: null }) : { team: null },
  ),
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  getCurrentDaemonWorkspaceAgent: vi.fn(async () => null),
  listDaemonWorkspaces: vi.fn(async () => []),
}))

vi.mock('@/hooks/use-channel-config', () => ({
  useChannelConfig: () => ({
    localConfig: { enabled: false, bots: [] },
    updateLocalConfig: vi.fn(),
    isConnecting: false,
    isRunning: false,
    isSaving: false,
    handleSave: vi.fn(),
    handleStartStop: vi.fn(),
    handleRestart: vi.fn(),
  }),
}))

vi.mock('qrcode.react', () => ({
  QRCodeSVG: () => <div data-testid="wecom-qr" />,
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open, onOpenChange }: { children: React.ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div>
        <button type="button" onClick={() => onOpenChange(false)}>close-dialog</button>
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@/lib/utils', () => ({ cn: (...args: string[]) => args.join(' '), openExternalUrl: vi.fn(), isTauri: () => false }))
vi.mock('@/lib/config/build-config', () => ({
  buildConfig: { app: { name: 'TeamClu' } },
  appDisplayName: 'TeamClu',
  appStoragePrefix: 'teamclu',
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { WeComSetupWizard } from '../Wecom'

const SECRET = 'qr-test-secret-value'

function Host({
  onSave,
  knownBotIds,
}: {
  onSave: (botId: string, secret: string) => Promise<void>
  knownBotIds?: string[]
}) {
  const [open, setOpen] = useState(true)
  return (
    <WeComSetupWizard
      open={open}
      onOpenChange={setOpen}
      onCredentialsSave={onSave}
      knownBotIds={knownBotIds}
    />
  )
}

function chooseQr() {
  fireEvent.click(screen.getByText('Next'))
  fireEvent.click(screen.getByText('QR Code Scan'))
  fireEvent.click(screen.getByText('Next'))
}

describe('WeComSetupWizard credential save', () => {
  beforeEach(() => {
    startWecomQrAuth.mockReset()
    pollWecomQrAuth.mockReset()
    startWecomQrAuth.mockResolvedValue({ scode: 'scode-1', auth_url: 'https://example.invalid/qr' })
  })

  it('saves as soon as credentials arrive, shows the bot id, and close does not save again', async () => {
    pollWecomQrAuth.mockResolvedValue({ status: 'success', botId: 'bot-123', secret: SECRET })
    const onSave = vi.fn(async () => {})
    const { container } = render(<Host onSave={onSave} />)
    chooseQr()

    expect(await screen.findByTestId('wecom-saved-bot-id')).toHaveTextContent('bot-123')
    expect(await screen.findByText('Credentials saved on this device.')).toBeTruthy()
    expect(container.textContent).not.toContain(SECRET)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith('bot-123', SECRET)

    fireEvent.click(screen.getByText('Finish Setup'))
    await waitFor(() => expect(screen.queryByTestId('wecom-saved-bot-id')).toBeNull())
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('keeps the dialog open when saving fails and retries without a second successful write', async () => {
    pollWecomQrAuth.mockResolvedValue({ status: 'success', botId: 'bot-123', secret: SECRET })
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error(`disk full ${SECRET}`))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(undefined)
    render(<Host onSave={onSave} />)
    chooseQr()

    expect(await screen.findByText(/Couldn't save credentials/)).toBeTruthy()
    expect(screen.getByTestId('wecom-saved-bot-id')).toHaveTextContent('bot-123')
    expect(screen.queryByText(SECRET)).toBeNull()

    fireEvent.click(screen.getByText('close-dialog'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(screen.getByText(/Couldn't save credentials/)).toBeTruthy()
    expect(screen.getByTestId('wecom-saved-bot-id')).toBeTruthy()

    fireEvent.click(screen.getByText('Retry save'))
    expect(await screen.findByText('Credentials saved on this device.')).toBeTruthy()
    expect(onSave).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByText('Finish Setup'))
    await waitFor(() => expect(screen.queryByTestId('wecom-saved-bot-id')).toBeNull())
  })

  it('drops a late success after the dialog is closed', async () => {
    let resolvePoll: (value: { status: string; botId?: string; secret?: string }) => void = () => {}
    pollWecomQrAuth.mockImplementation(
      () => new Promise((resolve) => {
        resolvePoll = resolve
      }),
    )
    const onSave = vi.fn(async () => {})
    render(<Host onSave={onSave} />)
    chooseQr()
    await screen.findByTestId('wecom-qr')
    await waitFor(() => expect(pollWecomQrAuth).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByText('close-dialog'))
    await waitFor(() => expect(screen.queryByTestId('wecom-qr')).toBeNull())
    resolvePoll({ status: 'success', botId: 'bot-123', secret: SECRET })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByText('bot-123')).toBeNull()
  })

  it('says a second bot was added and does not show its secret', async () => {
    pollWecomQrAuth.mockResolvedValue({ status: 'success', botId: 'bot-2', secret: SECRET })
    const onSave = vi.fn(async () => {})
    const { container } = render(<Host onSave={onSave} knownBotIds={['b1']} />)
    chooseQr()

    expect(await screen.findByTestId('wecom-scan-outcome')).toHaveTextContent(
      'Added bot-2 to this WeCom channel',
    )
    expect(screen.getByTestId('wecom-scan-outcome').textContent).toMatch(/keep their id, secret, and on\/off switch/)
    expect(container.textContent).not.toContain(SECRET)
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('bot-2', SECRET))
  })

  it('says a repeated bot id only replaces that secret', async () => {
    pollWecomQrAuth.mockResolvedValue({ status: 'success', botId: 'b1', secret: SECRET })
    const onSave = vi.fn(async () => {})
    render(<Host onSave={onSave} knownBotIds={['b1', 'b2']} />)
    chooseQr()

    expect(await screen.findByTestId('wecom-scan-outcome')).toHaveTextContent(
      'b1 is already on this WeCom channel',
    )
    expect(screen.getByTestId('wecom-scan-outcome').textContent).toMatch(/other bots stay/)
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('b1', SECRET))
  })

  it('cancel before a scan does not save', async () => {
    const onSave = vi.fn(async () => {})
    render(<Host onSave={onSave} knownBotIds={['b1']} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onSave).not.toHaveBeenCalled()
    expect(startWecomQrAuth).not.toHaveBeenCalled()
  })

  it('clears the QR and offers retry when the code expires', async () => {
    pollWecomQrAuth.mockResolvedValue({ status: 'expired' })
    render(<Host onSave={vi.fn(async () => {})} />)
    chooseQr()
    expect(await screen.findByText('QR code expired. Please try again.')).toBeTruthy()
    expect(screen.queryByTestId('wecom-qr')).toBeNull()
    expect(screen.getByText('Retry')).toBeTruthy()
    expect(screen.getByText('Switch to Manual Input')).toBeTruthy()
  })
})
