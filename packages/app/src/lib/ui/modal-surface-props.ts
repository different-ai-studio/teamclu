import type * as React from 'react'

import { scheduleReleaseStuckModalLayers } from '@/lib/ui/modal-layer-cleanup'

type FocusHandler = (event: Event) => void

/** Wire into Dialog / Sheet / AlertDialog Content so every modal surface self-heals on close. */
export function modalSurfaceProps<T extends HTMLElement>(options?: {
  onCloseAutoFocus?: FocusHandler
  onAnimationEnd?: React.AnimationEventHandler<T>
}) {
  return {
    onCloseAutoFocus: (event: Event) => {
      options?.onCloseAutoFocus?.(event)
      scheduleReleaseStuckModalLayers()
    },
    onAnimationEnd: (event: React.AnimationEvent<T>) => {
      options?.onAnimationEnd?.(event)
      if (event.currentTarget.dataset.state === 'closed') {
        scheduleReleaseStuckModalLayers()
      }
    },
  }
}
