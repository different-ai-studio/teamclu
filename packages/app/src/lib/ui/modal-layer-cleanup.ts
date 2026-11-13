/**
 * Radix Dialog / Sheet (via react-remove-scroll) can leave a document-level
 * wheel listener after close. The listener is owned by the overlay's Presence
 * node and drops only when that node unmounts.
 *
 * Never set `display: none` on a closing overlay. Presence is already waiting
 * for animationend / animationcancel; hiding the node before the exit
 * animation starts swallows that event and the wheel listener stays forever.
 * A closed overlay with no running animation gets a matching animationend so
 * Presence can finish. A newer schedule cancels the previous one, so a stale
 * cleanup cannot land in the same frame as the next close.
 */

const BODY_LOCK_PROPS = [
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'width',
  'height',
  'overflow',
  'pointerEvents',
  'paddingRight',
  'marginRight',
  'touchAction',
] as const

const HTML_LOCK_PROPS = ['overflow', 'paddingRight', 'marginRight'] as const

const OPEN_MODAL_SELECTOR = [
  '[data-slot="dialog-content"][data-state="open"]',
  '[data-slot="sheet-content"][data-state="open"]',
  '[data-slot="alert-dialog-content"][data-state="open"]',
].join(', ')

const OVERLAY_SELECTOR = [
  '[data-slot="dialog-overlay"]',
  '[data-slot="sheet-overlay"]',
  '[data-slot="alert-dialog-overlay"]',
].join(', ')

function clearStyleProps(el: HTMLElement, props: readonly string[]) {
  const style = el.style as CSSStyleDeclaration & Record<string, string>
  for (const prop of props) {
    style[prop] = ''
  }
}

function removeInteractivityLockClasses() {
  for (const el of document.querySelectorAll(
    '[class*="block-interactivity-"], [class*="allow-interactivity-"]',
  )) {
    for (const cls of [...el.classList]) {
      if (
        cls.startsWith('block-interactivity-') ||
        cls.startsWith('allow-interactivity-')
      ) {
        el.classList.remove(cls)
      }
    }
  }
}

function hasRunningAnimation(node: HTMLElement): boolean {
  if (typeof node.getAnimations !== 'function') return false
  return node.getAnimations().some((animation) => {
    return animation.playState === 'running' || animation.playState === 'pending'
  })
}

/** Names Presence matches with `animationName.includes(CSS.escape(event.animationName))`. */
function exitAnimationNames(node: HTMLElement): string[] {
  const raw = getComputedStyle(node).animationName
  if (!raw || raw === 'none') return []
  return raw
    .split(',')
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter((name) => name && name !== 'none')
}

/**
 * Ask Radix Presence to leave `unmountSuspended`. A synthetic animationend is
 * ignored while the exit animation is still running, so a normal close can
 * finish on its own.
 */
function createAnimationEndEvent(animationName: string): Event {
  if (typeof AnimationEvent === 'function') {
    return new AnimationEvent('animationend', { animationName })
  }
  // jsdom has no AnimationEvent. Presence only reads `event.animationName`.
  const event = new Event('animationend')
  Object.defineProperty(event, 'animationName', { value: animationName })
  return event
}

function finishClosedOverlays() {
  if (document.querySelector(OPEN_MODAL_SELECTOR)) return
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const node = el as HTMLElement
    if (node.dataset.state === 'open') continue
    if (hasRunningAnimation(node)) continue
    for (const animationName of exitAnimationNames(node)) {
      node.dispatchEvent(createAnimationEndEvent(animationName))
    }
  }
}

/** Synchronous cleanup of react-remove-scroll / Radix modal residue. */
export function releaseStuckModalLayers(): void {
  if (typeof document === 'undefined') return

  const hasOpenModal = Boolean(document.querySelector(OPEN_MODAL_SELECTOR))
  const { body, documentElement: html } = document

  // Keep scroll-lock while another dialog/sheet is still open (nested modals).
  if (!hasOpenModal) {
    clearStyleProps(body, BODY_LOCK_PROPS)
    clearStyleProps(html, HTML_LOCK_PROPS)
    body.removeAttribute('data-scroll-locked')
    removeInteractivityLockClasses()

    const root = document.getElementById('root')
    root?.removeAttribute('inert')
    root?.removeAttribute('aria-hidden')
  }

  finishClosedOverlays()
}

let outerFrame = 0
let innerFrame = 0
let releaseTimer = 0

function cancelScheduledRelease(): void {
  if (outerFrame) cancelAnimationFrame(outerFrame)
  if (innerFrame) cancelAnimationFrame(innerFrame)
  if (releaseTimer) clearTimeout(releaseTimer)
  outerFrame = 0
  innerFrame = 0
  releaseTimer = 0
}

/** Run cleanup after Radix close animation + internal teardown (dialog duration-200). */
export function scheduleReleaseStuckModalLayers(): void {
  if (typeof window === 'undefined') return
  // Drop the previous double-rAF and timeout. Otherwise a cleanup queued by
  // the last close runs in the same frame as the next close, before its exit
  // animation has started.
  cancelScheduledRelease()
  outerFrame = requestAnimationFrame(() => {
    outerFrame = 0
    innerFrame = requestAnimationFrame(() => {
      innerFrame = 0
      releaseStuckModalLayers()
    })
  })
  releaseTimer = window.setTimeout(() => {
    releaseTimer = 0
    releaseStuckModalLayers()
  }, 280)
}
