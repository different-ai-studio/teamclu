/**
 * How one value from an app's own database is shown in the data browser.
 *
 * Pure and separate from the component because the rules here are the ones
 * design §4.3 is specific about, and each exists for a reason a UI reviewer
 * cannot see from the markup:
 *
 *  - Truncation happens HERE, on the display string, and never on the server.
 *    The API returns values in full so that copying one out gives the value
 *    that is actually in the database, not a prefix of it.
 *  - `bytea` shows a size, never content: it is usually an image or a blob and
 *    rendering it as text is both useless and slow.
 *  - `timestamptz` is shown in the viewer's own timezone with the stored value
 *    kept alongside, because a naked UTC string invites someone to "correct" a
 *    row that was never wrong.
 */

export const CELL_TRUNCATE_AT = 140

type AppDataCellKind = 'null' | 'json' | 'bytes' | 'timestamp' | 'boolean' | 'text'

interface AppDataCell {
  kind: AppDataCellKind
  /** What the cell shows, already truncated. */
  display: string
  /** Full, untruncated text — for the expanded view and for copying. */
  full: string
  /** Secondary line/tooltip: the stored value a rendered one was derived from. */
  detail?: string
  truncated: boolean
}

function jsonish(dataType: string): boolean {
  return dataType === 'json' || dataType === 'jsonb'
}

function bytesish(dataType: string): boolean {
  return dataType === 'bytea'
}

function timestampish(dataType: string): boolean {
  return dataType.startsWith('timestamp') || dataType === 'date'
}

function truncate(text: string): { display: string; truncated: boolean } {
  if (text.length <= CELL_TRUNCATE_AT) return { display: text, truncated: false }
  return { display: `${text.slice(0, CELL_TRUNCATE_AT)}…`, truncated: true }
}

/** Rough byte length of a Postgres `bytea` as the driver hands it over. */
function byteLength(value: unknown): number | null {
  if (value instanceof Uint8Array) return value.byteLength
  if (Array.isArray(value)) return value.length
  if (typeof value === 'string') {
    // postgres.js renders bytea as a `\x…` hex string over JSON.
    const hex = value.startsWith('\\x') ? value.slice(2) : value
    if (/^[0-9a-f]*$/i.test(hex)) return Math.floor(hex.length / 2)
  }
  return null
}

export function formatAppDataCell(value: unknown, dataType: string): AppDataCell {
  if (value === null || value === undefined) {
    return { kind: 'null', display: 'NULL', full: 'NULL', truncated: false }
  }

  if (bytesish(dataType)) {
    const bytes = byteLength(value)
    const display = bytes === null ? 'binary' : `${bytes} bytes`
    return { kind: 'bytes', display, full: display, truncated: false }
  }

  if (jsonish(dataType) || (typeof value === 'object' && !(value instanceof Date))) {
    const full = JSON.stringify(value, null, 2) ?? String(value)
    const oneLine = JSON.stringify(value) ?? String(value)
    const { display, truncated } = truncate(oneLine)
    return { kind: 'json', display, full, truncated }
  }

  if (timestampish(dataType) && (typeof value === 'string' || value instanceof Date)) {
    const parsed = value instanceof Date ? value : new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      const local = parsed.toLocaleString()
      return {
        kind: 'timestamp',
        display: local,
        full: local,
        // The stored value, so nobody mistakes a timezone shift for bad data.
        detail: value instanceof Date ? parsed.toISOString() : value,
        truncated: false,
      }
    }
  }

  if (typeof value === 'boolean') {
    const display = value ? 'true' : 'false'
    return { kind: 'boolean', display, full: display, truncated: false }
  }

  const full = String(value)
  const { display, truncated } = truncate(full)
  return { kind: 'text', display, full, truncated }
}

/**
 * The starting text when a cell enters edit mode.
 *
 * Objects go in as formatted JSON so the field is editable; everything else as
 * its plain string. NULL becomes an empty field, which {@link parseCellInput}
 * reads back as NULL.
 */
export function cellEditValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value, null, 2)
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * Turn what was typed back into a value to send.
 *
 * Deliberately conservative: an empty field is NULL, and everything else is
 * sent as a string. Postgres casts a string to the column's type, so guessing
 * a number or a boolean here would only add a way to get it wrong — and a
 * column whose text happens to look like `123` would silently change meaning.
 */
export function parseCellInput(text: string): string | null {
  return text === '' ? null : text
}
