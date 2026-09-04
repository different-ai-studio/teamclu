/**
 * Teardown contract for the `tauri://drag-*` subscription in `PromptInput`.
 *
 * The effect registers three listeners with three sequential `await listen(...)`
 * calls, so an unmount can land between any two of them. Every interleaving must
 * unlisten each registered handler exactly once:
 *
 *   - twice throws. `_unlisten` calls `unregisterListener(event, eventId)`, and
 *     the second call reaches an eventId Tauri has already dropped, so
 *     `listeners[eventId].handlerId` raises a TypeError. Nothing awaits
 *     `unlisten()`, so that surfaced as an unhandled rejection and became the
 *     largest error group in the app (TEAMCLU-REACT-7Q/99/6F, ~2.5k events).
 *   - zero times leaks: a listener registered after cleanup already ran stays
 *     attached for the lifetime of the window and fires into a dead closure.
 *
 * The mock `listen` hands out promises this file resolves by hand, which is what
 * makes each interleaving deterministic rather than a race.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import React from 'react'

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  isTauri: () => true,
}))

vi.mock('@/packages/ai/editable-with-file-chips', () => ({
  EditableWithFileChips: React.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) =>
      React.createElement('div', { ref, 'data-testid': 'editable', role: 'textbox' })
  ),
}))

vi.mock('@/packages/ai/prompt-input-ui', () => ({
  PromptInputTools: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PromptInputButton: ({ children }: React.PropsWithChildren) => React.createElement('button', null, children),
  PromptInputSubmit: ({ children }: React.PropsWithChildren) => React.createElement('button', { type: 'submit' }, children),
  PromptInputActionMenu: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PromptInputActionMenuTrigger: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PromptInputActionMenuContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PromptInputAttachment: () => null,
  createAttachmentComponents: () => ({
    PromptInputActionAddAttachments: () => null,
    PromptInputAttachments: () => null,
    PromptInputMentions: () => null,
  }),
}))

vi.mock('@/packages/ai/prompt-input-types', () => ({}))

vi.mock('@/packages/ai/prompt-input-insert-hooks', () => ({
  useInsertMentionHook: () => vi.fn(),
  useInsertFileMentionHook: () => vi.fn(),
  useInsertSkillMentionHook: () => vi.fn(),
}))

/** One pending `listen()` call: the event name plus the resolver for its promise. */
type PendingListen = {
  event: string
  resolve: (unlisten: () => void) => void
}

const pending: PendingListen[] = []

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string) =>
    new Promise<() => void>((resolve) => {
      pending.push({ event, resolve })
    }),
}))

/**
 * Per-listener unlisten call counts, keyed by event name.
 *
 * The real unlisten returns a promise; returning one here keeps the production
 * `Promise.resolve(unlisten())` path under test rather than a synchronous stub.
 */
const unlistenCalls = new Map<string, number>()

function makeUnlisten(event: string): () => void {
  unlistenCalls.set(event, 0)
  return () => {
    unlistenCalls.set(event, (unlistenCalls.get(event) ?? 0) + 1)
    return Promise.resolve() as unknown as void
  }
}

/**
 * Let the effect advance. The first `import('@tauri-apps/api/event')` settles on
 * a macrotask, so draining microtasks alone would leave the body parked before
 * the first `listen()` and every `settleNextListen` would find nothing pending.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let j = 0; j < 4; j += 1) await Promise.resolve()
  }
}

/**
 * Resolve the oldest outstanding `listen()` and let the effect body advance to
 * the next `await`. Returns the event name that was settled.
 */
async function settleNextListen(): Promise<string> {
  const next = pending.shift()
  if (!next) throw new Error('no outstanding listen() to settle')
  next.resolve(makeUnlisten(next.event))
  await flush()
  return next.event
}

let unhandled: unknown[] = []
function recordUnhandled(event: PromiseRejectionEvent) {
  event.preventDefault()
  unhandled.push(event.reason)
}

beforeEach(() => {
  pending.length = 0
  unlistenCalls.clear()
  unhandled = []
  window.addEventListener('unhandledrejection', recordUnhandled)
})

afterEach(() => {
  window.removeEventListener('unhandledrejection', recordUnhandled)
})

async function renderInput() {
  const { PromptInput } = await import('@/packages/ai/prompt-input')
  const view = render(
    React.createElement(PromptInput, { onFilesChange: () => {} }, null)
  )
  await flush()
  return view
}

describe('PromptInput tauri drag-drop teardown', () => {
  it('unlistens each registered handler exactly once when unmounted mid-registration', async () => {
    const { unmount } = await renderInput()

    // First listener registered and remembered; the effect is now parked on the
    // second `await listen(...)`. This is the window the double-unlisten needed.
    const first = await settleNextListen()
    expect(unlistenCalls.get(first)).toBe(0)

    unmount()
    await flush()
    expect(unlistenCalls.get(first)).toBe(1)

    // The in-flight second `listen` resolves after cleanup already drained.
    // Before the fix this re-drained the same array and called `first` again.
    const second = await settleNextListen()

    expect(unlistenCalls.get(first)).toBe(1)
    expect(unlistenCalls.get(second)).toBe(1)
  })

  it('unlistens a handler that resolves after cleanup instead of leaking it', async () => {
    const { unmount } = await renderInput()

    // Unmount before anything resolved: cleanup drains an empty array, so the
    // registration that lands afterwards has nothing to be collected by.
    unmount()
    await flush()

    const first = await settleNextListen()
    expect(unlistenCalls.get(first)).toBe(1)
  })

  it('unlistens all three handlers exactly once on a clean unmount', async () => {
    const { unmount } = await renderInput()

    const events = [
      await settleNextListen(),
      await settleNextListen(),
      await settleNextListen(),
    ]
    expect(events).toEqual([
      'tauri://drag-over',
      'tauri://drag-leave',
      'tauri://drag-drop',
    ])
    expect(events.map((e) => unlistenCalls.get(e))).toEqual([0, 0, 0])

    unmount()
    await flush()

    expect(events.map((e) => unlistenCalls.get(e))).toEqual([1, 1, 1])
  })

  it('does not re-register when the parent passes a fresh onFilesChange each render', async () => {
    const { PromptInput } = await import('@/packages/ai/prompt-input')
    const { rerender } = render(
      React.createElement(PromptInput, { onFilesChange: () => {} }, null)
    )
    await flush()
    await settleNextListen()
    await settleNextListen()
    await settleNextListen()
    expect(pending).toHaveLength(0)

    // A new closure identity must not tear the subscription down: the drop
    // handler reads the ref, so re-registering only churns Tauri listeners and
    // widens the teardown window this file exists to close.
    rerender(React.createElement(PromptInput, { onFilesChange: () => {} }, null))
    await flush()

    expect(pending).toHaveLength(0)
    expect([...unlistenCalls.values()]).toEqual([0, 0, 0])
  })

  it('never lets an unlisten rejection escape as an unhandled rejection', async () => {
    const { unmount } = await renderInput()
    const next = pending.shift()
    if (!next) throw new Error('no outstanding listen() to settle')
    next.resolve(() => {
      // Mirrors the real failure: `listeners[eventId].handlerId` on an eventId
      // Tauri already dropped.
      return Promise.reject(
        new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")
      ) as unknown as void
    })
    await flush()

    unmount()
    await flush()

    expect(unhandled).toEqual([])
  })
})
