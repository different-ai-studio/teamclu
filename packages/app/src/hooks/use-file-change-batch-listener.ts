import { useEffect, useRef } from 'react'
import { isTauri } from '@/lib/utils'

/**
 * One debounce window of the Rust file watcher, as emitted on
 * `file-change-batch`: every surviving changed path, and the parent
 * directories whose listing may differ now. Build and dependency trees
 * (`node_modules`, `.git`, `target`, …) are already filtered out.
 */
export type FileChangeBatch = {
  paths: string[]
  directories: string[]
}

/**
 * Listen for `file-change-batch` events. No-op in web (non-Tauri) environments.
 *
 * The watcher already debounces (500 ms) and hands over the whole window at
 * once, so there is no timer here — the handler runs once per window with
 * everything in it. Pair it with `refreshChangedDirectories` to re-list only
 * what moved, instead of the root plus every expanded directory on any change.
 *
 * @param handler  Called once per batch
 * @param enabled  Whether to listen (default true)
 */
export function useFileChangeBatchListener(
  handler: (batch: FileChangeBatch) => void,
  enabled: boolean = true,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled || !isTauri()) return

    let disposed = false
    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<FileChangeBatch>('file-change-batch', (event) => {
          handlerRef.current(event.payload)
        }),
      )
      .then((fn) => {
        // The effect may have been torn down while `listen` was in flight.
        if (disposed) fn()
        else unlisten = fn
      })
      .catch((error) => {
        console.warn('[FileChangeBatch] Failed to listen:', error)
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled])
}
