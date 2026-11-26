import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { OrgSsoStatus } from '@/lib/backend/cloud-api/org-sso'

const t = (k: string, d?: string, opts?: Record<string, unknown>) => {
  const base = typeof d === 'string' ? d : k
  return base.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'zh-CN', changeLanguage: vi.fn() } }),
}))

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr">{value}</div>,
}))

const BOUND: OrgSsoStatus = {
  configured: true,
  binding: { tenantId: 'wwCorp', tenantName: '示例公司', createdAt: '2026-11-26T00:00:00Z' },
  directoryConfigured: true,
  directory: null,
}

const status = vi.fn(async (): Promise<OrgSsoStatus> => BOUND)
const directoryAuthLink = vi.fn(async () => ({ qrcodeUrl: 'https://open.work.weixin.qq.com/qr/abc', expiresAt: '2026-12-06T00:00:00Z' }))
const syncDirectory = vi.fn(async () => ({
  directory: { namesGranted: true, lastCheckedAt: null, lastError: null, createdAt: '2026-11-27T00:00:00Z' },
  updated: 3,
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    orgSso: { status, installUrl: vi.fn(), disconnect: vi.fn(), directoryAuthLink, syncDirectory },
  }),
}))

const { EnterpriseSsoCard } = await import('../EnterpriseSsoCard')

beforeEach(() => {
  status.mockReset()
  status.mockResolvedValue(BOUND)
  directoryAuthLink.mockClear()
  syncDirectory.mockClear()
})

describe('EnterpriseSsoCard member names', () => {
  it('shows the authorization QR on request', async () => {
    render(<EnterpriseSsoCard teamId="t1" />)
    fireEvent.click(await screen.findByRole('button', { name: '获取成员姓名' }))
    expect(await screen.findByTestId('qr')).toHaveTextContent('https://open.work.weixin.qq.com/qr/abc')
    expect(directoryAuthLink).toHaveBeenCalledWith('t1')
  })

  it('explains a grant that is not active yet, and re-checks on demand', async () => {
    status.mockResolvedValue({
      ...BOUND,
      directory: { namesGranted: false, lastCheckedAt: null, lastError: '「姓名」权限未授予', createdAt: '2026-11-27T00:00:00Z' },
    })
    render(<EnterpriseSsoCard teamId="t1" />)
    expect(await screen.findByText(/已授权，尚未生效/)).toBeInTheDocument()
    expect(screen.getByText('「姓名」权限未授予')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    await waitFor(() => expect(syncDirectory).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText('已同步，更新了 3 位成员的姓名。')).toBeInTheDocument()
  })

  it('stays out of the way when names are not configured', async () => {
    status.mockResolvedValue({ ...BOUND, directoryConfigured: false })
    render(<EnterpriseSsoCard teamId="t1" />)
    await screen.findByText(/已连接 示例公司/)
    expect(screen.queryByTestId('enterprise-sso-names')).toBeNull()
  })
})
