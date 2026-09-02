import type { Breadcrumb } from '@sentry/react'
import { redactLogString } from '@/lib/diag-redact'

export type ConsoleLevel = 'debug' | 'info' | 'log' | 'warn' | 'error'

export interface ConsoleEntry {
  ts: number
  level: ConsoleLevel
  message: string
  args: string[]
}

export interface ConsoleFilter {
  level?: ConsoleLevel | 'all'
  search?: string
  limit?: number
}

const MAX_ENTRIES = 800
const MAX_SERIALIZED_LEN = 4096

const entries: ConsoleEntry[] = []
const subscribers = new Set<() => void>()
let installed = false

function safeSerialize(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return value.stack ?? value.message
  }
  try {
    const json = JSON.stringify(value)
    if (json.length <= MAX_SERIALIZED_LEN) return json
    return `${json.slice(0, MAX_SERIALIZED_LEN)}…`
  } catch {
    const text = String(value)
    if (text.length <= MAX_SERIALIZED_LEN) return text
    return `${text.slice(0, MAX_SERIALIZED_LEN)}…`
  }
}

function pushEntry(level: ConsoleLevel, args: unknown[]): void {
  const serializedArgs = args.map((arg) => redactLogString(safeSerialize(arg)))
  const message = redactLogString(serializedArgs.join(' '))
  entries.push({ ts: Date.now(), level, message, args: serializedArgs })
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  for (const cb of subscribers) cb()
}

const MAX_REDACT_DEPTH = 4

function redactUnknown(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactLogString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_REDACT_DEPTH) return redactLogString(safeSerialize(value))
  if (value instanceof Error) return redactLogString(safeSerialize(value))
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactUnknown(item, depth + 1)
  }
  return out
}

/**
 * SEC-4: Sentry `beforeBreadcrumb` hook. The ring buffer above redacts what the
 * Diagnostics viewer shows, but Sentry's console integration captures the raw
 * `console.*` arguments on its own and ships them as breadcrumbs — every
 * bearer/JWT/`sk-` key that a log line carried went out unredacted. Runs the
 * same `redactLogString` over the message and every string in `data`
 * (console `arguments`, fetch/xhr URLs, navigation targets alike).
 */
export function redactSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const out: Breadcrumb = { ...breadcrumb }
  if (typeof out.message === 'string') out.message = redactLogString(out.message)
  if (out.data && typeof out.data === 'object') {
    out.data = redactUnknown(out.data, 0) as Breadcrumb['data']
  }
  return out
}

export function installConsoleCapture(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const levels: ConsoleLevel[] = ['debug', 'info', 'log', 'warn', 'error']
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      pushEntry(level, args)
      original(...args)
    }
  }
}

export function getConsoleEntries(filter?: ConsoleFilter): ConsoleEntry[] {
  let result = entries.slice()
  if (filter?.level && filter.level !== 'all') {
    result = result.filter((entry) => entry.level === filter.level)
  }
  if (filter?.search?.trim()) {
    const q = filter.search.trim().toLowerCase()
    result = result.filter((entry) => entry.message.toLowerCase().includes(q))
  }
  if (filter?.limit != null && filter.limit > 0) {
    result = result.slice(-filter.limit)
  }
  return result
}

export function clearConsoleCapture(): void {
  entries.length = 0
  for (const cb of subscribers) cb()
}

export function subscribeConsoleCapture(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/** Test-only reset hook. */
export function resetConsoleCaptureForTests(): void {
  installed = false
  entries.length = 0
  subscribers.clear()
}

export function formatConsoleEntry(entry: ConsoleEntry): string {
  const date = new Date(entry.ts)
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  const level = entry.level.toUpperCase().padEnd(5)
  return `${time}.${ms} ${level} ${entry.message}`
}
