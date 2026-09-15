import type { KnowledgeSuggestion, KnowledgeSuggestionKind } from '@/lib/knowledge/inbox-types'
import { MessageKind } from '@/lib/proto/teamclu_pb'

const MAX_TITLE_CHARS = 48
const MAX_SUGGESTIONS = 8
const MAX_SUGGESTION_CHARS = 160
const MAX_SUMMARY_CHARS = 80
const SHORT_NOTE_CHARS = 160

export type SessionDraftMessage = {
  content?: string
  kind?: number
  senderActorId?: string
  isAgent?: boolean
}

export type SessionKnowledgeDraft = {
  title: string
  body: string
  suggestedPath: string
  summary: string
  suggestions: KnowledgeSuggestion[]
}

const KIND_HEADING: Record<KnowledgeSuggestionKind, string> = {
  decision: '结论',
  fact: '要点',
  followup: '后续',
}

/** Filename slug: keep letters of any script, collapse the rest to `-`. */
export function slugifyDraftTitle(title: string): string {
  let out = ''
  for (const c of title) {
    if (/\p{L}|\p{N}/u.test(c)) out += c.toLowerCase()
    else if (out && !out.endsWith('-')) out += '-'
  }
  const trimmed = out.replace(/^-+|-+$/g, '').slice(0, MAX_TITLE_CHARS).replace(/-+$/g, '')
  return trimmed || 'note'
}

export function composeKnowledgeDraft(input: {
  summary: string
  suggestions: Array<Pick<KnowledgeSuggestion, 'kind' | 'text'>>
}): string {
  const summary = input.summary.trim()
  const groups: Record<KnowledgeSuggestionKind, string[]> = {
    decision: [],
    fact: [],
    followup: [],
  }
  for (const item of input.suggestions) {
    const text = item.text.trim()
    if (!text) continue
    groups[item.kind].push(text)
  }
  const parts: string[] = []
  if (summary) parts.push(summary)
  for (const kind of ['decision', 'fact', 'followup'] as const) {
    if (groups[kind].length === 0) continue
    parts.push(`## ${KIND_HEADING[kind]}\n\n${groups[kind].map((line) => `- ${line}`).join('\n')}`)
  }
  return parts.join('\n\n').trim()
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max).trim()}…`
}

function suggestionId(kind: KnowledgeSuggestionKind, text: string, index: number): string {
  return `${kind}-${index}-${slugifyDraftTitle(text).slice(0, 16)}`
}

function pushUnique(
  out: KnowledgeSuggestion[],
  seen: Set<string>,
  kind: KnowledgeSuggestionKind,
  raw: string,
): void {
  const text = clip(raw, MAX_SUGGESTION_CHARS)
  if (text.length < 4) return
  const key = text.replace(/[。．.!?！？]$/u, '')
  if (seen.has(key)) return
  seen.add(key)
  out.push({ id: suggestionId(kind, text, out.length), kind, text })
}

const CUE_DECISION = /(结论|决定|决策|口径|约定|就按|不再|改为)/
const CUE_FOLLOWUP = /(下一步|后续|待办|还要|接下来|建议先)/
const CUE_ANY = /(结论|决定|决策|建议|下一步|后续|口径|约定)/

function kindFromCue(text: string): KnowledgeSuggestionKind {
  if (CUE_FOLLOWUP.test(text)) return 'followup'
  if (CUE_DECISION.test(text)) return 'decision'
  return 'fact'
}

/** Pull list items, headings, and cue sentences — never the whole blob. */
export function extractSuggestionsFromText(text: string): KnowledgeSuggestion[] {
  const out: KnowledgeSuggestion[] = []
  const seen = new Set<string>()
  const lines = text.split(/\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const heading = trimmed.match(/^#{1,3}\s+(.+)$/)
    if (heading) {
      pushUnique(out, seen, 'fact', heading[1])
      if (out.length >= MAX_SUGGESTIONS) return out
      continue
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/) ?? trimmed.match(/^\d+[.)]\s+(.+)$/)
    if (bullet) {
      pushUnique(out, seen, kindFromCue(bullet[1]), bullet[1])
      if (out.length >= MAX_SUGGESTIONS) return out
    }
  }
  const sentences = text.split(/(?<=[。！？\n])/)
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (!trimmed || trimmed.length < 6) continue
    if (!CUE_ANY.test(trimmed)) continue
    pushUnique(out, seen, kindFromCue(trimmed), trimmed)
    if (out.length >= MAX_SUGGESTIONS) return out
  }
  return out
}

function isDraftableKind(kind?: number): boolean {
  if (kind == null) return true
  return kind === MessageKind.TEXT || kind === MessageKind.AGENT_REPLY
}

function sourceMessages(messages: SessionDraftMessage[]): SessionDraftMessage[] {
  const usable = messages.filter((message) => {
    if (!isDraftableKind(message.kind)) return false
    return Boolean((message.content ?? '').trim())
  })
  const agents = usable.filter(
    (message) => message.isAgent || message.kind === MessageKind.AGENT_REPLY,
  )
  return agents.length > 0 ? agents : usable
}

export function composeKnowledgeDraftFromSelection(
  summary: string,
  suggestions: Array<Pick<KnowledgeSuggestion, 'id' | 'kind' | 'text'>>,
  selectedIds: ReadonlySet<string>,
): string {
  return composeKnowledgeDraft({
    summary,
    suggestions: suggestions.filter((item) => selectedIds.has(item.id)),
  })
}

/**
 * Distill a thread into reviewable suggestions. Long messages are mined for
 * bullets and cue sentences; they are never copied in full.
 */
export function distillFromSession(input: {
  title: string
  messages: SessionDraftMessage[]
}): SessionKnowledgeDraft {
  const suggestions: KnowledgeSuggestion[] = []
  const seen = new Set<string>()
  for (const message of sourceMessages(input.messages)) {
    const text = (message.content ?? '').trim()
    if (text.length <= SHORT_NOTE_CHARS) {
      pushUnique(suggestions, seen, kindFromCue(text), text)
    } else {
      for (const item of extractSuggestionsFromText(text)) {
        pushUnique(suggestions, seen, item.kind, item.text)
      }
    }
    if (suggestions.length >= MAX_SUGGESTIONS) break
  }

  const title = input.title.trim() || suggestions[0]?.text.slice(0, MAX_TITLE_CHARS) || 'untitled'
  const summary = clip(
    suggestions.find((item) => item.kind === 'decision')?.text ?? suggestions[0]?.text ?? '',
    MAX_SUMMARY_CHARS,
  )
  const body = composeKnowledgeDraft({ summary, suggestions })
  return {
    title: title.trim() || 'untitled',
    body:
      body ||
      '（会话里没有可提炼的结论。请勾选或改写建议后再写入。）',
    suggestedPath: `20-domains/${slugifyDraftTitle(title)}.md`,
    summary,
    suggestions,
  }
}

export function parseDistillPayload(raw: string): SessionKnowledgeDraft | null {
  const trimmed = raw.trim()
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as {
    title?: unknown
    suggestedPath?: unknown
    summary?: unknown
    suggestions?: unknown
  }
  const suggestions: KnowledgeSuggestion[] = []
  const seen = new Set<string>()
  if (Array.isArray(row.suggestions)) {
    for (const item of row.suggestions) {
      if (!item || typeof item !== 'object') continue
      const rec = item as { kind?: unknown; text?: unknown }
      const text = typeof rec.text === 'string' ? rec.text : ''
      const kind: KnowledgeSuggestionKind =
        rec.kind === 'decision' || rec.kind === 'followup' || rec.kind === 'fact'
          ? rec.kind
          : 'fact'
      pushUnique(suggestions, seen, kind, text)
      if (suggestions.length >= MAX_SUGGESTIONS) break
    }
  }
  if (suggestions.length === 0) return null
  const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : suggestions[0].text
  const summary =
    typeof row.summary === 'string' && row.summary.trim()
      ? clip(row.summary, MAX_SUMMARY_CHARS)
      : clip(suggestions[0].text, MAX_SUMMARY_CHARS)
  const suggestedPath =
    typeof row.suggestedPath === 'string' && row.suggestedPath.trim()
      ? row.suggestedPath.trim()
      : `20-domains/${slugifyDraftTitle(title)}.md`
  return {
    title,
    summary,
    suggestions,
    suggestedPath,
    body: composeKnowledgeDraft({ summary, suggestions }),
  }
}

export function compactTranscriptForDistill(messages: SessionDraftMessage[], maxChars = 6000): string {
  const lines: string[] = []
  for (const message of messages) {
    if (!isDraftableKind(message.kind)) continue
    const text = (message.content ?? '').trim()
    if (!text) continue
    const who = message.isAgent || message.kind === MessageKind.AGENT_REPLY ? 'agent' : 'user'
    lines.push(`${who}: ${clip(text, 400)}`)
  }
  const joined = lines.join('\n')
  if (joined.length <= maxChars) return joined
  return joined.slice(joined.length - maxChars)
}
