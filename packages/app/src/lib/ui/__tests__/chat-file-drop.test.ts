import { describe, it, expect } from 'vitest'
import { isChatInputDropTarget, isPointOverElement } from '@/lib/ui/chat-file-drop'

describe('isChatInputDropTarget', () => {
  it('returns false for null / unrelated elements', () => {
    expect(isChatInputDropTarget(null)).toBe(false)
    expect(isChatInputDropTarget(document.createElement('div'))).toBe(false)
  })

  it('returns true when the element is inside chat-input-area', () => {
    const root = document.createElement('div')
    root.setAttribute('data-testid', 'chat-input-area')
    const child = document.createElement('textarea')
    root.appendChild(child)
    document.body.appendChild(root)
    try {
      expect(isChatInputDropTarget(child)).toBe(true)
      expect(isChatInputDropTarget(root)).toBe(true)
    } finally {
      root.remove()
    }
  })
})

describe('isPointOverElement', () => {
  it('returns false when element is missing', () => {
    expect(isPointOverElement({ x: 10, y: 10 }, null)).toBe(false)
  })

  it('returns true when the point lies inside the element box', () => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 200,
        right: 150,
        bottom: 240,
        width: 50,
        height: 40,
        x: 100,
        y: 200,
        toJSON: () => ({}),
      }) as DOMRect
    expect(isPointOverElement({ x: 120, y: 220 }, el)).toBe(true)
    expect(isPointOverElement({ x: 10, y: 10 }, el)).toBe(false)
  })
})
