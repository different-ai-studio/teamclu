import { useSessionStore } from './session-store'
import { appShortName } from '@/lib/config/build-config'

if (import.meta.env.DEV) {
  ;(window as any)[`__${appShortName.toUpperCase()}_STORES__`] = {
    session: useSessionStore,
  }

  // Set up execute-js event listener for tauri-plugin-mcp socket automation.
  //
  // The plugin's `emit_and_wait` wraps the code as
  // `{ _payload: <code>, _correlationId: <uuid> }` and listens on
  // `execute-js-response-<correlationId>`. Reading `payload.code` and replying
  // on the bare event name — what this did before — meant `eval(undefined)`
  // and a response nobody was listening for, so every execute_js and
  // query_page call timed out.
  Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/webviewWindow'),
  ]).then(([{ emit }, { getCurrentWebviewWindow }]) => {
    const currentWindow = getCurrentWebviewWindow()
    const stringify = (v: unknown): string => {
      if (v === undefined) return 'undefined'
      if (v === null) return 'null'
      if (typeof v !== 'object') return String(v)
      try {
        return JSON.stringify(v)
      } catch {
        // Circular / non-serializable
        return String(v)
      }
    }
    currentWindow.listen('execute-js', async (event: any) => {
      const payload = event.payload
      const wrapped = typeof payload === 'object' && payload !== null
      const code = wrapped && payload._payload !== undefined
        ? payload._payload
        : wrapped
          ? payload.code
          : payload
      const correlationId = wrapped && typeof payload._correlationId === 'string'
        ? payload._correlationId
        : null
      const respond = (data: unknown) =>
        emit(correlationId ? `execute-js-response-${correlationId}` : 'execute-js-response', data)
      try {
        // Await thenables so a promise result comes back resolved rather than
        // serializing a pending Promise as "{}".
        let result = (0, eval)(code)
        if (result && typeof result.then === 'function') result = await result
        await respond({ result: stringify(result), type: result === null ? 'null' : typeof result })
      } catch (error) {
        await respond({ result: null, type: 'error', error: String(error) })
      }
    })
    console.log('[dev-expose] execute-js listener installed')
  }).catch(() => {})
}
