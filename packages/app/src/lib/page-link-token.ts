import type { PageContext } from '@/lib/embed-page-context'

const PAGE_LINK_TOKEN_PREFIX = '@{page:b64:'
const MAX_PAGE_CHIP_LABEL = 80
function truncatePageText(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 3))}...`
}

export function sanitizePageChipLabel(label: string): string {
  return truncatePageText(label.replace(/\]/g, ''), MAX_PAGE_CHIP_LABEL)
}

export function base64urlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64urlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  const normalized = padded + '='.repeat(padLen)
  const binary = atob(normalized)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function isPageContextPayload(payload: unknown): payload is PageContext {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as PageContext
  return (
    typeof p.url === 'string' &&
    typeof p.text === 'string' &&
    typeof p.title === 'string' &&
    typeof p.selection === 'string'
  )
}

export function encodePageLinkToken(ctx: PageContext): string {
  const json = JSON.stringify(ctx)
  return `${PAGE_LINK_TOKEN_PREFIX}${base64urlEncode(json)}}`
}

export function parsePageLinkBody(body: string): PageContext | null {
  if (!body.startsWith('page:b64:')) return null
  const encoded = body.slice('page:b64:'.length)
  if (!encoded) return null
  try {
    const json = base64urlDecode(encoded)
    const parsed: unknown = JSON.parse(json)
    return isPageContextPayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parsePageLinkToken(token: string): PageContext | null {
  if (!token.startsWith('@{') || !token.endsWith('}')) return null
  const body = token.slice(2, -1)
  return parsePageLinkBody(body)
}

export function pageLinkChipLabel(ctx: PageContext): string {
  const fromSelection = ctx.selection.trim()
  if (fromSelection) return sanitizePageChipLabel(fromSelection)
  const fromText = ctx.text.trim()
  if (fromText) return sanitizePageChipLabel(fromText)
  const url = ctx.url.trim()
  if (url.length <= 48) return url
  return `${url.slice(0, 45)}...`
}

export const PAGE_LINK_TOKEN_RE = /@\{page:b64:[^}]+\}/g
