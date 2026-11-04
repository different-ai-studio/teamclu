/**
 * Reading a failed runtime install (`amuxd install-pi`) for people.
 *
 * The error arrives as one string that can hold a whole npm tail or a Node
 * crash trace. Shown as-is it is a wall of text; reduced to its last line it
 * says nothing — a Node crash ends on `Node.js v24.20.0`, and that line alone is
 * what a fresh machine showed on 2026-11-04. These helpers pick the line that
 * names the cause, keep the rest for a details view, and assemble what a user
 * copies to us.
 */

const DESKTOP_PREFIX = 'amuxd install-pi failed: '

/** Lines that are never the cause: Node's version footer and stack frames. */
const NOISE = [/^Node\.js v\d/, /^at\s/, /^\^+$/, /^-+$/]

/**
 * Lines that usually are, most specific first: a JS error (`Error: …`,
 * `TypeError: …`, `Error [ERR_MODULE_NOT_FOUND]: …`), then npm's own summary
 * — skipping npm's `code`/`errno`/log-path bookkeeping lines.
 */
const CAUSE = [
  /^(?:\w+)?Error(?:\s*\[[A-Z0-9_]+\])?:\s*\S/,
  /^npm (?:ERR!|error) (?!code\b|errno\b|syscall\b|path\b|dest\b|A complete log\b|Log files\b|\s*$)/,
]

const HEADLINE_MAX = 240

export type InstallFailureSummary = {
  /** The one line worth showing by default. */
  headline: string
  /** The full error, when it holds more than the headline. */
  detail: string | null
}

export function summarizeInstallFailure(error: string): InstallFailureSummary {
  const text = error.trim()
  const body = text.startsWith(DESKTOP_PREFIX) ? text.slice(DESKTOP_PREFIX.length) : text
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const meaningful = lines.filter((l) => !NOISE.some((re) => re.test(l)))
  // The first line is amuxd's own summary ("pi install failed (exit status: 1):
  // <first npm line>"). Prefer a line that names the cause; it often comes
  // after npm's preamble.
  const cause = CAUSE.map((re) => meaningful.find((l) => re.test(l))).find(Boolean)
  let headline = cause ?? meaningful[0] ?? lines[0] ?? text
  if (headline.length > HEADLINE_MAX) headline = `${headline.slice(0, HEADLINE_MAX)}…`
  return { headline, detail: lines.length > 1 ? body : null }
}

/**
 * A coarse class for grouping failures in Sentry. Stable values only — these
 * become a fingerprint, so a new class splits issues and a renamed one orphans
 * them.
 */
export type InstallFailureKind =
  | 'node_download'
  | 'checksum'
  | 'node_crash'
  | 'npm_network'
  | 'npm_error'
  | 'verify'
  | 'other'

export function classifyInstallFailure(error: string): InstallFailureKind {
  if (/could not download Node\.js|did not serve SHASUMS|mirror is unavailable/i.test(error)) {
    return 'node_download'
  }
  if (/checksum mismatch/i.test(error)) return 'checksum'
  if (/\b(?:ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network request)\b/.test(error)) {
    return 'npm_network'
  }
  // Node's footer is printed after an uncaught exception — npm itself (or a
  // script it ran) crashed rather than reporting a failure.
  if (/^Node\.js v\d/m.test(error)) return 'node_crash'
  // amuxd quotes npm's first line on its own summary line, after `): `.
  if (/(?:^|\): )npm (?:ERR!|error) /m.test(error)) return 'npm_error'
  if (/install produced|reported success but|still does not report as ready/i.test(error)) {
    return 'verify'
  }
  return 'other'
}

export type InstallDiagnosticsInput = {
  error: string
  /** The install's narration, oldest first (raw progress lines). */
  output: string[]
  appVersion: string | null
  platform: string
  logPath: string
  attempts: number
}

/** How much narration goes into a copied report. */
const OUTPUT_LINES = 40

/**
 * Plain text for "Copy details": everything we would ask a user for, so one
 * paste replaces a back-and-forth. amuxd's JSON progress lines are flattened
 * to their message.
 */
export function buildInstallDiagnostics(input: InstallDiagnosticsInput): string {
  // amuxd's closing `error` event repeats `input.error`; keep it once.
  const narration = input.output
    .filter((line) => !isErrorEvent(line))
    .slice(-OUTPUT_LINES)
    .map(flattenProgressLine)
  return [
    `App: ${input.appVersion ?? 'unknown'}`,
    `Platform: ${input.platform}`,
    `Attempts: ${input.attempts}`,
    `Log: ${input.logPath}`,
    '',
    '--- error ---',
    input.error.trim(),
    ...(narration.length > 0 ? ['', `--- last ${narration.length} progress lines ---`, ...narration] : []),
  ].join('\n')
}

function isErrorEvent(line: string): boolean {
  if (!line.startsWith('{')) return false
  try {
    return (JSON.parse(line) as { event?: unknown }).event === 'error'
  } catch {
    return false
  }
}

function flattenProgressLine(line: string): string {
  try {
    const value = JSON.parse(line) as { event?: unknown; message?: unknown }
    if (typeof value.message === 'string') {
      return typeof value.event === 'string' ? `[${value.event}] ${value.message}` : value.message
    }
  } catch {
    // Not JSON: a raw stderr line, kept verbatim.
  }
  return line
}
