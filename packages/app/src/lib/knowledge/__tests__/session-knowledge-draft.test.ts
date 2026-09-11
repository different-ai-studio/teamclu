import { describe, expect, it } from 'vitest'
import { MessageKind } from '@/lib/proto/teamclu_pb'
import { draftFromSession, slugifyDraftTitle } from '@/lib/knowledge/session-knowledge-draft'

describe('slugifyDraftTitle', () => {
  it('keeps CJK and separates on space', () => {
    expect(slugifyDraftTitle('对账口径')).toBe('对账口径')
    expect(slugifyDraftTitle('Push 文案')).toBe('push-文案')
  })

  it('falls back when nothing remains', () => {
    expect(slugifyDraftTitle('!!!')).toBe('note')
  })
})

describe('draftFromSession', () => {
  it('skips system messages and empty bodies', () => {
    const draft = draftFromSession({
      sessionId: 's1',
      title: '对账口径',
      messages: [
        { kind: MessageKind.SYSTEM, content: 'joined', senderActorId: 'sys' },
        { kind: MessageKind.TEXT, content: '以渠道单号为准', senderActorId: 'alice' },
        { kind: MessageKind.TEXT, content: '   ', senderActorId: 'bob' },
      ],
    })
    expect(draft.title).toBe('对账口径')
    expect(draft.suggestedPath).toBe('20-domains/对账口径.md')
    expect(draft.body).toContain('alice')
    expect(draft.body).toContain('以渠道单号为准')
    expect(draft.body).not.toContain('joined')
  })

  it('asks the reviewer to write when the thread is empty', () => {
    const draft = draftFromSession({
      sessionId: 's1',
      title: '  ',
      messages: [],
    })
    expect(draft.title).toBe('untitled')
    expect(draft.body).toContain('审稿页')
  })
})
