import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditableWithFileChips } from '../editable-with-file-chips'
import { encodeMemberMentionToken } from '@/lib/actor/member-mention-token'
import { encodeSessionAttachmentToken } from '@/lib/attachments/session-attachment-token'

const originalExecCommand = document.execCommand

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
})
