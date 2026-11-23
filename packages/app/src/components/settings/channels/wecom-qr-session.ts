import type { WeComQrAuthPollResult } from '@/stores/channels-types'

export const WECOM_QR_POLL_INTERVAL_MS = 3000
export const WECOM_QR_POLL_DEADLINE_MS = 5 * 60 * 1000
export const WECOM_QR_MAX_CONSECUTIVE_ERRORS = 3

export type WecomQrPollPhase = 'waiting' | 'scanned'

export type WecomQrPollStep =
  | { type: 'ready'; botId: string; secret: string }
  | { type: 'pending'; phase: WecomQrPollPhase }
  | { type: 'expired' }

export type WecomQrPollDone =
  | { type: 'ready'; botId: string; secret: string }
  | { type: 'expired' }
  | { type: 'timeout' }
  | { type: 'error' }
  | { type: 'aborted' }

/**
 * One poll observation. `success` is ready only when both values are
 * non-empty. Scanned / incomplete success stay pending so the loop continues.
 * The daemon normalizes `scaned` to `scanned`; the raw spelling is accepted
 * so an older daemon still means "keep waiting".
 */
export function interpretWecomQrPoll(result: WeComQrAuthPollResult | null | undefined): WecomQrPollStep {
  const status = (result?.status ?? '').trim().toLowerCase()
  const botId = (result?.botId ?? '').trim()
  const secret = (result?.secret ?? '').trim()
  if (status === 'success' && botId && secret) return { type: 'ready', botId, secret }
  if (status === 'expired') return { type: 'expired' }
  if (status === 'scanned' || status === 'scaned') return { type: 'pending', phase: 'scanned' }
  return { type: 'pending', phase: 'waiting' }
}

export function redactSaveError(err: unknown, secret: string): string {
  const raw = err instanceof Error ? err.message : ''
  if (!raw) return ''
  let text = secret ? raw.split(secret).join('[redacted]') : raw
  text = text.replace(/https?:\/\/\S+/g, '[url]')
  if (text.length > 180) text = `${text.slice(0, 180)}…`
  return text
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll one QR session sequentially. A new attempt does not start until the
 * previous one settles. Aborting — close, retry, or a newer session — drops
 * a late success so it cannot be applied after the wizard has moved on.
 */
export async function pollWecomQrUntilDone(options: {
  poll: () => Promise<WeComQrAuthPollResult>
  signal: AbortSignal
  intervalMs?: number
  deadlineMs?: number
  maxConsecutiveErrors?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  onPending?: (phase: WecomQrPollPhase) => void
}): Promise<WecomQrPollDone> {
  const interval = options.intervalMs ?? WECOM_QR_POLL_INTERVAL_MS
  const maxErrors = options.maxConsecutiveErrors ?? WECOM_QR_MAX_CONSECUTIVE_ERRORS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const deadline = now() + (options.deadlineMs ?? WECOM_QR_POLL_DEADLINE_MS)
  let errors = 0

  while (!options.signal.aborted) {
    if (now() >= deadline) return { type: 'timeout' }
    let result: WeComQrAuthPollResult
    try {
      result = await options.poll()
    } catch {
      if (options.signal.aborted) return { type: 'aborted' }
      errors += 1
      if (errors >= maxErrors) return { type: 'error' }
      await sleep(interval, options.signal)
      continue
    }
    if (options.signal.aborted) return { type: 'aborted' }
    errors = 0
    const step = interpretWecomQrPoll(result)
    if (step.type === 'ready') return step
    if (step.type === 'expired') return { type: 'expired' }
    options.onPending?.(step.phase)
    await sleep(interval, options.signal)
  }
  return { type: 'aborted' }
}
