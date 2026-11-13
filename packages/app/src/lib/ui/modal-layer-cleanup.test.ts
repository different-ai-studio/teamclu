import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  releaseStuckModalLayers,
  scheduleReleaseStuckModalLayers,
} from '@/lib/ui/modal-layer-cleanup'

describe('releaseStuckModalLayers', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    document.body.removeAttribute('data-scroll-locked')
    document.body.removeAttribute('inert')
    document.body.removeAttribute('aria-hidden')
    document.body.style.cssText = ''
    document.documentElement.style.cssText = ''
  })

  it('clears body scroll-lock and finishes a closed overlay without hiding it', () => {
    document.body.setAttribute('data-scroll-locked', '1')
    document.body.style.pointerEvents = 'none'
    document.body.style.overflow = 'hidden'

    const overlay = document.createElement('div')
    overlay.dataset.slot = 'dialog-overlay'
    overlay.dataset.state = 'closed'
    overlay.style.animationName = 'exit'
    const ended: string[] = []
    overlay.addEventListener('animationend', (event) => {
      ended.push((event as AnimationEvent).animationName)
    })
    document.body.appendChild(overlay)

    releaseStuckModalLayers()

    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)
    expect(document.body.style.pointerEvents).toBe('')
    expect(document.body.style.overflow).toBe('')
    expect(overlay.style.display).toBe('')
    expect(overlay.style.pointerEvents).toBe('')
    expect(ended).toEqual(['exit'])
  })

  it('leaves a closed overlay alone while its exit animation is running', () => {
    const overlay = document.createElement('div')
    overlay.dataset.slot = 'dialog-overlay'
    overlay.dataset.state = 'closed'
    overlay.style.animationName = 'exit'
    overlay.getAnimations = () => [{ playState: 'running' } as Animation]
    let ended = 0
    overlay.addEventListener('animationend', () => {
      ended += 1
    })
    document.body.appendChild(overlay)

    releaseStuckModalLayers()

    expect(ended).toBe(0)
    expect(overlay.style.display).toBe('')
  })

  it('clears react-remove-scroll fixed body lock and block-interactivity classes', () => {
    document.body.style.position = 'fixed'
    document.body.style.top = '-120px'
    document.body.style.width = '100%'
    document.body.style.paddingRight = '15px'

    const root = document.createElement('div')
    root.id = 'root'
    root.className = 'block-interactivity-1'
    root.setAttribute('inert', '')
    document.body.appendChild(root)

    releaseStuckModalLayers()

    expect(document.body.style.position).toBe('')
    expect(document.body.style.top).toBe('')
    expect(document.body.style.width).toBe('')
    expect(document.body.style.paddingRight).toBe('')
    expect(root.classList.contains('block-interactivity-1')).toBe(false)
    expect(root.hasAttribute('inert')).toBe(false)
  })

  it('does not hide overlays while a modal is still open', () => {
    const openContent = document.createElement('div')
    openContent.dataset.slot = 'dialog-content'
    openContent.dataset.state = 'open'

    const overlay = document.createElement('div')
    overlay.dataset.slot = 'dialog-overlay'
    overlay.dataset.state = 'open'
    overlay.style.display = 'block'

    document.body.append(openContent, overlay)

    let ended = 0
    overlay.addEventListener('animationend', () => {
      ended += 1
    })

    releaseStuckModalLayers()

    expect(overlay.style.display).toBe('block')
    expect(ended).toBe(0)
  })

  it('drops a stale cleanup so it cannot race the next close', () => {
    vi.useFakeTimers()
    try {
      const overlay = document.createElement('div')
      overlay.dataset.slot = 'dialog-overlay'
      overlay.dataset.state = 'closed'
      overlay.style.animationName = 'exit'
      let ended = 0
      overlay.addEventListener('animationend', () => {
        ended += 1
      })
      document.body.appendChild(overlay)

      scheduleReleaseStuckModalLayers()
      scheduleReleaseStuckModalLayers()
      vi.runAllTimers()

      // The surviving schedule runs twice: the double rAF and the 280ms timeout.
      expect(ended).toBe(2)
      expect(overlay.style.display).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps body scroll-lock while a nested modal is still open', () => {
    document.body.setAttribute('data-scroll-locked', '1')
    document.body.style.overflow = 'hidden'

    const openContent = document.createElement('div')
    openContent.dataset.slot = 'dialog-content'
    openContent.dataset.state = 'open'
    document.body.appendChild(openContent)

    releaseStuckModalLayers()

    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
  })
})
