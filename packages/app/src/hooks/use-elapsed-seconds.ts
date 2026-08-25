import * as React from 'react'

/**
 * Seconds since `startedAt`, ticking once a second while it is set.
 *
 * For the two first-run screens that wait on something slow. Elapsed time is
 * the cheapest thing that distinguishes "working" from "hung": a spinner draws
 * the same picture either way, and on a cold Windows first run the honest
 * answer is minutes, not "a moment".
 *
 * Pass `null` to stop the tick — the hook returns 0 and holds no interval.
 */
export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (startedAt == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}
