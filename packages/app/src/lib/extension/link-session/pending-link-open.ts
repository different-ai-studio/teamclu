/** Minimal page payload shared between extension content-script and embed app. */
export type PageContextLike = {
  title: string
  url: string
  text: string
  selection: string
}

export type PendingLinkOpen = {
  page: PageContextLike
  linkKey: string
  linkUrl?: string
  linkText?: string
  source: 'link-hover'
}

export const PENDING_LINK_OPEN_KEY = 'teamclu.pendingLinkOpen'

export function isPendingLinkOpenPayload(payload: unknown): payload is PendingLinkOpen {
  if (typeof payload !== 'object' || payload === null) return false
  const row = payload as PendingLinkOpen
  return (
    typeof row.linkKey === 'string' &&
    row.source === 'link-hover' &&
    typeof row.page === 'object' &&
    row.page !== null &&
    typeof row.page.url === 'string'
  )
}
