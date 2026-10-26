import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EditableWithFileChips } from '../editable-with-file-chips'
import { encodeMemberMentionToken } from '@/lib/actor/member-mention-token'
import { encodeSessionAttachmentToken } from '@/lib/attachments/session-attachment-token'

const originalExecCommand = document.execCommand
let historyClock = 0

beforeEach(() => {
  historyClock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => historyClock)
})

afterEach(() => {
  document.execCommand = originalExecCommand
  vi.restoreAllMocks()
})

function TestHarness({ initialValue }: { initialValue: string }) {
  const [value, setValue] = React.useState(initialValue)

  return (
    <div>
      <EditableWithFileChips value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </div>
  )
}

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange()
  const selection = window.getSelection()
  range.selectNodeContents(element)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

describe('EditableWithFileChips', () => {
  it('deletes member mention chips with Backspace like skill chips', async () => {
    const person = { id: 'member-1', name: 'Haigang Ye' }
    const token = encodeMemberMentionToken(person)
    render(<TestHarness initialValue={`${token} `} />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    expect(editable).toBeTruthy()
    expect(editable.querySelector('.member-chip')).toBeTruthy()
    const memberChip = editable.querySelector('.member-chip') as HTMLElement
    expect(memberChip.className).toContain('composer-chip')
    expect(memberChip.querySelector('.composer-chip-remove-slot')).toBeTruthy()
    expect(memberChip.querySelector('[data-action="remove"]')).toBeTruthy()

    placeCaretAtEnd(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
      expect(editable.querySelector('.member-chip')).toBeNull()
    })
  })

  it('deletes adjacent chips with one Backspace per chip from the end', async () => {
    render(
      <TestHarness initialValue="/{role:apcc-issue-operator} /{skill:verification-before-completion} /{command:review} " />,
    )

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    expect(editable).toBeTruthy()

    placeCaretAtEnd(editable)

    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe(
        '/{role:apcc-issue-operator} /{skill:verification-before-completion} ',
      )
    })

    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('/{role:apcc-issue-operator} ')
    })

    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
    })
  })

  it('serializes Chromium native trailing line-break placeholder as one newline', async () => {
    render(<TestHarness initialValue="" />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    editable.append(
      document.createTextNode('hello'),
      document.createTextNode('\n'),
      document.createTextNode('\n'),
    )
    fireEvent.input(editable)

    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('hello\n')
    })
  })

  it('keeps an existing single text-node trailing newline', async () => {
    render(<TestHarness initialValue={'hello\n'} />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    expect(editable.childNodes).toHaveLength(1)
    fireEvent.input(editable)

    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('hello\n')
    })
  })

  it('does not block native line-break beforeinput events', () => {
    render(<TestHarness initialValue="hello" />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: '\n',
      inputType: 'insertLineBreak',
    })

    editable.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  it('uses the browser line-break command for Shift+Enter', async () => {
    document.execCommand = vi.fn((command: string) => command === 'insertLineBreak') as typeof document.execCommand

    render(<TestHarness initialValue="hello" />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    placeCaretAtEnd(editable)
    fireEvent.keyDown(editable, { key: 'Enter', shiftKey: true })

    expect(document.execCommand).toHaveBeenCalledWith('insertLineBreak')
  })

  it('renders page-link chip with remove control and round-trips token', async () => {
    const ctx = {
      title: 'Admin',
      url: 'https://admin.example.com/item',
      text: 'page body',
      selection: 'SeaBank-6901',
    }
    const { encodePageLinkToken } = await import('@/lib/embed/page-link-token')
    const token = encodePageLinkToken(ctx)
    render(<TestHarness initialValue={`${token} `} />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    const chip = editable.querySelector('.page-link-chip') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.textContent).toContain('SeaBank-6901')
    expect(chip.querySelector('[data-action="remove"]')).toBeTruthy()

    placeCaretAtEnd(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
    })
  })

  it('renders session attachment tokens as dashed inline chips', async () => {
    const attachment = {
      name: 'hiclaw-install.log',
      url: 'https://example.com/hiclaw-install.log',
      isImage: false,
    }
    const token = encodeSessionAttachmentToken(attachment)
    render(<TestHarness initialValue={`${token} `} />)

    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    const chip = editable.querySelector('.session-attachment-chip') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.className).toContain('border-dashed')
    expect(chip.textContent).toContain('hiclaw-install.log')
    expect(chip.textContent).toContain('#')
    expect(screen.getByTestId('value').textContent).toBe(`${token} `)
  })

  it('undoes typing one burst at a time and leaves the earlier burst', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement

    insertText(editable, 'Hello')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('Hello')
    })

    now += 600
    insertText(editable, ' there')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('Hello there')
    })

    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('Hello')
      expect(caretOffset(editable)).toBe('Hello'.length)
    })

    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
    })
  })

  it('undoes an earlier burst when the second keystroke never sent beforeinput', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement

    typeWithoutBeforeInput(editable, '12312')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('12312')
    })
    now += 600
    typeWithoutBeforeInput(editable, '阿城萨克')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('12312阿城萨克')
    })

    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('12312')
    })
    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
    })
  })

  it('keeps undoing earlier bursts after an input echo and leaves the caret at the cut', async () => {
    let now = 5_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement

    typeWithoutBeforeInput(editable, '12312')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('12312'))
    now += 600
    typeWithoutBeforeInput(editable, '阿城萨克')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('12312阿城萨克'))
    now += 600
    typeWithoutBeforeInput(editable, '啊实打实')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('12312阿城萨克啊实打实'))

    pressUndo(editable)
    fireEvent.input(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('12312阿城萨克')
      expect(caretOffset(editable)).toBe('12312阿城萨克'.length)
    })

    pressUndo(editable)
    fireEvent.input(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('12312')
      expect(caretOffset(editable)).toBe('12312'.length)
    })

    pressUndo(editable)
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe(''))

    historyClock += 1000
    fireEvent.keyDown(editable, { key: 'z', metaKey: true, shiftKey: true })
    fireEvent.keyUp(editable, { key: 'z', metaKey: true, shiftKey: true })
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('12312'))
    historyClock += 1000
    fireEvent.keyDown(editable, { key: 'z', metaKey: true, shiftKey: true })
    fireEvent.keyUp(editable, { key: 'z', metaKey: true, shiftKey: true })
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('12312阿城萨克'))
  })

  it('undoes every burst after the browser puts the removed text back', async () => {
    let now = 8_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    const bursts = ['12312', '阿城萨克', '啊实打实', '第四段', '第五段']
    let typed = ''
    for (const burst of bursts) {
      insertText(editable, burst)
      typed += burst
      await waitFor(() => expect(screen.getByTestId('value').textContent).toBe(typed))
      now += 600
    }

    for (let left = bursts.length - 1; left >= 0; left--) {
      const expected = bursts.slice(0, left).join('')
      const visible = screen.getByTestId('value').textContent ?? ''
      pressUndo(editable)
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      })
      // WebKit applies its own undo after ours and fires input with the text we just removed.
      editable.textContent = visible
      fireEvent.input(editable)
      await waitFor(() => {
        expect(screen.getByTestId('value').textContent).toBe(expected)
        expect(editable.textContent).toBe(expected)
        expect(caretOffset(editable)).toBe(expected.length)
      })
    }
  })

  it('still accepts typing after undo when the keystroke sends no beforeinput', async () => {
    let now = 9_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    typeWithoutBeforeInput(editable, '12312')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('12312'))
    now += 600
    typeWithoutBeforeInput(editable, '阿城萨克')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('12312阿城萨克'))

    pressUndo(editable)
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    fireEvent.keyDown(editable, { key: 'a' })
    typeWithoutBeforeInput(editable, '呀')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('12312呀')
    })
    pressUndo(editable)
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('12312'))
  })

  it('undoes when the IME delivers Cmd+Z as Process/KeyZ instead of z', async () => {
    let now = 11_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    insertText(editable, '则是你简单阿萨德')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('则是你简单阿萨德'))
    now += 600
    insertText(editable, '按时吃克拉斯吃了玛拉萨充满了')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('则是你简单阿萨德按时吃克拉斯吃了玛拉萨充满了')
    })

    editable.dispatchEvent(imeUndoKey('keydown'))
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('则是你简单阿萨德')
    })
    editable.dispatchEvent(imeUndoKey('keyup'))
    expect(screen.getByTestId('value').textContent).toBe('则是你简单阿萨德')

    editable.dispatchEvent(imeUndoKey('keyup'))
    expect(screen.getByTestId('value').textContent).toBe('则是你简单阿萨德')

    historyClock += 1000
    editable.dispatchEvent(imeUndoKey('keydown'))
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe(''))
  })

  it('undoes one segment when Cmd+Z is delivered twice before keyup', async () => {
    let now = 30_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    insertText(editable, '第一段')
    now += 600
    insertText(editable, '第二段')
    now += 600
    insertText(editable, '第三段')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一段第二段第三段'))

    editable.dispatchEvent(imeUndoKey('keydown'))
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
    })
    editable.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }))
    const historyUndo = new InputEvent('beforeinput', { bubbles: true, cancelable: true })
    Object.defineProperty(historyUndo, 'inputType', { value: 'historyUndo' })
    editable.dispatchEvent(historyUndo)

    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一段第二段'))
    fireEvent.keyUp(editable, { key: 'z', code: 'KeyZ', metaKey: true })
    expect(screen.getByTestId('value').textContent).toBe('第一段第二段')
  })

  it('one tap removes only the last segment when another undo arrives right after keyup', async () => {
    let now = 50_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    insertText(editable, '第一组输入')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一组输入'))
    now += 800
    insertText(editable, '第二组输入')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一组输入第二组输入'))
    now += 800
    insertText(editable, '第三组输入')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一组输入第二组输入第三组输入'))

    fireEvent.keyDown(editable, { key: 'z', metaKey: true })
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一组输入第二组输入'))
    fireEvent.keyUp(editable, { key: 'z', metaKey: true })
    fireEvent.keyUp(editable, { key: 'z', code: 'KeyZ', metaKey: true })
    editable.dispatchEvent(imeUndoKey('keydown'))
    editable.dispatchEvent(imeUndoKey('keyup'))
    const historyUndo = new InputEvent('beforeinput', { bubbles: true, cancelable: true })
    Object.defineProperty(historyUndo, 'inputType', { value: 'historyUndo' })
    editable.dispatchEvent(historyUndo)
    editable.textContent = '第一组输入'
    fireEvent.input(editable)

    expect(screen.getByTestId('value').textContent).toBe('第一组输入第二组输入')
    expect(editable.textContent).toBe('第一组输入第二组输入')

    historyClock += 1000
    fireEvent.keyDown(editable, { key: 'z', metaKey: true })
    fireEvent.keyUp(editable, { key: 'z', metaKey: true })
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一组输入'))
  })

  it('keeps the first undo to one phrase when phrases are close and the browser then deletes another', async () => {
    let now = 40_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement

    const commit = (text: string) => {
      fireEvent.compositionStart(editable)
      editable.textContent = text
      fireEvent.input(editable)
      fireEvent.compositionEnd(editable)
      fireEvent.input(editable)
    }
    commit('第一段')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一段'))
    now += 200
    commit('第一段第二段')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一段第二段'))
    now += 200
    commit('第一段第二段第三段')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一段第二段第三段'))

    pressUndo(editable)
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
    })
    editable.textContent = '第一段'
    fireEvent.input(editable)

    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('第一段第二段'))
    expect(editable.textContent).toBe('第一段第二段')
  })

  it('undoes a committed phrase without restoring the pinyin', async () => {
    let now = 20_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement

    insertText(editable, '控制变量, ')
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('控制变量, '))
    now += 800

    fireEvent.compositionStart(editable)
    editable.textContent = "控制变量, nl"
    fireEvent.input(editable)
    now += 800
    editable.textContent = "控制变量, nl'you'b"
    fireEvent.input(editable)
    fireEvent.compositionEnd(editable)
    editable.textContent = '控制变量, 牛油'
    fireEvent.input(editable)

    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('控制变量, 牛油'))
    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('控制变量, ')
      expect(caretOffset(editable)).toBe('控制变量, '.length)
    })
    pressUndo(editable)
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe(''))
  })

  it('keeps characters typed in one burst on a single undo step', async () => {
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    insertText(editable, 'He')
    insertText(editable, 'llo')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('Hello')
    })

    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
    })
  })

  it('undoes an inserted @ chip back to the query and keeps the sentence', async () => {
    render(<ChipHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'insert' }))
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    await waitFor(() => {
      expect(editable.querySelector('.file-chip')).toBeTruthy()
      expect(screen.getByTestId('value').textContent).toBe('Hi @{src/a.ts} ')
    })

    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('Hi @qu')
      expect(editable.querySelector('.file-chip')).toBeNull()
    })

    pressUndo(editable)
    expect(screen.getByTestId('value').textContent).toBe('Hi @qu')
  })

  it('undoes backspace deletion of a chip', async () => {
    const person = { id: 'member-1', name: 'Haigang Ye' }
    const token = encodeMemberMentionToken(person)
    render(<TestHarness initialValue={`${token} `} />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    placeCaretAtEnd(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
    })

    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe(`${token} `)
      expect(editable.querySelector('.member-chip')).toBeTruthy()
    })
  })

  it('redoes an undone burst', async () => {
    render(<TestHarness initialValue="" />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    insertText(editable, 'Hello')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('Hello')
    })
    pressUndo(editable)
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('')
    })
    historyClock += 1000
    fireEvent.keyDown(editable, { key: 'z', metaKey: true, shiftKey: true })
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('Hello')
    })
  })

  it('drops undo history when the draft scope changes', async () => {
    render(<ScopeHarness />)
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    insertText(editable, 'Hello')
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('Hello')
    })
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))
    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('next')
    })
    pressUndo(editable)
    expect(screen.getByTestId('value').textContent).toBe('next')
  })
})

function typeWithoutBeforeInput(editable: HTMLElement, text: string) {
  const last = editable.lastChild
  if (last?.nodeType === Node.TEXT_NODE) last.textContent = `${last.textContent ?? ''}${text}`
  else editable.appendChild(document.createTextNode(text))
  fireEvent.input(editable)
}

function insertText(editable: HTMLElement, text: string) {
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: text,
  })
  Object.defineProperty(event, 'inputType', { value: 'insertText' })
  editable.dispatchEvent(event)
  const last = editable.lastChild
  if (last?.nodeType === Node.TEXT_NODE) last.textContent = `${last.textContent ?? ''}${text}`
  else editable.appendChild(document.createTextNode(text))
  fireEvent.input(editable)
}

function pressUndo(editable: HTMLElement) {
  historyClock += 1000
  fireEvent.keyDown(editable, { key: 'z', metaKey: true })
  fireEvent.keyUp(editable, { key: 'z', metaKey: true })
}

function imeUndoKey(type: 'keydown' | 'keyup') {
  const event = new KeyboardEvent(type, {
    key: 'Process',
    code: 'KeyZ',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, 'keyCode', { value: 229 })
  Object.defineProperty(event, 'altKey', { value: true })
  return event
}

function caretOffset(editable: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return -1
  const range = selection.getRangeAt(0)
  const before = range.cloneRange()
  before.selectNodeContents(editable)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

function ChipHarness() {
  const [value, setValue] = React.useState('Hi @qu')
  return (
    <div>
      <button type="button" onClick={() => setValue('Hi @{src/a.ts} ')}>insert</button>
      <EditableWithFileChips value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </div>
  )
}

function ScopeHarness() {
  const [scope, setScope] = React.useState('a')
  const [value, setValue] = React.useState('')
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setScope('b')
          setValue('next')
        }}
      >
        switch
      </button>
      <EditableWithFileChips undoScope={scope} value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </div>
  )
}
