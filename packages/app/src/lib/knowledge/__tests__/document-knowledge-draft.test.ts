import { describe, expect, it } from 'vitest'
import { distillFromDocument } from '@/lib/knowledge/document-knowledge-draft'

describe('distillFromDocument', () => {
  it('extracts bullets from a markdown note and does not copy the wall of prose', () => {
    const wall = `背景说明。${'这篇资料里贴了一大段过程记录。'.repeat(40)}`
    const draft = distillFromDocument({
      fileName: '对账口径.md',
      documentPath: 'documents/finance/对账口径.md',
      content: [
        wall,
        '',
        '## 结论',
        '- 以渠道单号为准',
        '- 下一步补一条 runbook',
      ].join('\n'),
    })
    expect(draft.title).toBe('对账口径')
    expect(draft.body).not.toContain('这篇资料里贴了一大段过程记录')
    expect(draft.body.length).toBeLessThan(wall.length)
    expect(draft.suggestions.some((item) => item.text.includes('渠道单号'))).toBe(true)
    expect(draft.suggestions.some((item) => item.text.includes('documents/finance/对账口径.md'))).toBe(
      true,
    )
    expect(draft.suggestedPath).toBe('20-domains/对账口径.md')
  })

  it('stubs a binary file as a pointer back to 资料库, without inventing body text', () => {
    const draft = distillFromDocument({
      fileName: '合同.pdf',
      documentPath: 'documents/hr/合同.pdf',
      content: null,
    })
    expect(draft.title).toBe('合同')
    expect(draft.body).toContain('documents/hr/合同.pdf')
    expect(draft.body).not.toContain('%PDF')
    expect(draft.suggestions.some((item) => item.kind === 'followup')).toBe(true)
    expect(draft.suggestedPath).toBe('20-domains/合同.md')
  })
})
