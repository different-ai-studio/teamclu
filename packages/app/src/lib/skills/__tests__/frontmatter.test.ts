import { describe, it, expect } from 'vitest'
import { parseFrontmatter, frontmatterString } from '@/lib/skills/frontmatter'

// These fixtures are duplicated in the Rust twin's test module
// (apps/daemon/src/config/skill_frontmatter.rs). When you add a case here, add
// it there — that pairing is the only thing keeping the two implementations
// honest, and a silent divergence shows up as "the settings screen says one
// thing, the agent got another".

describe('parseFrontmatter', () => {
  it('parses plain and quoted scalars', () => {
    const src = `---
name: deploy-check
description: "a: colon inside"
owner: 'zhang san'
---
# Body
`
    const p = parseFrontmatter(src)
    expect(p.hasFrontmatter).toBe(true)
    expect(p.data.name).toBe('deploy-check')
    expect(p.data.description).toBe('a: colon inside')
    expect(p.data.owner).toBe('zhang san')
    expect(p.body).toBe('# Body\n')
  })

  it('parses a literal block preserving newlines', () => {
    const src = `---
when_not_to_use: |
  不要用于本地开发。
  也不要用于 hotfix 流程。
---
body`
    expect(parseFrontmatter(src).data.when_not_to_use).toBe(
      '不要用于本地开发。\n也不要用于 hotfix 流程。',
    )
  })

  it('parses a folded block joining lines', () => {
    const src = `---
summary: >
  one
  two
---
body`
    expect(parseFrontmatter(src).data.summary).toBe('one two')
  })

  it('ends a block at the next key', () => {
    const src = `---
when_to_use: |
  first
name: after
---
body`
    const p = parseFrontmatter(src)
    expect(p.data.when_to_use).toBe('first')
    expect(p.data.name).toBe('after')
  })

  it('parses block and inline lists', () => {
    const src = `---
requires:
  - macos
  - autoui-mcp-server
tags: [a, b]
empty: []
---
body`
    const p = parseFrontmatter(src)
    expect(p.data.requires).toEqual(['macos', 'autoui-mcp-server'])
    expect(p.data.tags).toEqual(['a', 'b'])
    expect(p.data.empty).toEqual([])
  })

  it('keeps the whole document as body when there is no frontmatter', () => {
    const src = '# Just a heading\n\ntext'
    const p = parseFrontmatter(src)
    expect(p.hasFrontmatter).toBe(false)
    expect(p.body).toBe(src)
    expect(p.data).toEqual({})
  })

  it('treats an unterminated fence as not-frontmatter', () => {
    // Otherwise the entire body gets swallowed as metadata.
    const src = '---\nname: x\n\nstill body'
    const p = parseFrontmatter(src)
    expect(p.hasFrontmatter).toBe(false)
    expect(p.body).toBe(src)
  })

  it('normalizes CRLF', () => {
    const p = parseFrontmatter('---\r\nname: x\r\n---\r\nbody\r\n')
    expect(p.data.name).toBe('x')
    expect(p.body).toBe('body\n')
  })

  it('is what the old regex could not do: a multi-line value', () => {
    // The previous parser was /^---\n[\s\S]*?name:\s*(.+?)\n[\s\S]*?---/ plus a
    // line-prefix scan, so a block scalar truncated at the first newline.
    const src = `---
name: x
when_not_to_use: |
  第一行
  第二行
---
body`
    expect(frontmatterString(src, 'when_not_to_use')).toBe('第一行\n第二行')
  })
})
