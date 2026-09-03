import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UserMessageWithMentions } from '../UserMessageWithMentions'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/attachments/download-remote-attachment', () => ({
  openOrDownloadRemoteAttachment: vi.fn(async () => 'downloaded' as const),
}))

vi.mock('@/lib/attachments/attachment-download-index', () => ({
  normalizeAttachmentUrlKey: (url: string) => url.split('?')[0],
  getCachedAttachmentPath: () => null,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  isTauri: () => false,
}))

vi.mock('@/packages/ai/message', () => ({
  ClickableImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img src={src} alt={alt ?? 'image'} />
  ),
  LocalImage: () => null,
  resolveImagePath: (path: string) => path,
}))

vi.mock('@/packages/ai/chip-labels', () => ({
  getTrailingPathLabel: (path: string) => path.split('/').filter(Boolean).pop() ?? path,
}))

describe('UserMessageWithMentions', () => {
  it('renders role markers as role chips', () => {
    render(<UserMessageWithMentions content="[Role: accounting-dimensions]" />)

    expect(screen.getByText('accounting-dimensions')).toBeTruthy()
  })

  it('hides role activation helper text while keeping the role chip visible', () => {
    render(
      <UserMessageWithMentions content={'[Role: apcc-issue-operator]\n\nFirst tool call: role_load({ name: "apcc-issue-operator" }).'} />,
    )

    expect(screen.getByText('apcc-issue-operator')).toBeTruthy()
    expect(screen.queryByText(/First tool call: role_load/)).toBeNull()
  })

  it('renders enhanced role chips without exposing hidden tool metadata', () => {
    render(
      <UserMessageWithMentions content={'[Role: apcc-issue-operator|instruction:You must call role_load({ name: "apcc-issue-operator" }) before any other action.]'} />,
    )

    expect(screen.getByText('apcc-issue-operator')).toBeTruthy()
    expect(screen.queryByText(/role_load/)).toBeNull()
  })

  it('renders enhanced skill chips without exposing hidden tool metadata', () => {
    render(
      <UserMessageWithMentions content={'[Skill: session-distiller|instruction:You must call skill({ name: "session-distiller" }) before any other action.] 把我的输入原样返回给我'} />,
    )

    expect(screen.getByText('session-distiller')).toBeTruthy()
    expect(screen.queryByText(/First tool call/)).toBeNull()
    expect(screen.queryByText(/skill\(\{/)).toBeNull()
    expect(screen.getByText('把我的输入原样返回给我')).toBeTruthy()
  })

  it('renders unified slash role tokens as role chips', () => {
    render(<UserMessageWithMentions content="/{role:apcc-issue-operator}" />)

    expect(screen.getByText('apcc-issue-operator')).toBeTruthy()
  })

  it('renders uploaded image attachments from (url: ...) markers', () => {
    render(
      <UserMessageWithMentions content="[Image: screenshot.png] (url: https://cdn.example.test/screenshot.png)" />,
    )

    expect(screen.queryByText(/\(url:/)).toBeNull()
    expect(document.querySelector('img[src="https://cdn.example.test/screenshot.png"]')).toBeTruthy()
  })

  it('lays out multiple image attachments in a horizontal row', () => {
    render(
      <UserMessageWithMentions
        content={
          '[Image: a.png] (url: https://cdn.example.test/a.png)\n\n[Image: b.png] (url: https://cdn.example.test/b.png)'
        }
      />,
    )

    const row = screen.getByTestId('user-message-image-row')
    expect(row.className).toContain('flex')
    expect(row.querySelectorAll('img')).toHaveLength(2)
  })

  it('hides broken image url markers without rendering raw undefined text', () => {
    render(<UserMessageWithMentions content="[Image: screenshot.png] (url: undefined)" />)

    expect(screen.queryByText(/\(url:/)).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('renders non-image attachment url markers as download buttons', () => {
    render(
      <UserMessageWithMentions content="[Attachment: report.pdf] (url: https://cdn.example.test/report.pdf)" />,
    )

    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('title', 'Download attachment')
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders agent mentions as a header instead of inline chips', () => {
    render(
      <UserMessageWithMentions
        content={
          '[Mentioned agents: MACPRO]\n\n[Mentioned: Haigang Ye|instruction: 这条信息还提及了人类 Haigang Ye] 45678'
        }
      />,
    )

    expect(screen.getByTestId('agent-mention-header')).toBeTruthy()
    expect(screen.getByText('AGENT')).toBeTruthy()
    expect(screen.getByText('@MACPRO')).toBeTruthy()
    expect(screen.queryByText('@MACPRO', { selector: '.inline-flex' })).toBeNull()
    expect(screen.getByText('Haigang Ye')).toBeTruthy()
    expect(screen.getByText('45678')).toBeTruthy()
    const humanMention = screen.getByText('Haigang Ye').parentElement
    expect(humanMention?.className).toContain('min-h-[22px]')
    expect(humanMention?.className).not.toContain('border')
    expect(screen.getByText('@', { selector: '.text-faint' })).toBeTruthy()
  })

  it('renders page-link tokens as inline chips', async () => {
    const { encodePageLinkToken } = await import('@/lib/embed/page-link-token')
    const token = encodePageLinkToken({
      title: 'Example',
      url: 'https://example.com/page',
      text: 'body',
      selection: 'SeaBank-6901',
    })

    render(<UserMessageWithMentions content={`Please review ${token}`} />)

    expect(screen.getByText('SeaBank-6901')).toBeTruthy()
    expect(screen.getByText('Please review')).toBeTruthy()
  })

  it('renders sent Page chips without exposing hidden instruction', async () => {
    const { buildPageLinkChip } = await import('@/lib/embed/expand-page-link-tokens')
    const chip = buildPageLinkChip({
      title: 'Pending Approval Request',
      url: 'https://example.com/req',
      text: 'full page body with [bracket]',
      selection: 'Pending Approval Request',
    })

    render(<UserMessageWithMentions content={`${chip} please check`} />)

    expect(screen.getByText('Pending Approval Request')).toBeTruthy()
    expect(screen.getByText('please check')).toBeTruthy()
    expect(screen.queryByText(/full page body/)).toBeNull()
    expect(screen.queryByText(/https:\/\/example.com\/req/)).toBeNull()
    expect(screen.queryByText(/\[bracket\]/)).toBeNull()
  })
})
