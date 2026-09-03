/**
 * SKILL.md frontmatter — parse and serialize.
 *
 * Why a hand-written parser instead of a YAML library: the same frontmatter is
 * read by the desktop (TypeScript) and by the daemon (Rust), and the two must
 * agree exactly — a field that parses one way here and another way there means
 * the settings UI shows one thing while the agent gets another, which is
 * miserable to debug. Two different YAML engines disagree on plenty of edge
 * cases. One small format, specified once and implemented twice against shared
 * fixtures, is the cheaper guarantee.
 *
 * The Rust twin is apps/daemon/src/config/skill_frontmatter.rs. Change both.
 *
 * Supported (deliberately a subset of YAML):
 *   key: value                 plain scalar, trailing comments NOT stripped
 *   key: "value"               quoted scalar, \" and \\ unescaped
 *   key: 'value'               single-quoted, no escapes
 *   key: |                     literal block — newlines preserved
 *   key: >                     folded block — newlines become spaces
 *   key:                       list, one "- item" per line
 *     - item
 *   key: [a, b]                inline list
 *
 * Anything else is kept as a raw string rather than rejected: a skill with an
 * exotic field should still load, it just does not get structured access.
 */

type FrontmatterValue = string | string[]

interface ParsedFrontmatter {
  /** Parsed key/value pairs. Keys keep their original casing. */
  data: Record<string, FrontmatterValue>
  /** Everything after the closing `---`. */
  body: string
  /** True when the document opened with a `---` fence at all. */
  hasFrontmatter: boolean
}

const FENCE = /^---[ \t]*$/

function unquote(raw: string): string {
  const s = raw.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1)
  }
  return s
}

function indentOf(line: string): number {
  let n = 0
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++
  return n
}

/**
 * Block scalars are dedented by their own first line's indent, not by a fixed
 * amount — an editor that reindents the file must not change the value.
 */
function readBlock(lines: string[], start: number, fold: boolean): { value: string; next: number } {
  const collected: string[] = []
  let i = start
  let baseIndent: number | null = null

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      collected.push('')
      i++
      continue
    }
    const ind = indentOf(line)
    if (baseIndent === null) {
      // A block whose first line is not indented is an empty block.
      if (ind === 0) break
      baseIndent = ind
    } else if (ind < baseIndent) {
      break
    }
    collected.push(line.slice(baseIndent))
    i++
  }

  // Trailing blank lines belong to the document, not the value.
  while (collected.length && collected[collected.length - 1] === '') collected.pop()

  const value = fold
    ? collected.map(l => l.trim()).filter(Boolean).join(' ')
    : collected.join('\n')
  return { value, next: i }
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')

  if (!lines.length || !FENCE.test(lines[0] ?? '')) {
    return { data: {}, body: normalized, hasFrontmatter: false }
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      end = i
      break
    }
  }
  // An unterminated fence is a malformed file, not frontmatter. Treating the
  // whole document as frontmatter would swallow the body.
  if (end === -1) return { data: {}, body: normalized, hasFrontmatter: false }

  const data: Record<string, FrontmatterValue> = {}
  const region = lines.slice(1, end)
  let i = 0

  while (i < region.length) {
    const line = region[i]
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++
      continue
    }
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/)
    if (!match) {
      i++
      continue
    }
    const key = match[1]
    const rest = match[2].trim()

    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      const { value, next } = readBlock(region, i + 1, rest.startsWith('>'))
      data[key] = value
      i = next
      continue
    }

    if (rest === '') {
      // Either a list on following lines, or an empty value.
      const items: string[] = []
      let j = i + 1
      while (j < region.length) {
        const item = region[j].trim()
        if (!item.startsWith('- ')) break
        items.push(unquote(item.slice(2)))
        j++
      }
      if (items.length) {
        data[key] = items
        i = j
        continue
      }
      data[key] = ''
      i++
      continue
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim()
      data[key] = inner ? inner.split(',').map(part => unquote(part)) : []
      i++
      continue
    }

    data[key] = unquote(rest)
    i++
  }

  return { data, body: lines.slice(end + 1).join('\n'), hasFrontmatter: true }
}

/** Convenience: a single string field, ignoring lists. */
export function frontmatterString(
  content: string,
  key: string,
): string | undefined {
  const value = parseFrontmatter(content).data[key]
  if (typeof value === 'string') return value.trim() || undefined
  return undefined
}

function needsQuoting(value: string): boolean {
  return (
    value !== value.trim() ||
    /^[[\]{}>|*&!%@`'"]/.test(value) ||
    value.includes(': ') ||
    value.endsWith(':')
  )
}

function serializeScalar(value: string): string {
  if (value.includes('\n')) {
    const indented = value
      .split('\n')
      .map(line => (line ? `  ${line}` : ''))
      .join('\n')
    return `|\n${indented}`
  }
  if (needsQuoting(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}

/**
 * Rewrite a SKILL.md's frontmatter, preserving the body verbatim.
 *
 * Key order matters for diff noise: known keys are emitted in a fixed order,
 * unknown keys keep their original relative order after them.
 */
export function writeFrontmatter(
  content: string,
  updates: Record<string, FrontmatterValue | undefined>,
  keyOrder: string[] = [],
): string {
  const parsed = parseFrontmatter(content)
  const merged: Record<string, FrontmatterValue> = { ...parsed.data }
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }

  const ordered = [
    ...keyOrder.filter(k => k in merged),
    ...Object.keys(merged).filter(k => !keyOrder.includes(k)),
  ]

  const lines: string[] = ['---']
  for (const key of ordered) {
    const value = merged[key]
    if (Array.isArray(value)) {
      if (!value.length) {
        lines.push(`${key}: []`)
      } else {
        lines.push(`${key}:`)
        for (const item of value) lines.push(`  - ${serializeScalar(item)}`)
      }
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`)
    }
  }
  lines.push('---')

  const body = parsed.hasFrontmatter ? parsed.body : `\n${parsed.body}`
  return `${lines.join('\n')}${body.startsWith('\n') ? '' : '\n'}${body}`
}
