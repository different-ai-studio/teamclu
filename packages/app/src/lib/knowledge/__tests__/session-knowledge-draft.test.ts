import { describe, expect, it } from 'vitest'
import { MessageKind } from '@/lib/proto/teamclu_pb'
import {
  composeKnowledgeDraft,
  compactTranscriptForDistill,
  distillFromSession,
  parseDistillPayload,
  slugifyDraftTitle,
} from '@/lib/knowledge/session-knowledge-draft'

describe('slugifyDraftTitle', () => {
  it('keeps CJK and separates on space', () => {
    expect(slugifyDraftTitle('对账口径')).toBe('对账口径')
    expect(slugifyDraftTitle('Push 文案')).toBe('push-文案')
  })

  it('falls back when nothing remains', () => {
    expect(slugifyDraftTitle('!!!')).toBe('note')
  })
})

describe('composeKnowledgeDraft', () => {
  it('groups selected suggestions under headings', () => {
    const body = composeKnowledgeDraft({
      summary: '以渠道单号为准',
      suggestions: [
        { kind: 'decision', text: '以渠道单号为准' },
        { kind: 'followup', text: '补一条 runbook' },
      ],
    })
    expect(body).toContain('## 结论')
    expect(body).toContain('## 后续')
    expect(body).toContain('补一条 runbook')
  })
})

describe('distillFromSession', () => {
  it('does not dump a long transcript into the draft body', () => {
    const wall = `背景说明。${'用户贴了一大段过程记录。'.repeat(40)}`
    const draft = distillFromSession({
      title: '对账口径',
      messages: [
        { kind: MessageKind.TEXT, content: wall, senderActorId: 'user-1', isAgent: false },
        {
          kind: MessageKind.TEXT,
          isAgent: true,
          senderActorId: 'agent-1',
          content: [
            '结论：以渠道单号为准。',
            '- 不再用支付流水号对账',
            '- 下一步补一条 runbook',
          ].join('\n'),
        },
      ],
    })
    expect(draft.body).not.toContain('用户贴了一大段过程记录')
    expect(draft.body.length).toBeLessThan(wall.length)
    expect(draft.suggestions.some((item) => item.text.includes('渠道单号'))).toBe(true)
    expect(draft.suggestions.some((item) => item.kind === 'followup')).toBe(true)
    expect(draft.suggestedPath).toBe('20-domains/对账口径.md')
  })

  it('asks the reviewer to write when the thread is empty', () => {
    const draft = distillFromSession({
      title: '  ',
      messages: [],
    })
    expect(draft.title).toBe('untitled')
    expect(draft.suggestions).toEqual([])
    expect(draft.body).toContain('没有可提炼')
  })

  it('ignores tool-call noise', () => {
    const draft = distillFromSession({
      title: '对账',
      messages: [
        { kind: MessageKind.AGENT_TOOL_CALL, content: 'bash({"cmd":"ls"})', isAgent: true },
        { kind: MessageKind.AGENT_REPLY, content: '结论：以渠道单号为准。', isAgent: true },
      ],
    })
    expect(draft.body).not.toContain('bash(')
    expect(draft.body).toContain('以渠道单号为准')
  })
})

describe('parseDistillPayload', () => {
  it('reads fenced JSON from the model', () => {
    const draft = parseDistillPayload(`\`\`\`json
{"title":"对账口径","suggestedPath":"20-domains/payments/对账口径.md","summary":"以渠道单号为准","suggestions":[{"kind":"decision","text":"以渠道单号为准"}]}
\`\`\``)
    expect(draft?.title).toBe('对账口径')
    expect(draft?.suggestedPath).toContain('payments')
    expect(draft?.suggestions).toHaveLength(1)
  })

  it('rejects a payload with no suggestions', () => {
    expect(parseDistillPayload('{"title":"x","suggestions":[]}')).toBeNull()
  })
})

describe('compactTranscriptForDistill', () => {
  it('labels speakers and drops system lines', () => {
    const text = compactTranscriptForDistill([
      { kind: MessageKind.SYSTEM, content: 'joined' },
      { kind: MessageKind.TEXT, content: 'hello', isAgent: false },
      { kind: MessageKind.TEXT, content: '结论：ok', isAgent: true },
    ])
    expect(text).toContain('user: hello')
    expect(text).toContain('agent: 结论：ok')
    expect(text).not.toContain('joined')
  })
})
