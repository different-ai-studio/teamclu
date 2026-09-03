import { describe, it, expect, vi } from 'vitest'
import { encodeMemberMentionToken } from '@/lib/actor/member-mention-token'
import { createInsertHashFile, createInsertHashSessionAttachment, createInsertAgentMention, createInsertMention } from '../prompt-input-insert-hooks'
import { encodeSessionAttachmentToken } from '@/lib/attachments/session-attachment-token'

function makeContext(initialText: string, hashAt: number) {
  let text = initialText
  const setText = vi.fn((next: string) => { text = next })
  const onHashClose = vi.fn()
  const hashStartRef = { current: hashAt as number | null }
  const textareaRef = { current: null as HTMLDivElement | null }
  return {
    ctx: {
      text: () => text,
      setText,
      onHashClose,
      hashStartRef,
      textareaRef,
    },
    spies: { setText, onHashClose, hashStartRef },
  }
}

describe('createInsertHashFile', () => {
  it('replaces #query with @{path} and clears hashStartRef', () => {
    const initial = 'Hello #foo'
    const { ctx, spies } = makeContext(initial, 6)
    const insert = createInsertHashFile({
      get text() { return ctx.text() },
      setText: ctx.setText,
      onHashClose: ctx.onHashClose,
      textareaRef: ctx.textareaRef,
      hashStartRef: ctx.hashStartRef,
    } as any)
    insert('src/main.ts')
    expect(spies.setText).toHaveBeenCalledWith('Hello @{src/main.ts} ')
    expect(spies.hashStartRef.current).toBeNull()
    expect(spies.onHashClose).toHaveBeenCalledTimes(1)
  })
})

describe('createInsertHashSessionAttachment', () => {
  it('replaces #query with session attachment token', () => {
    const initial = 'Hello #log'
    const { ctx, spies } = makeContext(initial, 6)
    const attachment = {
      name: 'hiclaw-install.log',
      url: 'https://example.com/hiclaw-install.log',
      isImage: false,
    }
    const insert = createInsertHashSessionAttachment({
      get text() { return ctx.text() },
      setText: ctx.setText,
      onHashClose: ctx.onHashClose,
      textareaRef: ctx.textareaRef,
      hashStartRef: ctx.hashStartRef,
    } as any)
    insert(attachment)
    expect(spies.setText).toHaveBeenCalledWith(
      `Hello ${encodeSessionAttachmentToken(attachment)} `,
    )
    expect(spies.hashStartRef.current).toBeNull()
    expect(spies.onHashClose).toHaveBeenCalledTimes(1)
  })
})

describe('createInsertAgentMention', () => {
  it('strips @query from text without inserting anything and calls onAttachAgent', () => {
    let text = 'Hi @qu'
    const setText = vi.fn((next: string) => { text = next })
    const onMentionClose = vi.fn()
    const onAttachAgent = vi.fn()
    const mentionStartRef = { current: 3 as number | null }
    const insert = createInsertAgentMention({
      get text() { return text },
      setText,
      onMentionClose,
      mentionStartRef,
      textareaRef: { current: null },
    } as any, onAttachAgent)
    insert({ id: 'actor-1', displayName: 'Reviewer Agent' })
    expect(setText).toHaveBeenCalledWith('Hi ')
    expect(onAttachAgent).toHaveBeenCalledWith({ id: 'actor-1', displayName: 'Reviewer Agent' })
    expect(mentionStartRef.current).toBeNull()
    expect(onMentionClose).toHaveBeenCalledTimes(1)
  })
})

describe('createInsertMention', () => {
  it('replaces @query with inline member chip token', () => {
    let text = 'Hi @Hai'
    const setText = vi.fn((next: string) => { text = next })
    const onMentionClose = vi.fn()
    const mentionStartRef = { current: 3 as number | null }
    const person = { id: 'member-1', name: 'Haigang Ye' }
    const insert = createInsertMention({
      get text() { return text },
      setText,
      onMentionClose,
      mentionStartRef,
      textareaRef: { current: null },
    } as any)
    insert(person)
    expect(setText).toHaveBeenCalledWith(`Hi ${encodeMemberMentionToken(person)} `)
    expect(mentionStartRef.current).toBeNull()
    expect(onMentionClose).toHaveBeenCalledTimes(1)
  })
})
