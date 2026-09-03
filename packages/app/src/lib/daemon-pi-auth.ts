/**
 * pi provider auth over loopback HTTP — the client half of `pi /login`.
 *
 * pi keeps its credentials in one device-wide `auth.json` and its custom
 * providers in one device-wide `models.json`, and both are only reachable
 * through the pi SDK. The daemon drives that SDK (`runtime/pi_rpc/auth.rs`),
 * so every provider flow — the ChatGPT/Claude/Copilot subscription exchanges,
 * OpenRouter's PKCE, device codes, the per-provider API-key prompts — is pi's
 * own implementation rather than a reimplementation that would drift.
 *
 * # The login state machine
 *
 * `startPiLogin` returns a `loginId` immediately; it does not wait for the
 * login, because pi asks questions mid-flow ("browser or device code?", "paste
 * the code") and a browser round trip outlives any request timeout. The caller
 * then polls `pollPiLogin` until `status` leaves `running`, rendering the
 * `events` it accumulates and answering `prompt` with `respondToPiLogin`.
 *
 * `runPiLogin` wraps that loop for callers that just want callbacks.
 */

import { daemonRequest } from '@/lib/daemon-local-client'

/** pi's `AuthPrompt`, minus the `AbortSignal` the host strips. */
export type PiAuthPrompt =
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'manual_code'; message: string; placeholder?: string }
  | {
      type: 'select'
      message: string
      options: { id: string; label: string; description?: string }[]
    }

/** pi's `AuthEvent`. */
export type PiAuthEvent =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { type: 'progress'; message: string }

export type PiAuthType = 'oauth' | 'api_key'

export interface PiAuthMethod {
  authType: PiAuthType
  /** pi's display name, e.g. "Anthropic (Claude Pro/Max)". */
  name: string
  /** Selector label for the OAuth option, e.g. "Sign in with SuperGrok". */
  loginLabel?: string
  isSubscription?: boolean
  /**
   * False for ambient-only api-key providers (an AWS profile, Vertex ADC):
   * pi has no interactive setup for them, so a key field would collect a
   * credential pi never reads.
   */
  canLogin: boolean
}

/**
 * Where a configured provider's credential comes from. Only `stored` is ours
 * to remove — the rest are the user's environment or `models.json`, which is
 * why the UI does not offer "log out" for them.
 */
export type PiAuthSource =
  | 'stored'
  | 'runtime'
  | 'environment'
  | 'fallback'
  | 'models_json_key'
  | 'models_json_command'

export interface PiProvider {
  id: string
  name: string
  configured: boolean
  source?: PiAuthSource
  label?: string
  credentialType?: PiAuthType
  isSubscription: boolean
  /** Declared in `models.json` — editable and removable from the UI. */
  custom: boolean
  modelCount: number
  availableModelCount: number
  methods: PiAuthMethod[]
}

export interface PiProviderList {
  agentDir: string
  authPath: string
  modelsPath: string
  providers: PiProvider[]
}

export type PiLoginStatus = 'running' | 'succeeded' | 'failed'

export interface PiLoginSnapshot {
  provider_id: string
  status: PiLoginStatus
  events: PiAuthEvent[]
  cursor: number
  prompt: { prompt_id: string; prompt: PiAuthPrompt } | null
  error: string | null
  refresh_error: string | null
}

export interface PiRefreshResult {
  aborted: boolean
  errors: { provider: string; error: string }[]
}

/** The `providers` map from `models.json`, verbatim. */
export interface PiCustomProviders {
  path: string
  providers: Record<string, Record<string, unknown>>
}

function query(workspaceId?: string | null): string {
  return workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
})

export async function getPiProviders(workspaceId?: string | null): Promise<PiProviderList> {
  return daemonRequest<PiProviderList>(`/v1/pi/providers${query(workspaceId)}`)
}

export async function refreshPiProviders(
  providerId?: string,
  workspaceId?: string | null,
): Promise<PiRefreshResult> {
  return daemonRequest<PiRefreshResult>(
    '/v1/pi/providers/refresh',
    json({ providerId, workspaceId }),
  )
}

/** pi's `/logout`: drops the `auth.json` entry only. */
export async function logoutPiProvider(
  providerId: string,
  workspaceId?: string | null,
): Promise<void> {
  await daemonRequest(
    `/v1/pi/providers/${encodeURIComponent(providerId)}/auth${query(workspaceId)}`,
    { method: 'DELETE' },
  )
}

export async function startPiLogin(
  providerId: string,
  authType: PiAuthType,
  workspaceId?: string | null,
): Promise<string> {
  const result = await daemonRequest<{ loginId: string }>(
    '/v1/pi/logins',
    json({ providerId, authType, workspaceId }),
  )
  return result.loginId
}

export async function pollPiLogin(loginId: string, cursor: number): Promise<PiLoginSnapshot> {
  return daemonRequest<PiLoginSnapshot>(
    `/v1/pi/logins/${encodeURIComponent(loginId)}?cursor=${cursor}`,
  )
}

export async function respondToPiLogin(
  loginId: string,
  promptId: string,
  value: string | null,
  cancelled = false,
): Promise<void> {
  await daemonRequest(
    `/v1/pi/logins/${encodeURIComponent(loginId)}/respond`,
    json({ promptId, value, cancelled }),
  )
}

export async function cancelPiLogin(loginId: string): Promise<void> {
  await daemonRequest(`/v1/pi/logins/${encodeURIComponent(loginId)}/cancel`, { method: 'POST' })
}

export async function getPiCustomProviders(
  workspaceId?: string | null,
): Promise<PiCustomProviders> {
  return daemonRequest<PiCustomProviders>(`/v1/pi/custom-providers${query(workspaceId)}`)
}

export async function putPiCustomProvider(
  providerId: string,
  provider: Record<string, unknown>,
  workspaceId?: string | null,
): Promise<void> {
  await daemonRequest(`/v1/pi/custom-providers/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    body: JSON.stringify({ provider, workspaceId }),
  })
}

export async function deletePiCustomProvider(
  providerId: string,
  workspaceId?: string | null,
): Promise<void> {
  await daemonRequest(
    `/v1/pi/custom-providers/${encodeURIComponent(providerId)}${query(workspaceId)}`,
    { method: 'DELETE' },
  )
}

/** How often the login poll runs while a flow is in flight. */
const POLL_INTERVAL_MS = 400

/**
 * Consecutive poll failures tolerated before a login is called lost.
 *
 * One failure is not fatal — the daemon restarting mid-login, or a request
 * landing while the connection is being re-exchanged, both recover. A run of
 * them means the flow is gone, and the UI must stop spinning.
 */
const MAX_POLL_FAILURES = 5

export interface PiLoginCallbacks {
  onEvent(event: PiAuthEvent): void
  /**
   * Resolve with the user's answer, or `null` to cancel the login.
   *
   * `signal` aborts when pi withdraws the prompt — the normal end of the
   * "paste your code" box once pi's own loopback callback server has caught
   * the redirect. A UI that ignores it leaves a dead input on screen.
   */
  onPrompt(prompt: PiAuthPrompt, signal: AbortSignal): Promise<string | null>
}

export interface PiLoginOutcome {
  status: PiLoginStatus
  error: string | null
  /** Login succeeded, but its model catalog could not be reloaded. */
  refreshError: string | null
}

/**
 * Drive a login to completion: poll, surface events, answer prompts.
 *
 * `abort` cancels the flow in the daemon as well as locally, so a dialog the
 * user closes does not leave pi waiting on an answer that will never come.
 */
export async function runPiLogin(
  providerId: string,
  authType: PiAuthType,
  callbacks: PiLoginCallbacks,
  options: { workspaceId?: string | null; abort?: AbortSignal } = {},
): Promise<PiLoginOutcome> {
  const loginId = await startPiLogin(providerId, authType, options.workspaceId)
  let cursor = 0
  let failures = 0
  /** Prompt ids already handed to the UI, so a re-poll does not re-ask. */
  let answering: string | null = null
  let promptAbort: AbortController | null = null

  const cancelRemote = () => {
    void cancelPiLogin(loginId).catch(() => {})
  }
  options.abort?.addEventListener('abort', cancelRemote, { once: true })

  try {
    for (;;) {
      if (options.abort?.aborted) return { status: 'failed', error: null, refreshError: null }

      let snapshot: PiLoginSnapshot
      try {
        snapshot = await pollPiLogin(loginId, cursor)
        failures = 0
      } catch (err) {
        if (++failures >= MAX_POLL_FAILURES) {
          return {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
            refreshError: null,
          }
        }
        await sleep(POLL_INTERVAL_MS)
        continue
      }

      cursor = snapshot.cursor
      for (const event of snapshot.events) callbacks.onEvent(event)

      // pi withdrew the prompt we are showing (its callback server won the
      // race). Tell the UI to take it down; the flow carries on.
      if (answering && snapshot.prompt?.prompt_id !== answering) {
        promptAbort?.abort()
        promptAbort = null
        answering = null
      }

      if (snapshot.status !== 'running') {
        promptAbort?.abort()
        return {
          status: snapshot.status,
          error: snapshot.error,
          refreshError: snapshot.refresh_error,
        }
      }

      const pending: PiLoginSnapshot['prompt'] = snapshot.prompt
      if (pending && answering !== pending.prompt_id) {
        answering = pending.prompt_id
        const controller = new AbortController()
        promptAbort = controller
        // Not awaited: the poll must keep running while the user types, or a
        // prompt pi withdraws mid-answer would never be noticed.
        void (async () => {
          let answer: string | null
          try {
            answer = await callbacks.onPrompt(pending.prompt, controller.signal)
          } catch {
            // A dialog that throws is treated as a refusal, which cancels the
            // login rather than leaving pi waiting.
            answer = null
          }
          if (controller.signal.aborted) return
          try {
            await respondToPiLogin(loginId, pending.prompt_id, answer, answer === null)
          } catch {
            // Superseded or already finished — the next poll reports the truth.
          }
        })()
      }

      await sleep(POLL_INTERVAL_MS)
    }
  } finally {
    options.abort?.removeEventListener('abort', cancelRemote)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
