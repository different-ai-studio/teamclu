import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { getTeamJoinLink, putTeamJoinLink, revokeTeamJoinLink } = vi.hoisted(() => ({
  getTeamJoinLink: vi.fn(),
  putTeamJoinLink: vi.fn(),
  revokeTeamJoinLink: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ teams: { getTeamJoinLink, putTeamJoinLink, revokeTeamJoinLink } }),
}))

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, size }: { value: string; size: number }) => (
    <svg data-testid="join-link-qr" data-value={value} data-size={size} />
  ),
}))

const { TeamJoinLinkSection } = await import('../TeamJoinLinkSection')

const ACTIVE = {
  token: 'tok-1',
  url: 'https://api.example.test/join/tok-1',
  expiresAt: '2026-10-17T00:00:00Z',
  maxUses: null as number | null,
  useCount: 2,
  status: 'active',
  createdAt: '2026-10-10T00:00:00Z',
}

describe('TeamJoinLinkSection', () => {
  beforeEach(() => {
    getTeamJoinLink.mockReset()
    putTeamJoinLink.mockReset()
    revokeTeamJoinLink.mockReset()
  })

  it('does not put until the admin generates a link', async () => {
    getTeamJoinLink.mockRejectedValueOnce(Object.assign(new Error('missing'), { status: 404 }))
    render(<TeamJoinLinkSection teamId="team-1" />)
    expect(putTeamJoinLink).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '生成链接' }))
    await waitFor(() => expect(putTeamJoinLink).toHaveBeenCalledWith('team-1', {
      ttl: '7d', maxUses: null, rotate: false,
    }))
  })

  it('shows the share url, qr, use count, and status for an existing link', async () => {
    getTeamJoinLink.mockResolvedValueOnce(ACTIVE)
    render(<TeamJoinLinkSection teamId="team-1" />)
    expect(await screen.findByDisplayValue(ACTIVE.url)).toBeInTheDocument()
    const qr = screen.getByTestId('join-link-qr')
    expect(qr).toHaveAttribute('data-value', ACTIVE.url)
    expect(qr).toHaveAttribute('data-size', '128')
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '作废' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '换一条新链接' })).toBeInTheDocument()
  })

  it('revokes then returns to the empty state', async () => {
    getTeamJoinLink.mockResolvedValueOnce(ACTIVE)
    revokeTeamJoinLink.mockResolvedValueOnce(undefined)
    render(<TeamJoinLinkSection teamId="team-1" />)
    fireEvent.click(await screen.findByRole('button', { name: '作废' }))
    await waitFor(() => expect(revokeTeamJoinLink).toHaveBeenCalledWith('team-1'))
    expect(await screen.findByRole('button', { name: '生成链接' })).toBeInTheDocument()
  })

  it('rotates with the selected ttl and cap', async () => {
    getTeamJoinLink.mockResolvedValueOnce(ACTIVE)
    putTeamJoinLink.mockImplementation(async (_teamId, input: { ttl: string; maxUses: number | null; rotate: boolean }) => ({
      ...ACTIVE,
      token: input.rotate ? 'tok-2' : ACTIVE.token,
      url: input.rotate ? 'https://api.example.test/join/tok-2' : ACTIVE.url,
      maxUses: input.maxUses,
    }))
    render(<TeamJoinLinkSection teamId="team-1" />)
    await screen.findByDisplayValue(ACTIVE.url)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30d' } })
    await waitFor(() => expect(putTeamJoinLink).toHaveBeenCalledWith('team-1', {
      ttl: '30d', maxUses: null, rotate: false,
    }))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } })
    await waitFor(() => expect(putTeamJoinLink).toHaveBeenCalledWith('team-1', {
      ttl: '30d', maxUses: 5, rotate: false,
    }))
    fireEvent.click(screen.getByRole('button', { name: '换一条新链接' }))
    await waitFor(() => expect(putTeamJoinLink).toHaveBeenCalledWith('team-1', {
      ttl: '30d', maxUses: 5, rotate: true,
    }))
  })

  it('keeps an expired or exhausted link on screen', async () => {
    getTeamJoinLink.mockResolvedValueOnce({ ...ACTIVE, status: 'expired' })
    render(<TeamJoinLinkSection teamId="team-1" />)
    expect(await screen.findByDisplayValue(ACTIVE.url)).toBeInTheDocument()
    expect(screen.getByText('expired')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '作废' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '换一条新链接' })).toBeInTheDocument()
  })

  it('calls onUpgradeRequired when put throws upgrade_required', async () => {
    getTeamJoinLink.mockRejectedValueOnce(Object.assign(new Error('missing'), { status: 404 }))
    putTeamJoinLink.mockRejectedValueOnce(Object.assign(new Error('upgrade'), { code: 'upgrade_required' }))
    const onUpgradeRequired = vi.fn()
    render(<TeamJoinLinkSection teamId="team-1" onUpgradeRequired={onUpgradeRequired} />)
    fireEvent.click(await screen.findByRole('button', { name: '生成链接' }))
    await waitFor(() => expect(onUpgradeRequired).toHaveBeenCalled())
  })
})
