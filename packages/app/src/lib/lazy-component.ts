import * as React from 'react'

/**
 * `React.lazy` for a named export.
 *
 * The codebase exports components by name, and `React.lazy` wants a module with
 * a `default`. Every lazy boundary used to hand-roll the same
 * `.then((m) => ({ default: m.X }))` adapter; this keeps the module type so a
 * renamed or removed export fails `tsc` here instead of at first render.
 *
 *     const Settings = lazyNamed(() => import('@/components/settings/Settings'), 'Settings')
 */
export function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): React.LazyExoticComponent<Extract<M[K], React.ComponentType<any>>> {
  return React.lazy(async () => ({
    default: (await load())[name] as Extract<M[K], React.ComponentType<any>>,
  }))
}
