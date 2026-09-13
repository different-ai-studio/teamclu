/**
 * The setup an app session needs before its agent may run: the local daemon
 * seated in it, and the session bound to the app's checkout.
 *
 * Opening an app session used to await that setup before switching to it, so
 * every click in the app's session list sat still on daemon calls and Cloud API
 * round trips before anything on screen moved. The switch now goes first and
 * the setup follows, which leaves one thing that must still wait: starting the
 * agent. Runtime-start resolves the session's workspace, and a session whose
 * binding has not landed resolves to the desktop's current workspace instead —
 * the app's files then get written into whatever folder happens to be open.
 * This registry is how runtime-start waits for exactly the setup in flight.
 *
 * It also makes the setup happen once per session per launch. Both halves are
 * idempotent, and redoing them on every switch back and forth was most of what
 * made the list slow.
 *
 * Deliberately free of imports: runtime-start reads it, and it must not drag
 * the app-session module graph into that path.
 */

interface SetupEntry {
  appId: string
  /** Resolves true when the setup fully landed. */
  promise: Promise<boolean>
}

const entries = new Map<string, SetupEntry>()

/**
 * How long a runtime start waits on a setup before going ahead anyway. Past
 * this the setup is stuck on the network, and blocking the agent forever would
 * be worse than the wrong-directory fallback it guards against.
 */
export const APP_SESSION_SETUP_WAIT_MS = 15_000

/**
 * Run `setup` for this session unless a run is already in flight or has
 * completed. A run that resolves false (something did not land) or rejects is
 * forgotten once it settles, so the next open tries again.
 */
export function runAppSessionSetupOnce(
  appId: string,
  sessionId: string,
  setup: () => Promise<boolean>,
): Promise<void> {
  const existing = entries.get(sessionId)
  if (existing && existing.appId === appId) return existing.promise.then(() => undefined)

  const forget = () => {
    if (entries.get(sessionId)?.promise === promise) entries.delete(sessionId)
  }
  const promise = setup().then(
    (complete) => {
      if (!complete) forget()
      return complete
    },
    (error: unknown) => {
      forget()
      throw error
    },
  )
  // Registered before the first await, so a runtime start triggered by the
  // switch that follows this call already sees it.
  entries.set(sessionId, { appId, promise })
  return promise.then(() => undefined)
}

/** Mark a session whose setup already happened elsewhere (e.g. at creation). */
export function recordAppSessionSetup(appId: string, sessionId: string): void {
  entries.set(sessionId, { appId, promise: Promise.resolve(true) })
}

/**
 * Resolves once any setup started for this session has settled, or after
 * `timeoutMs`. Never rejects: a failed setup is the setup's to report, and the
 * caller only needs to know it may proceed.
 */
export async function waitForAppSessionSetup(
  sessionId: string,
  timeoutMs: number = APP_SESSION_SETUP_WAIT_MS,
): Promise<void> {
  const entry = entries.get(sessionId)
  if (!entry) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      entry.promise.catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Forget every setup recorded for an app — its checkout moved, so each
 * session's binding names a directory that is no longer there and has to be
 * redone on the next open.
 */
export function forgetAppSessionSetups(appId: string): void {
  for (const [sessionId, entry] of entries) {
    if (entry.appId === appId) entries.delete(sessionId)
  }
}
