import { describe, expect, it } from 'vitest'
import {
  CELL_TRUNCATE_AT,
  cellEditValue,
  formatAppDataCell,
  parseCellInput,
} from '../app-data-cell'
import { appDataRowKey } from '../app-data-row-key'

describe('formatAppDataCell', () => {
  it('shows NULL distinctly from an empty string', () => {
    expect(formatAppDataCell(null, 'text')).toMatchObject({ kind: 'null', display: 'NULL' })
    expect(formatAppDataCell('', 'text')).toMatchObject({ kind: 'text', display: '' })
  })

  it('folds json to one line but keeps the formatted value for expansion', () => {
    const cell = formatAppDataCell({ a: 1, b: [2, 3] }, 'jsonb')
    expect(cell.kind).toBe('json')
    expect(cell.display).toBe('{"a":1,"b":[2,3]}')
    expect(cell.full).toContain('\n')
  })

  it('shows a size for bytea, never the content', () => {
    expect(formatAppDataCell('\\x00ff10', 'bytea').display).toBe('3 bytes')
    expect(formatAppDataCell(new Uint8Array([1, 2, 3, 4]), 'bytea').display).toBe('4 bytes')
    // The point of the rule: no fragment of the blob reaches the cell.
    expect(formatAppDataCell('\\x00ff10', 'bytea').full).not.toContain('00ff10')
  })

  it('renders a timestamp locally and keeps the stored value alongside', () => {
    const cell = formatAppDataCell('2026-08-27T01:02:03.000Z', 'timestamp with time zone')
    expect(cell.kind).toBe('timestamp')
    expect(cell.detail).toBe('2026-08-27T01:02:03.000Z')
    expect(cell.display).not.toBe('2026-08-27T01:02:03.000Z')
  })

  it('leaves an unparseable timestamp as plain text rather than showing Invalid Date', () => {
    const cell = formatAppDataCell('not a date', 'timestamp with time zone')
    expect(cell.kind).toBe('text')
    expect(cell.display).toBe('not a date')
  })

  it('truncates for display only — the full value stays available to copy', () => {
    const long = 'x'.repeat(CELL_TRUNCATE_AT + 50)
    const cell = formatAppDataCell(long, 'text')
    expect(cell.truncated).toBe(true)
    expect(cell.display.length).toBe(CELL_TRUNCATE_AT + 1)
    expect(cell.full).toBe(long)
  })
})

describe('cell editing round trip', () => {
  it('treats an emptied field as NULL, not as an empty string', () => {
    expect(parseCellInput('')).toBeNull()
    expect(parseCellInput(' ')).toBe(' ')
  })

  it('sends everything else as text and lets Postgres cast it', () => {
    // Guessing a number here would change the meaning of a text column whose
    // value merely looks numeric.
    expect(parseCellInput('123')).toBe('123')
    expect(parseCellInput('true')).toBe('true')
  })

  it('opens an object as formatted JSON', () => {
    expect(cellEditValue({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(cellEditValue(null)).toBe('')
  })
})

describe('appDataRowKey', () => {
  it('encodes the key values in the order the server reported', () => {
    expect(appDataRowKey(['id'], { id: 2, title: 'x' })).toBe(
      Buffer.from('[2]').toString('base64url'),
    )
    expect(appDataRowKey(['a', 'b'], { b: 'two', a: 'one' })).toBe(
      Buffer.from('["one","two"]').toString('base64url'),
    )
  })

  it('survives a non-ASCII key value', () => {
    // btoa on the raw string would throw here; the key is user data.
    const key = appDataRowKey(['id'], { id: '订单' })
    expect(() => Buffer.from(key, 'base64url').toString('utf8')).not.toThrow()
    expect(JSON.parse(Buffer.from(key, 'base64url').toString('utf8'))).toEqual(['订单'])
  })
})
