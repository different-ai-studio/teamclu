import { useEffect, useRef } from 'react'
import { isTauri } from '@/lib/utils'
import type { FileChangeBatch } from '@/hooks/use-file-change-batch-listener'

type FileChangeEvent = {
  payload: { path: string; kind: string }
}

/**
 * Listen for changed paths from the Rust file watcher, debounced, one path at
 * a time. No-op in web (non-Tauri) environments.
 *
 * The watcher emits a single `file-change-batch` per 500 ms window carrying
 * every surviving path; this hook fans that out into the per-path shape its
 * callers use. `kind` is always "any": a window is collapsed to paths, it no
 * longer carries per-event kinds.
 *
 * @param handler  Called with the last matching path after debounce
 * @param delay    Debounce delay in ms (default 500)
 * @param enabled  Whether to listen (default true) — pass false to conditionally disable
 * @param filter   Applied BEFORE the debounce; paths it rejects are ignored
 *                 entirely. It has to run first: a window holds every changed
 *                 path, and the debounce keeps only the last one — so a listener
 *                 that filtered inside its handler would lose its own path
 *                 whenever an unrelated one landed later in the same window.
 */
export function useFileChangeListener(
  handler: (event: FileChangeEvent) => void,
  delay: number = 500,
  enabled: boolean = true,
  filter?: (event: FileChangeEvent) => boolean,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    if (!enabled || !isTauri()) return

    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<FileChangeBatch>('file-change-batch', (event) => {
          let last: FileChangeEvent | undefined
          for (const path of event.payload.paths) {
            const candidate: FileChangeEvent = { payload: { path, kind: 'any' } }
            if (filterRef.current && !filterRef.current(candidate)) continue
            last = candidate
          }
          if (!last) return
          const matched = last
          clearTimeout(timer)
          timer = setTimeout(() => handlerRef.current(matched), delay)
        }),
      )
      .then((fn) => {
        // The effect may have been torn down while `listen` was in flight.
        if (disposed) fn()
        else unlisten = fn
      })
      .catch((error) => {
        console.warn('[FileChangeListener] Failed to listen:', error)
      })

    return () => {
      disposed = true
      clearTimeout(timer)
      unlisten?.()
    }
  }, [delay, enabled])
}
