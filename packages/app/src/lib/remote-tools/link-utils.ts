const MAX_PAGE_NAV_LINKS = 8

type ParsedPageNavLinks = {
  links: string[]
  labels: string[]
}

function isAllowedNavUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true
  try {
    const u = new URL(trimmed)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function defaultLabelForLink(link: string): string {
  const trimmed = link.trim()
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) {
    return trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed
  }
  try {
    const u = new URL(trimmed, 'https://placeholder.invalid')
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const path = u.pathname === '/' ? u.hostname : `${u.hostname}${u.pathname}`
      return path.length > 32 ? `${path.slice(0, 32)}…` : path
    }
  } catch {
    // fall through
  }
  return trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed
}

function coerceLinksInput(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          return parsed
            .filter((item): item is string => typeof item === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
        }
      } catch {
        // fall through to single-url
      }
    }
    return [trimmed]
  }
  return []
}

export function parsePageNavLinksArgs(args: Record<string, unknown>): ParsedPageNavLinks {
  const links = coerceLinksInput(args.links).slice(0, MAX_PAGE_NAV_LINKS)

  if (links.length === 0) {
    throw new Error('links must contain at least one non-empty string')
  }

  for (const link of links) {
    if (!isAllowedNavUrl(link)) {
      throw new Error(`unsupported link: ${link}`)
    }
  }

  const rawLabels = args.labels
  let labels: string[] = []
  if (rawLabels !== undefined) {
    labels = coerceLinksInput(rawLabels).slice(0, links.length)
  }

  while (labels.length < links.length) {
    labels.push(defaultLabelForLink(links[labels.length]!))
  }

  return { links, labels }
}

export function parsePageNavLinksFromToolCall(
  argumentsJson: Record<string, unknown> | undefined,
  rawInput?: unknown,
): ParsedPageNavLinks | null {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    try {
      return parsePageNavLinksArgs(rawInput as Record<string, unknown>)
    } catch {
      // fall through
    }
  }
  if (!argumentsJson) return null
  try {
    return parsePageNavLinksArgs(argumentsJson)
  } catch {
    return null
  }
}
