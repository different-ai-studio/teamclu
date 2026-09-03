/**
 * Radix Dialog / Sheet (via react-remove-scroll) can leave scroll-lock residue
 * after close — especially in the Chrome extension side panel. Symptoms: chat
 * message list no longer scrolls, clicks feel dead. Idempotent; safe to call
 * after any modal closes.
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

function hideOrphanedOverlays() {
  if (document.querySelector(OPEN_MODAL_SELECTOR)) return
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const node = el as HTMLElement
    node.style.pointerEvents = 'none'
    node.style.display = 'none'
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

  hideOrphanedOverlays()
}

/** Run cleanup after Radix close animation + internal teardown (dialog duration-200). */
export function scheduleReleaseStuckModalLayers(): void {
  if (typeof window === 'undefined') return
  const run = () => releaseStuckModalLayers()
  requestAnimationFrame(() => requestAnimationFrame(run))
  window.setTimeout(run, 280)
}
