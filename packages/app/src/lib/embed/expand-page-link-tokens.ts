import { formatPageContext, type PageContext } from '@/lib/embed/embed-page-context'
import {
  PAGE_LINK_TOKEN_RE,
  base64urlDecode,
  base64urlEncode,
  pageLinkChipLabel,
  parsePageLinkToken,
  sanitizePageChipLabel,
} from '@/lib/embed/page-link-token'

const PAGE_INSTRUCTION_B64_PREFIX = 'b64:'

function parseUrlSegment(segment: string): string | undefined {
  if (!segment.startsWith('url:')) return undefined
  const url = segment.slice('url:'.length).trim()
  return url || undefined
}

/** Structured send format — label + plain url for the agent, full page context in b64 instruction. */
export function buildPageLinkChip(ctx: PageContext): string {
  const label = pageLinkChipLabel(ctx)
  const url = ctx.url.trim()
  const instruction = formatPageContext(ctx)
  const urlPart = url ? `|url:${url}` : ''
  return `[Page: ${label}${urlPart}|instruction:${PAGE_INSTRUCTION_B64_PREFIX}${base64urlEncode(instruction)}]`
}

export function expandPageLinkTokensInText(text: string): string {
  return text.replace(PAGE_LINK_TOKEN_RE, (token) => {
    const ctx = parsePageLinkToken(token)
    return ctx ? buildPageLinkChip(ctx) : token
  })
}

function extractUrlFromPageInstruction(instruction: string): string | undefined {
  for (const line of instruction.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed
    }
  }
  return undefined
}

/** Parse a sent `[Page: label|url:…|instruction:b64:…]` chip body (inside brackets). */
export function parseSentPageChip(raw: string): {
  label: string
  instruction: string
  url?: string
} {
  const trimmed = raw.trim()
  const segments = trimmed.split('|')
  let label = segments[0]?.trim() ?? ''
  let explicitUrl: string | undefined
  let instructionPart = ''

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] ?? ''
    const url = parseUrlSegment(segment)
    if (url) {
      explicitUrl = url
      continue
    }
    if (segment.startsWith('instruction:')) {
      instructionPart = segment.slice('instruction:'.length)
    }
  }

  // Legacy: label|instruction:b64:… (no url segment)
  if (!instructionPart && trimmed.includes('|instruction:')) {
    const sep = trimmed.indexOf('|instruction:')
    label = trimmed.slice(0, sep).trim()
    instructionPart = trimmed.slice(sep + '|instruction:'.length)
  }

  let instruction = instructionPart
  if (instructionPart.startsWith(PAGE_INSTRUCTION_B64_PREFIX)) {
    try {
      instruction = base64urlDecode(instructionPart.slice(PAGE_INSTRUCTION_B64_PREFIX.length))
    } catch {
      instruction = ''
    }
  }

  return {
    label: sanitizePageChipLabel(label),
    instruction,
    url: explicitUrl ?? extractUrlFromPageInstruction(instruction),
  }
}
