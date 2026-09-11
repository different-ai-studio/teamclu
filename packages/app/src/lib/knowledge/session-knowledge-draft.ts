import { MessageKind } from '@/lib/proto/teamclu_pb'

const MAX_BODY_CHARS = 8000
const MAX_TITLE_CHARS = 48

export type SessionDraftMessage = {
  content?: string
  kind?: number
  senderActorId?: string
}

export type SessionKnowledgeDraft = {
  title: string
  body: string
  suggestedPath: string
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

/**
 * A reviewable draft from the messages already on screen.
 *
 * This is not the model summary — it is the raw material the reviewer edits
 * before publish. The header button uses it so "整理到知识库" works without
 * waiting for an agent turn.
 */
export function draftFromSession(input: {
  sessionId: string
  title: string
  messages: SessionDraftMessage[]
}): SessionKnowledgeDraft {
  const title = input.title.trim() || 'untitled'
  const lines: string[] = []
  for (const message of input.messages) {
    if (message.kind === MessageKind.SYSTEM) continue
    const text = (message.content ?? '').trim()
    if (!text) continue
    const who = (message.senderActorId ?? '').trim() || 'unknown'
    lines.push(`### ${who}\n\n${text}`)
  }
  let body = lines.join('\n\n')
  if (!body) {
    body = '（会话里还没有可整理的正文。请在审稿页写下结论。）'
  }
  if (body.length > MAX_BODY_CHARS) {
    body = `${body.slice(0, MAX_BODY_CHARS)}\n\n…`
  }
  return {
    title,
    body,
    suggestedPath: `20-domains/${slugifyDraftTitle(title)}.md`,
  }
}
